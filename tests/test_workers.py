import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/workers.py"
FAKE = ROOT / "tests/fake_codex.py"


class IntegrationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="pw-test-")
        self.repo = Path(self.tmp.name) / "repository with spaces"
        self.repo.mkdir()
        self.git("init", "-q")
        self.git("config", "user.email", "test@example.invalid")
        self.git("config", "user.name", "Test Fixture")
        (self.repo / "base.txt").write_text("baseline\n")
        self.git("add", ".")
        self.git("commit", "-qm", "baseline")
        self.workers = []

    def tearDown(self):
        for ident in self.workers:
            self.run_cli("stop", ident, check=False)
        # Controllers need a moment to release lock files before temporary removal.
        time.sleep(0.15)
        self.tmp.cleanup()

    def git(self, *args, cwd=None, check=True):
        return subprocess.run(["git", "-C", str(cwd or self.repo), *args],
                              capture_output=True, text=True, check=check)

    def run_cli(self, command, *args, check=True):
        p = subprocess.run([sys.executable, str(SCRIPT), command, "--repo", str(self.repo), *args],
                           capture_output=True, text=True, timeout=45)
        if check and p.returncode:
            self.fail(f"{command}: {p.returncode}\n{p.stdout}\n{p.stderr}")
        return p

    def start(self, ident, prompt):
        self.workers.append(ident)
        return json.loads(self.run_cli("start", ident, "--codex", str(FAKE), "--prompt", prompt).stdout)

    def state(self, ident):
        return json.loads(self.run_cli("status", ident).stdout)[0]

    def wait(self, ident):
        return self.run_cli("wait", ident, "--timeout", "5")

    def test_parallel_workers_steering_followup_and_merge(self):
        a = self.start("alpha", "SLOW\nMAKE alpha.txt original")
        b = self.start("beta", "SLOW\nMAKE beta.txt second")
        self.assertNotEqual(a["thread_id"], b["thread_id"])
        self.assertNotEqual(a["app_server_pid"], b["app_server_pid"])
        self.assertNotEqual(a["worktree"], b["worktree"])
        self.assertFalse((self.repo / "alpha.txt").exists())
        result = json.loads(self.run_cli("message", "alpha", "--prompt", "MAKE steered.txt accepted").stdout)
        self.assertEqual(result["action"], "steered")
        self.wait("alpha")
        followup = json.loads(self.run_cli("message", "alpha", "--prompt", "MAKE followup.txt same-thread").stdout)
        self.assertEqual(followup["thread_id"], a["thread_id"])
        self.assertEqual(followup["action"], "started")
        self.wait("alpha")
        self.wait("beta")
        # Retry only a lock-contention error while the stopped controller exits.
        for ident in ["alpha", "beta"]:
            self.run_cli("merge", ident)
        for name in ["alpha.txt", "beta.txt", "steered.txt", "followup.txt"]:
            self.assertTrue((self.repo / name).exists(), name)
        for ident in ["alpha", "beta"]:
            self.run_cli("cleanup", ident)
        self.assertEqual(self.git("status", "--porcelain").stdout, "")

    def test_approval_waits_for_explicit_decision(self):
        self.start("approval", "APPROVE\nMAKE approved.txt yes")
        p = self.run_cli("wait", "approval", "--timeout", "2", check=False)
        self.assertEqual(p.returncode, 3)
        state = self.state("approval")
        self.assertEqual(len(state["pending_requests"]), 1)
        self.assertFalse((Path(state["worktree"]) / "approved.txt").exists())
        self.run_cli("respond", "approval", "900", "--decision", "accept")
        self.wait("approval")
        self.assertEqual(self.state("approval")["status"], "completed")

    def test_reject_approval_reports_failed(self):
        self.start("denial", "APPROVE")
        self.run_cli("respond", "denial", "900", "--decision", "decline")
        p = self.run_cli("wait", "denial", "--timeout", "2", check=False)
        self.assertEqual(p.returncode, 1)

    def test_dirty_parent_start_is_rejected(self):
        (self.repo / "user.txt").write_text("preserve")
        p = self.run_cli("start", "dirty", "--codex", str(FAKE), "--prompt", "task", check=False)
        self.assertNotEqual(p.returncode, 0)
        self.assertEqual((self.repo / "user.txt").read_text(), "preserve")

    def test_dirty_worker_merge_and_cleanup_are_rejected(self):
        state = self.start("dirtyworker", "MAKE task.txt committed")
        self.wait("dirtyworker")
        tree = Path(state["worktree"])
        (tree / "not-committed.txt").write_text("keep this")
        p = self.run_cli("merge", "dirtyworker", check=False)
        self.assertNotEqual(p.returncode, 0)
        p = self.run_cli("cleanup", "dirtyworker", check=False)
        self.assertNotEqual(p.returncode, 0)
        self.assertEqual((tree / "not-committed.txt").read_text(), "keep this")

    def test_cleanup_rejects_unmerged_commit(self):
        state = self.start("unmerged", "MAKE task.txt keep")
        self.wait("unmerged")
        p = self.run_cli("cleanup", "unmerged", check=False)
        self.assertNotEqual(p.returncode, 0)
        self.assertTrue(Path(state["worktree"]).exists())

    def test_worker_id_and_duplicate_guard(self):
        p = self.run_cli("start", "../bad", "--codex", str(FAKE), "--prompt", "task", check=False)
        self.assertNotEqual(p.returncode, 0)
        state = self.start("unique", "SLOW")
        p = self.run_cli("start", "unique", "--codex", str(FAKE), "--prompt", "task", check=False)
        self.assertNotEqual(p.returncode, 0)
        self.assertEqual(self.state("unique")["thread_id"], state["thread_id"])

    def test_fast_completion_is_not_overwritten(self):
        self.start("fast", "FAST\nMAKE fast.txt yes")
        self.wait("fast")
        self.assertEqual(self.state("fast")["status"], "completed")

    def test_wait_timeout_and_stop(self):
        self.start("slow", "SLOW")
        p = self.run_cli("wait", "slow", "--timeout", "0", check=False)
        self.assertEqual(p.returncode, 2)
        self.run_cli("stop", "slow")
        time.sleep(0.1)
        self.assertEqual(self.state("slow")["status"], "interrupted")

    def test_crash_is_not_success(self):
        self.workers.append("crash")
        p = self.run_cli("start", "crash", "--codex", str(FAKE), "--prompt", "CRASH", check=False)
        self.assertNotEqual(p.returncode, 0)
        p = self.run_cli("wait", "crash", "--timeout", "0", check=False)
        self.assertEqual(p.returncode, 1)

    def test_merge_conflict_is_preserved(self):
        state = self.start("conflict", "MAKE base.txt worker")
        self.wait("conflict")
        (self.repo / "base.txt").write_text("parent\n")
        self.git("add", "base.txt")
        self.git("commit", "-qm", "parent change")
        p = self.run_cli("merge", "conflict", check=False)
        self.assertNotEqual(p.returncode, 0)
        self.assertTrue(self.git("diff", "--name-only", "--diff-filter=U").stdout.strip())
        self.assertTrue(Path(state["worktree"]).exists())
        self.git("merge", "--abort")
        self.assertEqual((self.repo / "base.txt").read_text(), "parent\n")

    def test_doctor_probe_has_no_worker(self):
        p = self.run_cli("doctor", "--codex", str(FAKE), "--probe")
        self.assertEqual(json.loads(p.stdout)["initialize"], "ok")
        self.assertEqual(json.loads(self.run_cli("status").stdout), [])

    def test_explicit_sandbox_uses_wire_mode_names(self):
        for ident, mode in [("normalmode", "workspace-write"), ("oldalias", "workspaceWrite")]:
            with self.subTest(mode=mode):
                self.workers.append(ident)
                p = self.run_cli("start", ident, "--codex", str(FAKE), "--sandbox", mode, "--prompt", "FAST")
                self.assertEqual(json.loads(p.stdout)["sandbox"], "workspace-write")
                self.wait(ident)


if __name__ == "__main__":
    unittest.main()
