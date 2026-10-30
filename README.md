# Parallel Worktrees

A local Codex skill for independent worker sessions, mandatory separate Git
worktrees, live terminal attachment, follow-up instructions and reviewed integration.
Python standard library only; no tmux, Node.js, package install or CLI upgrade.

## Install

Clone this public repository directly into a skill discovery directory:

```bash
git clone --branch v0.2.0 https://github.com/for2gles/codex-parallel-worktrees.git "$HOME/.agents/skills/parallel-worktrees"
```

Codex discovers skills automatically; restart it if the new skill is missing. In Codex:

```text
$parallel-worktrees
먼저 doctor --probe로 제공된 실행 환경을 확인해줘.
파일 수정 범위가 겹치지 않는 작업 2개로 나누고 독립 워커를 실행해줘.
진행 상태를 계속 확인하면서 필요한 추가 지시를 전달하고,
완료 결과를 검토·병합한 뒤 전체 테스트까지 진행해줘.
```

Read [the command reference](references/commands.md) for manual operation,
approval handling and limits. `SKILL.md` contains the main agent's workflow.

## Another terminal

From your original project checkout, inspect worker `api` in another terminal:

```bash
S="$HOME/.agents/skills/parallel-worktrees/scripts"
bash "$S/attach.sh" api --repo "$PWD"
```

This opens the same live Codex session on the same worker server and worktree.
It works while the worker is running and after it finishes. No new session or
worktree is created. Exit the attached TUI with `/exit`; work continues on the
server. To observe output without sending input:

```bash
bash "$S/watch.sh" api --repo "$PWD"
```

Attach while the worker server is alive, before `merge` or `stop`. Saved output
remains readable with `watch` after stopping/cleanup. Close the TUI before integration.

Every worker has a separate branch, registered worktree, app-server process and
session ID. Sharing the original checkout or another worker's worktree is not
an available mode. `status.sh` lists the IDs, paths and exact terminal commands.

## Compatibility

Real worker and same-session terminal attachment tests passed with Codex CLI
**0.163.0 and 0.164.0** on macOS arm64. See [VALIDATION.md](VALIDATION.md).
Version 0.2.0 uses a private Unix WebSocket server per worker so the controller
and terminal can connect simultaneously. No TCP listener is opened. Version 0.1.1 fixed the optional
`--sandbox` wire value; use `--sandbox workspace-write` for normal scoped edits.

Requires Python 3.9+, Git, macOS/Linux and a supplied, authenticated Codex CLI
supporting `codex app-server --listen unix://...`, `codex resume --remote`, and
v2 thread/turn methods. Uses one
independent app-server process and thread per worker. Version-specific behavior
must be tested with the actual target CLI. A successful local run does not
establish compatibility with an assessment platform.

The helper never overrides security/approval/provider configuration. Another CLI
process reads its own effective configuration; a desktop chat's permissions are
not automatically inherited. Pending requests are exposed for explicit user
decisions. Runtime data stays in Git's private directory and is never pushed by
this helper. Do not upload task prompts, execution logs, credentials or assessment
materials when sharing the skill. Publish only the reusable skill source.

## Validation

```bash
python3 -m unittest discover -s tests -v
```

See [VALIDATION.md](VALIDATION.md) for measured checks and outstanding limits.
Protocol reference: [Codex App Server](https://learn.chatgpt.com/docs/app-server).
