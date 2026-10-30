# Commands

Let `S` be this skill's absolute `scripts` path and `R` the original checkout.
Run `bash "$S/COMMAND.sh" ...`; executable bits are not required. Python 3.9+,
Git, an existing authenticated Codex CLI, and Unix sockets are required.

```bash
bash "$S/doctor.sh" --repo "$R" --probe
bash "$S/start.sh" api --repo "$R" --prompt-file /absolute/path/api-task.txt
bash "$S/start.sh" ui --repo "$R" --prompt 'Implement the UI in ui/; test it and commit only task files.'
bash "$S/status.sh" --repo "$R"
bash "$S/message.sh" api --repo "$R" --prompt 'Use the agreed response schema; update the tests.'
bash "$S/wait.sh" api ui --repo "$R" --timeout 30
bash "$S/merge.sh" api --repo "$R"
bash "$S/merge.sh" ui --repo "$R"
# Run the combined project checks, then:
bash "$S/cleanup.sh" api --repo "$R"
bash "$S/cleanup.sh" ui --repo "$R"
```

`doctor --probe` checks the local socket and performs the app-server handshake; it spends no model tokens.
It does not prove model access, editing, steering or Cofa compatibility. `start`
accepts `--codex /existing/executable` and optional `--model MODEL`; otherwise it
uses PATH and the CLI's configured model. It never upgrades anything. No sandbox,
approval, provider or model configuration is overridden by default. For an
authorized editing task, `start --sandbox workspace-write` requests the normal
workspace-write mode, subject to the host's enforced requirements. `read-only` is
also supported. No full-access mode or approval-bypass option is exposed.

## State and completion

State is under `$(git rev-parse --git-common-dir)/parallel-worktrees/ID/`:
`state.json`, `events.jsonl`, `messages.log`, `controller.log`,
`app-server.stderr.log`, and `worktree/`. Git's private directory excludes these
files from commits. Logs contain prompts and model/tool output: do not publish
them. The short local socket path is under the current user's private temporary
runtime directory. No TCP listener is opened by this helper.

`status` returns all known workers, or specified IDs. `wait` does a bounded wait
and returns early when any worker needs input. Exit codes:

| Code | Meaning |
|---|---|
| 0 | All selected turns completed (`status` always uses 0 if it can read state) |
| 1 | Failure, interruption, disconnected controller, or command error |
| 2 | Wait deadline reached; workers are still active |
| 3 | Approval or user input needed; inspect `pending_requests` |

`last_message` is the last completed agent message. `completed` describes the
model turn, not a successful implementation/test run. Always review the diff.
An RPC timeout is ambiguous: check state and events before deciding to resend.

## Responding to requests

Show the full pending method/params to the user. For an explicitly authorized
command/file decision, use the request ID from `status`:

```bash
bash "$S/respond.sh" api 123 --repo "$R" --decision accept
# Or --decision decline / --decision cancel.
```

For other server requests, `--json-file /absolute/path/response.json` sends the
protocol-specific result verbatim. This is for explicit user answers only; it is
not a general approval shortcut. Unknown requests remain pending. The response
schema depends on the installed Codex version; inspect its generated schema or
the [App Server documentation](https://learn.chatgpt.com/docs/app-server).

## Stop and recovery

```bash
bash "$S/stop.sh" api --repo "$R"
```

Stop interrupts an active turn, waits for confirmation, and closes its owned
app-server process. It does not signal arbitrary PIDs loaded from disk. Stopped
controllers cannot receive `message`; inspect the preserved thread/worktree and
continue manually with the supplied CLI if necessary. A crashed controller is
reported as disconnected; no automatic restart/replay occurs. Worker IDs are not
reused and failed worktrees/branches are retained for diagnosis.

If the controller dies while a worker is active, do not merge or clean up until
you have inspected its actual process state and files. The helper deliberately
refuses automatic cleanup of that ambiguous state. If a merge fails due to a
conflict, resolve it in the original checkout and commit, or `git merge --abort`.
`merge` stops the worker before checking dirty files; finish any missing commit
manually if that check fails. Do not put diagnostic files into a commit.

## What this version does not promise

- No automatic push, publishing, force cleanup, conflict resolution or test choice.
- No unsolicited wakeup of an ended parent chat; the main agent must keep waiting.
- No direct worker-to-worker mailbox; the main agent relays relevant changes.
- No A2A service, remote daemon, Windows support or automatic crash recovery.
- No guarantee that a fixed Cofa CLI version supports this protocol or permits
  child processes/sockets. Try `doctor --probe`, then one tiny real task in the
  allowed environment. If restricted, use the platform's supported workflow.

## Local validation

From the skill directory:

```bash
python3 -m unittest discover -s tests -v
```

These tests use a fake JSONL app-server and real temporary Git repositories.
They exercise orchestration and Git invariants, not model behavior. A separate
real CLI smoke test is required for actual provider/version compatibility.
