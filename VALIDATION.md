# Validation

Validated locally on 2026-10-30. This is a small first version, not a claim of
compatibility with every Codex version or assessment environment.

## Automated orchestration checks

12 integration tests passed on both Python 3.9.6 and Python 3.15.1 using real
temporary Git repositories and a deterministic fake app-server:

- Independent worker processes, thread IDs and worktrees.
- Steering an active turn and starting a follow-up turn in the same thread.
- Explicit approval acceptance/decline and early wait return for pending input.
- Dirty original checkout, dirty worker and unmerged-commit protection.
- Invalid/duplicate worker IDs and worker startup failure.
- Completion-before-response race, bounded wait and interruption.
- Git merge conflicts left intact for manual resolution.
- Socket/app-server handshake without starting a model turn.

The skill-creator frontmatter/scaffold validator passed. The runtime itself
requires no third-party Python packages.

## Real Codex smoke test

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

## Limits

- This chat's outer sandbox denied local Unix sockets. Local integration and real
  smoke tests ran with separately authorized local execution permissions. This
  does not establish that a restricted target environment will permit sockets or
  independent child processes. `doctor --probe` checks sockets and the handshake.
- No Cofa environment was accessed or tested. Its provided CLI version,
  authentication, policy and submission behavior still require verification.
- Optional `--sandbox workspaceWrite` is exposed as a normal Codex mode request,
  subject to host requirements; the real smoke test used inherited settings.
- No automatic recovery, worker-to-worker messaging or parent-chat wakeup was tested
  or implemented. The parent must stay active and use status/wait.
- No generated source, task prompts, auth files or raw runtime logs are included
  in this public package.
