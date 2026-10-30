# Validation

Validated locally on 2026-10-30. This is a small first version, not a claim of
compatibility with every Codex version or assessment environment.

## Automated orchestration checks

21 tests passed on both Python 3.9.6 and Python 3.15.1, comprising 17 integration
tests with real temporary Git repositories and an independent fake app-server,
plus four WebSocket transport tests:

- Independent worker processes, thread IDs and worktrees.
- Steering an active turn and starting a follow-up turn in the same thread.
- Explicit approval acceptance/decline and early wait return for pending input.
- Dirty original checkout, dirty worker and unmerged-commit protection.
- Invalid/duplicate worker IDs and worker startup failure.
- Completion-before-response race, bounded wait and interruption.
- Git merge conflicts left intact for manual resolution.
- Socket/app-server handshake without starting a model turn.
- Explicit sandbox mode normalization and protocol validation.
- Same-server terminal command construction, private socket permissions, external
  client observation, externally started turns, read-only watching and worktree
  branch validation.
- Fragmented text with interleaved ping/pong, long masked client messages,
  oversized inbound frames and invalid server masking.

The skill-creator frontmatter/scaffold validator passed. The runtime itself
requires no third-party Python packages.

## Real Codex 0.164.0 smoke test

Environment: macOS arm64, Codex CLI 0.164.0, configured model gpt-6.1-sol,
Python 3.15.1. Used a disposable local repository with no assessment material.

1. Started two separate app-server processes and two separate persistent threads
   from the same baseline commit in different Git worktrees.
2. Worker A created an addition function plus two unit tests. A live steer added
   a negative-number acceptance criterion, which appeared in its committed test.
3. Worker B created a greeting function plus two unit tests. Both workers passed
   their two tests and committed only their assigned files.
4. Confirmed approval requests were visible and remained pending until explicitly
   answered. The real CLI's inherited policy was readOnly/on-request; no bypass
   flags or security configuration changes were used.
5. Started a new turn after Worker A completed. Its thread ID was unchanged and
   it correctly answered a follow-up about the existing addition function.
6. Reviewed both commits, merged them into the original checkout, and independently
   ran all four unit tests successfully.
7. Removed both merged worktrees with cleanup. The original checkout was clean,
   only its original worktree remained registered, and branches were preserved.

## Real Codex 0.163.0 compatibility test

Downloaded the official macOS arm64 package from the
[OpenAI 0.163.0 release](https://github.com/openai/codex/releases/tag/rust-v0.163.0)
into a separate test directory; the installed 0.164.0 executable was unchanged.
Verified its SHA-256 against the release asset digest:
`b0344fc2e41f15e0071147e5869008047b8ff4bf2c4a8897975d3bae3f103b34`.

- Confirmed `codex-cli 0.163.0`, socket/stdio initialization and actual skill discovery.
- Generated the version's protocol schemas and checked the worker's thread/turn methods.
- Found and fixed a v0.1.0 optional-mode bug: thread/start `sandbox` uses
  `workspace-write` / `read-only`, while sandbox policy objects use camel-case
  type names. This distinction applies to both tested CLI versions. v0.1.1 sends
  the correct wire values and accepts old camel-case CLI aliases for compatibility.
- Started two distinct app-server processes and persistent threads in isolated
  worktrees with explicit normal `workspace-write` mode.
- Worker A implemented multiplication and two tests. An active-turn steer added
  a negative-number criterion, which appeared in its committed test.
- Worker B implemented a square function and two tests. Both workers passed their
  tests and committed only their assigned files after explicit Git approval.
- A post-completion follow-up kept Worker A's thread ID and returned the correct answer.
- Reviewed and merged both commits, independently passed all four combined unit tests,
  removed the worktrees and confirmed the original checkout was clean.

The compatibility test used the same configured gpt-6.1-sol model and Python 3.15.1.

## v0.2.0: separate-terminal attachment (0.163.0 and 0.164.0)

- Switched worker transport from exclusive stdio to a private Unix WebSocket
  endpoint, which both the controller and Codex TUI can connect to simultaneously.
  It uses the Python standard library and opens no TCP port.
- Started distinct 0.163.0 and 0.164.0 server processes with independent threads,
  branches and registered Git worktrees from the same disposable original checkout.
- Opened `attach.sh` in two separate PTY terminals. Both real Codex TUIs resumed
  their intended session and displayed its worktree, original prompt, command
  activity and output. The 0.164.0 TUI observed the original in-flight turn.
- Checked session, turn and worktree IDs before/after attachment: all were
  unchanged. Attachment did not fork a conversation or restart a turn.
- Submitted a short no-tools follow-up from each TUI. Both answers appeared in
  the TUI and in the main controller's state under their original thread IDs.
- Exited each TUI normally with `/exit`. Both reported disconnection while work
  continued; the controller then started another turn on each same session.
- Watcher subprocesses and automatic integration tests verify read-only inspection;
  changed worktree branches are rejected rather than silently attaching elsewhere.

These terminal checks are specific to macOS arm64 with the two actual CLI versions.
The Cofa execution environment has still not been accessed.

## Limits

- This chat's outer sandbox denied local Unix sockets. Local integration and real
  smoke tests ran with separately authorized local execution permissions. This
  does not establish that a restricted target environment will permit sockets or
  independent child processes. `doctor --probe` checks sockets and the handshake.
- No Cofa environment was accessed or tested. Its provided CLI version,
  authentication, policy and submission behavior still require verification.
- Optional `--sandbox workspace-write` is a normal Codex mode request, subject to
  host requirements. It was exercised with 0.163.0; the 0.164.0 smoke test used
  inherited read-only settings with explicit per-operation approvals.
- No automatic recovery, worker-to-worker messaging or parent-chat wakeup was tested
  or implemented. The parent must stay active and use status/wait.
- No generated source, task prompts, auth files or raw runtime logs are included
  in this public package.
