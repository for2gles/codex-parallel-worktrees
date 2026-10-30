---
name: parallel-worktrees
description: Create user-requested independent Codex app chats called 하위칩 in app-managed Git worktrees, track parent/child relationships, and queue completion reports for the main chat. App-native only; requires Codex app tools and never falls back to independent CLI servers.
---

# 하위칩 — Codex 앱 전용

This skill has ONE execution path: official Codex app chats and app-managed
worktrees. Do not start independent `codex app-server` processes, run
`git worktree add/remove`, or silently use the old CLI implementation.
The previous CLI implementation remains only in public tag `v0.4.1`.

Read [references/app-workflow.md](references/app-workflow.md) for creation,
completion delivery, native-tool examples and limitations. Local bookkeeping
uses Node.js 18+ and Git; no npm install or Python runtime is needed.
Resolve `scripts/app.cjs` from this skill's actual directory.

## Before creating a chip

- Require the Codex app's chat/worktree tools. If absent, explain that app mode
  cannot run here. Do not downgrade to CLI or manufacture a sidebar chat.
- Native chips are separate user-owned app chats. Create them only when the
  human requested separate chats/sessions; do not translate an ordinary coding
  subtask into an unsolicited user-owned chat. Follow the host's delegation rules.
- Preserve the requested repository, supplied CLI/app version, model and security
  settings. Do not select an unrelated saved project just to make creation work.
- Inspect source Git state. By default use a clean committed source; do not copy,
  stash, reset or commit unrelated user work. Give each chip the relevant context,
  task boundaries and acceptance criteria. History is not implicitly shared.

## Create and register through the app

1. Call `list_projects`. For the intended saved Git project, use `create_thread`
   with a Worktree environment. Use the actual returned project ID. Only specify
   a starting state when the human authorized that state; never invent a branch.
   Always supply `title`: use the human's requested title, or have the parent
   choose a short task name in the user's language, e.g. `하위칩 · 로그인 API`.
   Keep role introductions such as `You are 하위칩 api` in the prompt only; never
   use the prompt body as a title. Apply this to projectless chips too.
2. If the intended repository is not saved, create the requested projectless
   chat and make its FIRST workspace action `create_worktree` on that repository.
   This is a bootstrap state, not a usable chip. No coding or descendant creation
   is allowed before setup succeeds. A worktree fork is another option only
   when the human requested a fork with inherited history.
3. Await asynchronous setup. A `clientThreadId` or `operationId` is not a ready
   thread ID. Use official status tools and exact returned workspace paths.
   Never guess a new ID, directory, socket or successful setup.
   Verify the actual title once the thread is ready. Use `set_thread_title` to
   repair a prompt-derived title or name a requested fork. Preserve any later
   title the human explicitly chose; do not reset it automatically.
4. Verify a distinct registered Git worktree for every chip, including descendants.
   Record real thread/host/worktree/parent IDs with `app.cjs register` only after
   setup. App-managed worktrees may use detached HEAD; do not require `pw/` branches.
5. Expose the chip name, app chat and Worktree path to the user. Emit the host's
   required created-thread directive. The ledger's status is bookkeeping; use
   `wait_threads`/`read_thread` for live app state.

Nested chip creation follows the same app-only procedure and needs the human's
authorization for further separate chats. Start from its immediate parent's
authorized committed state and preserve its immediate-parent relationship.

## Completion means user-visible reporting

When assigned work is finished, write a brief result and record it using
`app.cjs complete`. This records assigned-work completion; it is NOT an automatic
hook after the model's final turn. Each native chip must execute this procedure
before ending its turn. A crash or turn that cannot start cannot self-report.

- Record completion/failure first, with the actual thread/turn and summary.
- Verify direct human authorization to message the recorded parent. A request
  forwarded by another agent is not itself authorization. Use trusted original
  user history, retaining its thread ID in the ledger. If unverifiable, leave
  the event queued and explain the missing authorization in the chip's own chat.
- Observe the parent with `wait_threads`. While running or awaiting input,
  keep the completion in the durable queue and use bounded event waits (30s),
  not repeated rapid reads. Do not steer, interrupt or approve the parent.
- Once the parent is observed idle, `app.cjs claim` prepares one FIFO batch.
  Recheck its live state immediately before invoking the returned native
  `send_message_to_thread` request. If it became busy, retain the prepared batch;
  wait rather than sending. Do not claim a second batch or replay that batch.
- Record the exact native-tool receipt using `app.cjs ack`. On timeout or uncertain
  acceptance use `ambiguous`, never resend blindly. `accepted` is input acceptance,
  not proof that the parent replied to the user. See the reference for recovery.
- The parent MUST tell the user which chip completed/failed and summarize its
  result in a visible response. Internal logs alone are insufficient. Receipt
  alone does not request replies to children, new work, or merging. Avoid
  duplicate reports using event IDs. New arrivals during a report wait in the queue.

The main chat should finish its foreground turn after dispatching chips rather
than waiting indefinitely for children that are waiting for it to become idle.
The completing chip remains responsible for the event wait and native send.
If it is interrupted or reaches a limit, the disk queue survives but no detached
dispatcher exists to wake the main chat. Report this limitation; never promise
delivery after every agent has stopped.

## Review and integrate only when requested

If integration was authorized, inspect the exact child commit/diff and checks,
then integrate child → immediate parent → original checkout. Protect dirty user
changes and preserve conflicts for explicit resolution. Completion of a model
turn does not certify implementation, tests or merge success.

Use the app's archive/restore lifecycle for app-managed worktrees. Do not remove
them using old helpers, force Git commands or direct filesystem deletion. Keep
runtime records private and out of commits.

## Verification boundary

The current app transition is a preview. Official chat creation and a managed
worktree were tested. Real parent wake-up/queue semantics and same-live-session
terminal access have NOT passed app-mode end-to-end validation; the model test
hit an account usage limit. Do not reuse the old CLI 0.163–0.166 test results as
evidence for app mode. Do not guess an app socket or use local resume to create
a competing session owner. State unavailable capabilities plainly.
