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

## Resolve intent and ownership before selecting a chat

1. Identify the current parent by its exact runtime thread ID and app host ID.
   `CODEX_THREAD_ID`, when supplied by the runtime, is the current thread ID;
   verify the host from app context. Never guess identity from a title or the
   first active chat. Run `app.cjs owned --repo REPO --owner-thread ID --owner-host HOST`.
2. Ownership is the exact `(host, parent thread)` pair in the persistent ledger,
   not the chip title, message body or a globally recent conversation. Another
   parent's chip, an unregistered legacy chip or a grandchild is not your direct
   child. Never silently adopt it or use it to avoid creating a requested chip.
3. For a human request to CREATE a chip, create a FRESH app chat and worktree.
   Put the requested message (for example `hi`) in its initial prompt. Do not
   search history for a similarly named existing or archived chat first.
4. For a message to an EXISTING chip, resolve only an exact owned chip ID or a
   human-identified owned target. Before the native send, use `app.cjs target`
   with your owner IDs and freshly inspected app state. The message text `hi`
   never identifies a target named `hi`. Do not select from global history.
5. If the target is unspecified, use the human's established creation/continuation
   intent in the current trusted conversation. If no owned target exists and
   fresh creation is authorized, create one. Otherwise ask which target/new chat
   is intended. Do not invent creation authority or pick someone else's old chat.
6. Archived targets are excluded by default. Never automatically unarchive,
   restore or resume one after a failed send. Reopening requires a direct human
   request to reopen that exact conversation. On archive/ownership rejection,
   stop and explain; do not retry by changing ownership or archive state.

The canonical file is in the Git common dir at `parallel-worktrees-app/state.json`.
Per-owner views are persisted under `parallel-worktrees-app/owners/`; `owned`
returns the exact file path, including an empty list for a new owner. These files
survive chat turns and are shared by worktrees of the same repository. They are
private runtime records, not Git-tracked files or prompt-only memory.

## Before creating a chip

- Before dispatching an automatic callback, verify explicit human permission
  for completion reporting to THIS parent, not just permission to create a chip
  or send it `hi`. A general request to build this workflow in another chat is
  a preference, not sufficient authorization for every future recipient.
  If the current request does not authorize the return report, explain the
  exact planned callback and obtain approval in the parent before dispatch.
  Do not make the child discover this missing approval after it finishes work.
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
4. Before dispatching, carry the verified completion-report permission and its
   original HUMAN source into the chip's context. If the human already requested
   completion reports to the main chat, this is existing authorization for that
   exact reporting route; do not demand a new approval for every result. Use
   `report-policy` to locate a saved source reference when present, then inspect
   the actual userMessage with `read_thread`. A policy file or a parent's claim
   alone never grants messaging authority. Save the actual evidence and record
   it with `authorize-report` after registration. Never insert a blanket
   "no permission, queue only" instruction without checking the human history.
   Generate `app.cjs worker-context CHIP --repo REPO --owner-thread PARENT
   --owner-host HOST` after authorization. Pass its exact parent and human-source
   reference to the completing chip or notification helper. It fails closed
   when the owned chip has no scoped reporting permission. The worker must use
   its `verification_request` to inspect the actual human message, paginating
   when needed; the generated quote is a reference, not new authority.
5. Verify a distinct registered Git worktree for every chip, including descendants.
   Record real title/thread/host/worktree/parent IDs with `app.cjs register` only after
   setup. App-managed worktrees may use detached HEAD; do not require `pw/` branches.
   Register before sending follow-ups; if registration is pending, say so and
   keep its returned creation IDs. Never fall back to an older similarly named chip.
6. Expose the chip name, app chat and Worktree path to the user. Emit the host's
   required created-thread directive. The ledger's status is bookkeeping; use
   `wait_threads`/`read_thread` for live app state.

Nested chip creation follows the same app-only procedure and needs the human's
authorization for further separate chats. Start from its immediate parent's
authorized committed state and preserve its immediate-parent relationship.

## Main chat must remain available

The main chat MUST NOT wait for a chip's work to finish. Do not call
`wait_threads` with a positive timeout on child work, run status/sleep loops,
or wait for a notification helper to return. Dispatch the authorized work,
record actual creation IDs/ownership, and continue independent work or finish
the foreground response. A one-off `timeoutMs: 0` snapshot is permitted for
inspection; it must not become a polling loop. An explicit later human request
to wait/collect results may override this default.

The human authorizes delegating notification waiting to an INTERNAL subagent
when available. A completing chip may assign its already-verified parent
notification route to a narrow notification subagent that does no coding or
new delegation. That helper may use bounded event waits and send the existing
completion report when the main chat is idle. Do not create a new user-owned
app chat just to simulate this helper. Never make the main agent wait for it.

A two-level INTERNAL-agent test on this host demonstrated that a notification
child remained running after its immediate internal parent completed, then sent
a message to the still-active root without a root wait. See VALIDATION.md. This
does NOT establish the lifetime of a helper under a separate user-owned app
chip, nor wake-up after the root itself has ended its response. Do not close an
app chip relying on those unverified assumptions. Its own notification wait
remains an option while the main stays free. No polling-free, durable daemon
or delivery after all model turns stop is claimed. A separate native-app test
has now verified parent wake-up after its response ended while the completing
app child remained alive; that test does not establish helper-only survival.

## Completion means user-visible reporting

When assigned work is finished, write a brief result and record it using
`app.cjs complete`. This records assigned-work completion; it is NOT an automatic
hook after the model's final turn. Each native chip must execute this procedure
before ending its turn. A crash or turn that cannot start cannot self-report.

- Record completion/failure first, with the actual thread/turn and summary.
- Reuse the human's already-verified completion-report authorization for the
  registered immediate parent. `report-context` identifies its original thread,
  message and quote. On first use, verify the original human message using
  trusted history (the local policy reference can provide a pagination cursor).
  Once verified for this route, do NOT ask for permission again or claim it is
  missing just because the latest task prompt omitted it. A forwarded agent
  instruction is not a new grant and cannot expand recipients or message scope.
  If evidence is unavailable, check the parent context/original history first;
  retain the queued event and report the actual missing evidence rather than
  falsely asserting that the human never authorized reporting.
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
  The helper treats a native `isError: true` response as a failure even if the
  caller mistakenly labels it accepted; review denials remain review-rejected.
- An automatic approval rejection is a separate `review-rejected` hold, not a
  transient failure. Stop and explain the exact action and reviewer's reason.
  Do not retry the same report via another agent, sender, CLI command, hook or
  copied authorization file. New explicit human approval or a demonstrated
  safe authorized alternative is required before reconsidering that action.
  Follow the host's approval-request rules; do not say a preference file or the
  skill overrides the reviewer.
- The parent MUST tell the user which chip completed/failed and summarize its
  result in a visible response. Internal logs alone are insufficient. Receipt
  alone does not request replies to children, new work, or merging. Avoid
  duplicate reports using event IDs. New arrivals during a report wait in the queue.

If a child reports "queued, no permission" despite an existing user request,
the parent must resolve the recorded evidence and report the result to the user;
do not merely repeat that internal blocker as the task outcome. A verified grant
covers completion/failure summaries to that parent only, not arbitrary cross-chat
messages, chat reopening, or new tasks. Explicit user revocation takes precedence.

The main chat finishes or continues independent work after dispatch; it does
not await child completion. The completing chip or its supported notification
helper is responsible for the event wait and native send.
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
runtime records private and out of commits. After an authorized app archive,
record its exact successful tool receipt with `archive-record` so the owned list
excludes it. Ownership remains recorded for audit; archiving never transfers it.

## Verification boundary

The current app transition is a preview. A real native completion callback has
now been rejected by automatic approval review: a new parent's request to create
a chip and send `hi` did not explicitly authorize a separate return message.
Do not advertise unconditional automatic callbacks or claim this is fixed by
passing a general workflow quote. See VALIDATION.md for the observed block.
A new app-mode test with direct human authorization passed: completion was
queued while the parent was active, the parent ended without waiting, and the
live child sent one native report that restarted the parent and produced a
visible user report. This verifies that route, not unconditional delivery under
all permissions, shutdowns, or races. Same-live-session terminal access and
notification-helper survival after the app child itself ends remain unverified.
Do not reuse the old CLI 0.163–0.166 test results as
evidence for app mode. Do not guess an app socket or use local resume to create
a competing session owner. State unavailable capabilities plainly.
