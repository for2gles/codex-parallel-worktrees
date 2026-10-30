---
name: parallel-worktrees
description: Coordinate independent Codex CLI workers in isolated Git worktrees, inspect their live sessions from other terminals, send follow-up instructions and integrate their commits. Use for independent Codex sessions or parallel worktrees rather than shared-directory subagents.
---

# Parallel Worktrees

Use the bundled shell commands to operate independent Codex app-server processes.
Each worker MUST have its own persistent thread, branch and registered Git worktree;
never run two workers in the original checkout or one shared worktree. Requires an existing,
authenticated Codex CLI, Git and Python 3.9+ on macOS/Linux. No tmux or packages.

Read [references/commands.md](references/commands.md) for exact commands, exit codes,
approval handling, recovery and limitations. Resolve script paths relative to this
skill's actual directory; run commands with `--repo` pointing to the original checkout.

## Coordinate the work

1. Run `doctor.sh --repo REPO --probe` to confirm the provided CLI supports the
   transport. Do not install/upgrade Codex, change its configuration or weaken the
   environment's restrictions to make workers run. Parent-session permission
   settings are not automatically inherited by another CLI process; inspect the
   worker's `effective_policy` and obey the host's requirements.
2. Inspect the original checkout and requirements. It must have a commit and no
   uncommitted/untracked files. Do not stash or commit unrelated user work.
   Split genuinely independent tasks, normally starting with two workers. Give
   each task its owned files, relevant interfaces, acceptance criteria and checks.
   All workers start from the current committed HEAD; they cannot see the parent's
   uncommitted edits or conversation unless you explicitly provide that context.
3. Start each worker with `start.sh ID --repo REPO --prompt-file TASK`. For an
   authorized editing task, `--sandbox workspace-write` requests normal scoped writes
   subject to host requirements; otherwise the CLI's default policy applies. Use the
   configured model unless the user asks for another. Worker instructions prohibit
   recursive delegation, pushing, merging and security-configuration changes.
4. Keep coordinating after launch. Call `status.sh` and bounded `wait.sh` (30 seconds
   by default). Read results and repeat the wait as necessary while doing useful
   independent work. Do not end the parent turn merely because workers started.
   `message.sh` steers an active turn or starts a follow-up turn on the same live
   thread after completion. Acknowledged steering means input was accepted, not
   that it has already been acted on. Verify subsequent output.
   Give the user each worker's ID, session ID and worktree path. For inspection in
   another terminal, provide `attach.sh ID --repo REPO` (the same live Codex TUI)
   and `watch.sh ID --repo REPO` (read-only status/output). The attach helper uses
   the worker's own CLI, Unix server endpoint and existing session ID, with the
   exact worktree as cwd. Do not use a plain local `codex resume` against an active
   worker: use the provided same-server command. Attaching must not fork the session
   or create another worktree. Close attached TUIs before integration/cleanup.
5. A `waiting_for_input` state includes the exact pending requests. Surface approvals
   and questions to the user; do not approve or fabricate an answer on the user's
   behalf. Use `respond.sh` only for an explicitly authorized decision or answer.
   Never silently retry a timed-out start/steer: input may already have been accepted.
6. A completed turn is not proof of task correctness. Read `last_message`, inspect
   the worker diff and commit, verify file ownership and run the agreed checks.
   Use a follow-up message for corrections while its controller is still live.
7. Integrate reviewed work with `merge.sh` into the original checkout. It stops the
   completed worker, requires clean checkouts and committed changes, and leaves
   merge conflicts visible. Resolve conflicts in the original checkout, or use
   `git merge --abort` if integration should be abandoned. Never reset user work.
   Run the combined checks after integration and report their actual results.
8. Use `cleanup.sh` only after successful integration. It refuses dirty worktrees
   or commits not present in current HEAD, removes the worktree without force, and
   preserves its branch and diagnostic records. Stop unused workers with `stop.sh`.

The helper sends no messages to other desktop chats, creates no sidebar chats,
publishes no repository and uploads no files. Authentication and model traffic
use the supplied Codex CLI's normal provider configuration. Git worktree isolation
is not a security boundary. The controller does not wake an ended parent chat;
completion is delivered through the parent's ongoing status/wait tool calls.
