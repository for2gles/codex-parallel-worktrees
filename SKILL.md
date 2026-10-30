---
name: parallel-worktrees
description: Create and coordinate independent Codex sessions called 하위칩 in mandatory separate Git worktrees, including nested child chips, live terminal access, follow-up instructions and bottom-up integration. Use for independent coding sessions or parallel worktrees rather than shared-directory subagents.
---

# 하위칩 / Parallel Worktrees

The user calls an independent lower-level Codex session **하위칩** (chip). A chip
can create further chips. Each chip MUST have its own persistent session,
registered Git worktree, branch and app-server process. No shared-worktree mode.
Requires Node.js 18+, Git and an existing authenticated Codex CLI on macOS/Linux.
No Python, npm install, tmux or other runtime package is needed.

Read [references/commands.md](references/commands.md) for command arguments,
remote access, hierarchy, permissions and lifecycle. Resolve script paths from
this skill's actual directory; use `--repo` to locate the project registry.

## Work and delegate

1. Run `doctor.sh --repo REPO --probe`. Use the supplied CLI and existing provider;
   never upgrade Codex, change security configuration, or bypass restrictions.
   Another CLI reads its own configuration; inspect `effective_policy` instead
   of assuming the parent chat's permissions are inherited.
2. Compare the task with the committed checkout. Do not stash/commit unrelated
   user work. A chip starts from a clean, committed HEAD and cannot see a parent's
   uncommitted edits or conversation. Give it relevant context, owned files,
   interfaces, acceptance criteria and checks. Start with the independent tasks
   actually needed, rather than delegating an unchanged task recursively.
3. Start with `start.sh ID --repo REPO --prompt 'TASK'` or `--prompt-file PATH`.
   For an authorized editing task, `--sandbox workspace-write` requests normal
   scoped writes subject to enforced host requirements. Do not override the
   configured model unless the user requests it.
4. A chip may start a child using `start.sh CHILD_ID --repo ITS_OWN_WORKTREE ...`.
   Parent detection is automatic. Alternatively, `--parent PARENT_ID` explicitly
   chooses that parent's worktree. Child chips inherit the parent's CLI, optional
   model and requested sandbox unless explicitly overridden. IDs are globally
   unique within one repository; use meaningful names such as `api-db`.
   Children may delegate concrete independent subtasks further in the same way.
5. Keep coordinating: `status.sh`, bounded `wait.sh`, and `message.sh` deliver
   progress, completion and follow-ups. `wait PARENT` includes its descendants.
   Do not end a parent turn merely because children started. Read output, verify
   checks and inspect diffs; a completed turn is not proof of correct implementation.
6. Expose each chip's ID, parent, session ID and worktree to the user. `list.sh`
   shows the hierarchy and copyable open commands; `remote.sh ID` prints the
   remote URI, session ID and full commands. `attach.sh ID` opens the SAME live
   session on its server and worktree, and `watch.sh ID` only observes output.
   Never substitute plain local `codex resume` for the same-server attach helper.
7. Surface `pending_requests` to the user. Use `respond.sh` only for authorized
   decisions or explicit user answers; never auto-approve requests or invent
   answers. A timeout can mean input was accepted: inspect state before retrying.

## Integrate from the leaves upward

Review each child's changes and checks, then call `merge.sh CHILD --repo REPO`.
The helper always uses the child's recorded immediate parent worktree as its
target, even when invoked from the original project. It never skips a parent.
Clean that child after integration, then repeat upward. The parent includes
merged child commits when it eventually integrates into its own parent.

Close attached TUIs before integration. Merge stops the completed chip, requires
clean checkouts and committed changes, and preserves Git conflicts for explicit
resolution or `git merge --abort`. Cleanup refuses dirty/unmerged work and refuses
to remove a chip while descendant worktrees remain. Stop descendants before
stopping a parent. Never force-delete worktrees or reset user changes.

Run combined project checks at the final integration target and report actual
results. Worktrees, branches and logs are independent; Git worktree separation
is not a security boundary. Runtime records stay in Git's private directory and
must not be published. This helper sends no messages to other desktop chats,
creates no sidebar chats, publishes nothing and does not wake an ended parent chat.
