#!/usr/bin/env python3
"""Independent Codex app-server workers. Python 3.9+, macOS/Linux, no packages."""
import argparse
import asyncio
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time

VERSION = "0.1.1"
ACTIVE = {"starting", "running", "waiting_for_input"}
TERMINAL = {"completed", "failed", "interrupted", "disconnected", "stopped"}
APPROVALS = {"item/commandExecution/requestApproval", "item/fileChange/requestApproval"}
MAX_MESSAGE = 4 * 1024 * 1024


def git(repo, *args, check=True):
    p = subprocess.run(["git", "-C", str(repo), *args], text=True,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if check and p.returncode:
        raise RuntimeError(p.stderr.strip() or p.stdout.strip())
    return p


def repository(path):
    root = Path(git(path, "rev-parse", "--show-toplevel").stdout.strip()).resolve()
    common = Path(git(root, "rev-parse", "--git-common-dir").stdout.strip())
    if not common.is_absolute():
        common = root / common
    return root, common.resolve() / "parallel-worktrees"


def valid_id(value):
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,39}", value):
        raise RuntimeError("Worker ID: 1-40 lowercase letters, digits or hyphens")
    return value


def sandbox_mode(value):
    # thread/start uses CLI-style SandboxMode, unlike turn sandboxPolicy.type.
    return {"readOnly": "read-only", "workspaceWrite": "workspace-write"}.get(value, value)


def atomic(path, data):
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def read_state(folder):
    return json.loads((folder / "state.json").read_text())


def socket_path(folder):
    # Unix socket paths are limited to ~104 bytes on macOS. Keep runtime in /tmp.
    digest = hashlib.sha256(str(folder.resolve()).encode()).hexdigest()[:24]
    parent = Path(tempfile.gettempdir()) / ("pw-" + str(os.getuid()))
    parent.mkdir(mode=0o700, exist_ok=True)
    if parent.is_symlink() or parent.stat().st_uid != os.getuid():
        raise RuntimeError("Unsafe runtime directory")
    os.chmod(parent, 0o700)
    return parent / (digest + ".sock")


def control(folder, request, timeout=40):
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as conn:
        conn.settimeout(timeout)
        conn.connect(str(socket_path(folder)))
        conn.sendall(json.dumps(request).encode() + b"\n")
        data = b""
        while not data.endswith(b"\n"):
            part = conn.recv(65536)
            if not part:
                raise RuntimeError("Controller disconnected before replying; inspect status before retrying")
            data += part
            if len(data) > MAX_MESSAGE:
                raise RuntimeError("Controller response exceeds size limit")
        response = json.loads(data)
        if "error" in response:
            raise RuntimeError(response["error"])
        return response["result"]


def snapshot(folder):
    state = read_state(folder)
    try:
        return control(folder, {"op": "status"}, timeout=2)
    except (OSError, RuntimeError):
        if state["status"] in ACTIVE:
            state = dict(state, status="disconnected", error="Worker controller unavailable; worktree preserved")
        return state


def require_clean(repo):
    if git(repo, "status", "--porcelain", "--untracked-files=all").stdout.strip():
        raise RuntimeError("Uncommitted or untracked changes exist: " + str(repo))


def acquire_lock(lock, timeout=7):
    deadline = time.monotonic() + timeout
    while True:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return
        except BlockingIOError:
            if time.monotonic() >= deadline:
                raise RuntimeError("Controller or Git operation is still active; try status before retrying")
            time.sleep(0.05)


def launch(folder):
    with (folder / "controller.log").open("ab") as log:
        proc = subprocess.Popen([sys.executable, str(Path(__file__).resolve()),
                                 "_daemon", str(folder)], stdin=subprocess.DEVNULL,
                                stdout=log, stderr=log, start_new_session=True)
    deadline = time.monotonic() + 35
    while time.monotonic() < deadline:
        try:
            result = control(folder, {"op": "status"}, timeout=1)
            if result["status"] != "starting":
                if result["status"] == "failed":
                    raise RuntimeError(result.get("error", "Startup failed"))
                return result
        except (OSError, socket.timeout):
            pass
        if proc.poll() is not None:
            s = read_state(folder)
            raise RuntimeError(s.get("error") or "Controller exited; inspect controller.log")
        time.sleep(0.1)
    raise RuntimeError("Startup timed out; worker may still be starting. Inspect status, do not relaunch.")


class Worker:
    def __init__(self, folder):
        self.folder = folder
        self.state = read_state(folder)
        self.proc = None
        self.pending = {}
        self.counter = 0
        self.stop_event = asyncio.Event()
        self.command_lock = asyncio.Lock()
        self.reader_task = None
        self.stderr_file = None
        self.ready = False

    def save(self):
        self.state["updated_at"] = time.time()
        atomic(self.folder / "state.json", self.state)

    def record(self, message):
        with (self.folder / "events.jsonl").open("a") as f:
            f.write(json.dumps({"time": time.time(), **message}, ensure_ascii=False) + "\n")

    async def send(self, message):
        self.proc.stdin.write(json.dumps(message).encode() + b"\n")
        await self.proc.stdin.drain()

    async def rpc(self, method, params):
        self.counter += 1
        ident = self.counter
        future = asyncio.get_running_loop().create_future()
        self.pending[ident] = future
        try:
            await self.send({"id": ident, "method": method, "params": params})
            return await asyncio.wait_for(future, timeout=30)
        finally:
            self.pending.pop(ident, None)

    def event(self, message):
        method = message.get("method")
        params = message.get("params", {})
        self.record(message)
        if method == "turn/started":
            self.state.update(turn_id=params["turn"]["id"], status="running", error=None)
        elif method == "turn/completed":
            turn = params["turn"]
            self.state.update(turn_id=turn["id"], status=turn["status"], error=turn.get("error"))
            self.state["pending_requests"] = []
            self.state["completed_at"] = time.time()
        elif method == "item/agentMessage/delta":
            with (self.folder / "messages.log").open("a") as f:
                f.write(params.get("delta", ""))
        elif method == "item/completed" and params.get("item", {}).get("type") == "agentMessage":
            self.state["last_message"] = params["item"].get("text", "")
        elif method == "error":
            self.state["last_error"] = params
        elif method == "serverRequest/resolved":
            ident = params.get("requestId")
            self.state["pending_requests"] = [r for r in self.state["pending_requests"] if r["id"] != ident]
            if not self.state["pending_requests"] and self.state["status"] == "waiting_for_input":
                self.state["status"] = "running"
        self.save()

    async def read_loop(self):
        try:
            while True:
                line = await self.proc.stdout.readline()
                if not line:
                    raise RuntimeError("Codex app-server closed stdout")
                try:
                    message = json.loads(line)
                except ValueError:
                    self.record({"unparsed_stdout": line.decode(errors="replace")})
                    continue
                if "method" in message and "id" in message:
                    # No automatic approvals or implicit answers, including unknown methods.
                    self.state["pending_requests"].append(message)
                    self.state["status"] = "waiting_for_input"
                    self.record(message)
                    self.save()
                elif "id" in message:
                    future = self.pending.get(message["id"])
                    if future is not None and not future.done():
                        if "error" in message:
                            future.set_exception(RuntimeError(json.dumps(message["error"])))
                        else:
                            future.set_result(message.get("result", {}))
                else:
                    self.event(message)
        except Exception as exc:
            for future in list(self.pending.values()):
                if not future.done():
                    future.set_exception(RuntimeError(str(exc)))
            if self.state["status"] in ACTIVE:
                self.state.update(status="disconnected", error=str(exc))
            self.save()
            self.stop_event.set()

    async def begin(self, text):
        self.state.update(status="starting", pending_requests=[], last_message="", error=None)
        self.save()
        result = await self.rpc("turn/start", {"threadId": self.state["thread_id"],
                              "input": [{"type": "text", "text": text}]})
        turn = result["turn"]
        # A short turn may complete before its RPC response arrives.
        if self.state.get("turn_id") != turn["id"]:
            self.state.update(turn_id=turn["id"], status="running")
        self.save()
        return {"action": "started", "thread_id": self.state["thread_id"], "turn_id": turn["id"]}

    async def dispatch(self, req):
        op = req.get("op")
        if op == "status":
            return dict(self.state)
        async with self.command_lock:
            if not self.ready:
                raise RuntimeError("Worker is still initializing")
            if op == "message":
                text = req["text"]
                if self.state["status"] in {"running", "waiting_for_input"}:
                    # If completion wins the race, surface the error. Never silently duplicate input.
                    result = await self.rpc("turn/steer", {"threadId": self.state["thread_id"],
                                           "expectedTurnId": self.state["turn_id"],
                                           "input": [{"type": "text", "text": text}]})
                    return {"action": "steered", **result}
                return await self.begin(text)
            if op == "respond":
                pending = next((r for r in self.state["pending_requests"] if str(r["id"]) == str(req["request_id"])), None)
                if pending is None:
                    raise RuntimeError("Pending request not found")
                if "decision" in req:
                    if pending["method"] not in APPROVALS:
                        raise RuntimeError("Use --json-file for this request type")
                    result = {"decision": req["decision"]}
                else:
                    if pending["method"] in APPROVALS:
                        raise RuntimeError("Use --decision accept/decline/cancel for approvals")
                    result = req["result"]
                await self.send({"id": pending["id"], "result": result})
                self.state["pending_requests"].remove(pending)
                if not self.state["pending_requests"]:
                    self.state["status"] = "running"
                self.save()
                return {"action": "responded", "request_id": pending["id"]}
            if op == "stop":
                if self.state["status"] in ACTIVE and self.state.get("turn_id"):
                    await self.rpc("turn/interrupt", {"threadId": self.state["thread_id"],
                                                     "turnId": self.state["turn_id"]})
                    deadline = time.monotonic() + 10
                    while self.state["status"] in ACTIVE and time.monotonic() < deadline:
                        await asyncio.sleep(0.05)
                    if self.state["status"] in ACTIVE:
                        raise RuntimeError("Interrupt not confirmed; controller kept alive")
                self.stop_event.set()
                return {"action": "stopped"}
            raise RuntimeError("Unknown controller operation")

    async def client(self, reader, writer):
        try:
            data = await asyncio.wait_for(reader.readline(), timeout=5)
            result = await self.dispatch(json.loads(data))
            reply = {"result": result}
        except Exception as exc:
            reply = {"error": str(exc)}
        writer.write(json.dumps(reply, ensure_ascii=False).encode() + b"\n")
        with contextlib.suppress(Exception):
            await writer.drain()
        writer.close()
        await writer.wait_closed()

    async def run(self):
        path = socket_path(self.folder)
        if path.exists():
            path.unlink()
        server = await asyncio.start_unix_server(self.client, path=str(path), limit=MAX_MESSAGE)
        os.chmod(path, 0o600)
        try:
            self.state.update(status="starting", pending_requests=[], controller_pid=os.getpid())
            self.save()
            self.stderr_file = (self.folder / "app-server.stderr.log").open("ab")
            self.proc = await asyncio.create_subprocess_exec(self.state["codex"], "app-server",
                       cwd=self.state["worktree"], stdin=asyncio.subprocess.PIPE,
                       stdout=asyncio.subprocess.PIPE, stderr=self.stderr_file, limit=MAX_MESSAGE)
            self.state["app_server_pid"] = self.proc.pid
            self.reader_task = asyncio.create_task(self.read_loop())
            init = await self.rpc("initialize", {"clientInfo": {"name": "parallel_worktrees",
                                  "title": "Parallel Worktrees", "version": VERSION}})
            self.state["server_info"] = init
            await self.send({"method": "initialized", "params": {}})
            params = {"cwd": self.state["worktree"]}
            if self.state.get("model"):
                params["model"] = self.state["model"]
            if self.state.get("sandbox"):
                params["sandbox"] = self.state["sandbox"]
            if self.state.get("thread_id"):
                params["threadId"] = self.state["thread_id"]
                result = await self.rpc("thread/resume", params)
            else:
                result = await self.rpc("thread/start", params)
            self.state["thread_id"] = result["thread"]["id"]
            self.state["effective_policy"] = {k: result[k] for k in
                ("approvalPolicy", "approvalsReviewer", "sandbox", "model") if k in result}
            self.ready = True
            await self.begin(self.state["prompt"])
            await self.stop_event.wait()
        except Exception as exc:
            self.state.update(status="failed", error=str(exc))
            self.save()
        finally:
            server.close()
            await server.wait_closed()
            if self.proc is not None:
                if self.proc.returncode is None:
                    self.proc.terminate()
                    try:
                        await asyncio.wait_for(self.proc.wait(), timeout=5)
                    except asyncio.TimeoutError:
                        self.proc.kill()
                        await self.proc.wait()
                if self.reader_task:
                    await self.reader_task
            if self.stderr_file:
                self.stderr_file.close()
            if self.state["status"] in ACTIVE:
                self.state["status"] = "stopped"
            self.save()
            path.unlink(missing_ok=True)


def daemon(folder):
    folder = Path(folder)
    with (folder / "daemon.lock").open("w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("Controller already exists")
        async def run_worker():
            # Python 3.9 binds Event/Lock to the current loop at construction.
            await Worker(folder).run()
        try:
            asyncio.run(run_worker())
        except Exception as exc:
            state = read_state(folder)
            atomic(folder / "state.json", dict(state, status="failed", error=str(exc)))
            raise


def prompt_text(args):
    text = Path(args.prompt_file).read_text() if args.prompt_file else args.prompt
    if not text or not text.strip():
        raise RuntimeError("Prompt must not be empty")
    return text


def parser():
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest="command", required=True)
    d = sub.add_parser("_daemon", help=argparse.SUPPRESS)
    d.add_argument("folder")
    for name in ("start", "status", "message", "wait", "respond", "stop", "merge", "cleanup", "doctor"):
        s = sub.add_parser(name)
        s.add_argument("--repo", default=".", help="Repository (run from original worktree)")
        if name not in {"doctor", "status", "wait"}:
            s.add_argument("id")
        elif name in {"status", "wait"}:
            s.add_argument("ids", nargs="*")
        if name in {"start", "message"}:
            group = s.add_mutually_exclusive_group(required=True)
            group.add_argument("--prompt")
            group.add_argument("--prompt-file")
        if name in {"doctor", "start"}:
            s.add_argument("--codex", default="codex", help="Existing Codex executable")
        if name == "doctor":
            s.add_argument("--probe", action="store_true", help="Initialize app-server without starting a model turn")
        if name == "start":
            s.add_argument("--model", help="Omit to inherit configured model")
            s.add_argument("--sandbox", type=sandbox_mode, choices=["read-only", "workspace-write"],
                           help="Optional normal Codex sandbox mode; host requirements still apply")
        if name == "wait":
            s.add_argument("--timeout", type=float, default=30, help="Bounded wait, seconds")
        if name == "respond":
            s.add_argument("request_id")
            group = s.add_mutually_exclusive_group(required=True)
            group.add_argument("--decision", choices=["accept", "decline", "cancel"])
            group.add_argument("--json-file", help="JSON response for a non-approval server request")
    return p


async def probe(codex, repo):
    proc = await asyncio.create_subprocess_exec(codex, "app-server", cwd=str(repo),
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL, limit=MAX_MESSAGE)
    try:
        proc.stdin.write((json.dumps({"id": 1, "method": "initialize", "params": {
            "clientInfo": {"name": "parallel_worktrees", "version": VERSION}}}) + "\n").encode())
        await proc.stdin.drain()
        while True:
            line = await asyncio.wait_for(proc.stdout.readline(), timeout=15)
            if not line:
                raise RuntimeError("app-server exited before initialize response")
            msg = json.loads(line)
            if msg.get("id") == 1:
                if "error" in msg:
                    raise RuntimeError(str(msg["error"]))
                proc.stdin.write(b'{"method":"initialized","params":{}}\n')
                await proc.stdin.drain()
                return {"initialize": "ok", "server_info": msg.get("result")}
    finally:
        if proc.returncode is None:
            proc.terminate()
            try:
                await asyncio.wait_for(proc.wait(), timeout=5)
            except asyncio.TimeoutError:
                proc.kill()
                await proc.wait()


def main(argv=None):
    args = parser().parse_args(argv)
    if args.command == "_daemon":
        daemon(args.folder)
        return 0
    root, base = repository(args.repo)
    base.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(base, 0o700)
    if args.command == "doctor":
        codex = shutil.which(args.codex)
        if codex is None:
            raise RuntimeError("Codex executable not found; use the environment's provided version")
        v = subprocess.run([codex, "--version"], capture_output=True, text=True, check=True)
        out = {"python": sys.version.split()[0], "codex": codex, "version": v.stdout.strip(),
               "repo": str(root), "state_dir": str(base)}
        if args.probe:
            path = socket_path(base / ("probe-" + os.urandom(6).hex()))
            try:
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
                    sock.bind(str(path))
            except OSError as exc:
                raise RuntimeError("Local Unix sockets are unavailable in this execution environment: " + str(exc))
            finally:
                path.unlink(missing_ok=True)
            out["local_socket"] = "ok"
            out.update(asyncio.run(probe(codex, root)))
        print(json.dumps(out, ensure_ascii=False, indent=2))
        return 0
    if args.command in {"status", "wait"}:
        ids = args.ids or sorted(p.name for p in base.iterdir() if (p / "state.json").is_file())
        folders = [base / valid_id(i) for i in ids]
        deadline = time.monotonic() + max(0, getattr(args, "timeout", 0))
        while True:
            states = [snapshot(f) for f in folders]
            attention = any(s["status"] == "waiting_for_input" for s in states)
            done = all(s["status"] in TERMINAL for s in states)
            if args.command == "status" or attention or done or time.monotonic() >= deadline:
                print(json.dumps(states, ensure_ascii=False, indent=2))
                if args.command == "status":
                    return 0
                if attention:
                    return 3
                if not done:
                    return 2
                return 0 if all(s["status"] == "completed" for s in states) else 1
            time.sleep(0.2)
    ident = valid_id(args.id)
    folder = base / ident
    if args.command == "start":
        require_clean(root)
        codex = shutil.which(args.codex)
        if codex is None:
            raise RuntimeError("Codex executable not found")
        text = prompt_text(args)
        folder.mkdir(mode=0o700)  # Never overwrite an existing worker.
        worktree = folder / "worktree"
        branch = "pw/" + ident + "-" + os.urandom(3).hex()
        base_commit = git(root, "rev-parse", "HEAD").stdout.strip()
        # For reviewable commits the worker is asked to commit, but merge never assumes it did.
        instruction = ("You are an independent worker in an isolated Git worktree. "
            "Perform only the assigned task. Do not spawn other workers, merge, push, or change "
            "Codex/security configuration. Keep changes in this worktree. Run relevant checks. "
            "Commit only your task files when complete; report tests, commit and limitations.\n\n" + text)
        state = {"id": ident, "repo": str(root), "worktree": str(worktree), "branch": branch,
                 "base_commit": base_commit, "codex": codex, "model": args.model,
                 "sandbox": args.sandbox,
                 "prompt": instruction, "status": "starting", "pending_requests": [],
                 "created_at": time.time(), "thread_id": None, "turn_id": None}
        atomic(folder / "state.json", state)
        try:
            git(root, "worktree", "add", "-b", branch, str(worktree), base_commit)
            result = launch(folder)
        except Exception as exc:
            # Leave branches/files for diagnosis, including uncertain startup outcomes.
            if not (folder / "daemon.lock").exists():
                atomic(folder / "state.json", dict(state, status="failed", error=str(exc)))
            raise
    elif args.command == "message":
        result = control(folder, {"op": "message", "text": prompt_text(args)})
    elif args.command == "respond":
        req = {"op": "respond", "request_id": args.request_id}
        if args.decision:
            req["decision"] = args.decision
        else:
            req["result"] = json.loads(Path(args.json_file).read_text())
        result = control(folder, req)
    elif args.command == "stop":
        result = control(folder, {"op": "stop"})
    elif args.command in {"merge", "cleanup"}:
        # Serialize against other merge/cleanup commands and stop the worker before Git inspection.
        with (base / "integration.lock").open("w") as lock:
            acquire_lock(lock)
            state = snapshot(folder)
            if state["status"] in ACTIVE or state["status"] == "disconnected":
                raise RuntimeError("Worker is active or disconnected; resolve/stop it before Git integration")
            if args.command == "merge" and state["status"] != "completed":
                raise RuntimeError("Only a completed worker can be merged")
            try:
                control(folder, {"op": "stop"})
            except (ConnectionRefusedError, FileNotFoundError):
                pass
            # Wait until daemon releases ownership before changing its worktree.
            with (folder / "daemon.lock").open("a") as daemon_lock:
                acquire_lock(daemon_lock)
                require_clean(root)
                tree = state["worktree"]
                require_clean(tree)
                if Path(tree).resolve() == root:
                    raise RuntimeError("Refusing to remove or merge the original worktree")
                head_branch = git(tree, "symbolic-ref", "--short", "HEAD").stdout.strip()
                if head_branch != state["branch"]:
                    raise RuntimeError("Worker branch changed unexpectedly")
                commit = git(tree, "rev-parse", "HEAD").stdout.strip()
                if args.command == "merge":
                    if commit == state["base_commit"]:
                        raise RuntimeError("Worker produced no commits")
                    git(root, "merge", "--no-edit", "--", state["branch"])
                    result = {"action": "merged", "branch": state["branch"], "commit": commit}
                else:
                    if git(root, "merge-base", "--is-ancestor", commit, "HEAD", check=False).returncode:
                        raise RuntimeError("Worker has commits absent from current HEAD; preserve the worktree")
                    git(root, "worktree", "remove", "--", tree)
                    result = {"action": "cleaned", "branch_preserved": state["branch"]}
                current = read_state(folder)
                current["last_git_action"] = result
                atomic(folder / "state.json", current)
    else:
        raise RuntimeError("Unknown command")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (RuntimeError, OSError, ValueError, subprocess.SubprocessError) as exc:
        print("error: " + str(exc), file=sys.stderr)
        sys.exit(1)
