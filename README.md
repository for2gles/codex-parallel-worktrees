# 하위칩 / Parallel Worktrees

독립된 Codex 세션을 **하위칩**이라고 부릅니다. 각 하위칩은 별도 Worktree·브랜치·세션·프로세스를 가지며,
하위칩이 다시 자식 하위칩을 만들 수 있습니다. 메인에서 작업을 분할하고 진행 상태·추가 지시·결과 통합을 관리합니다.
자식의 턴 완료·실패는 상위칩으로 자동 전달합니다. 상위가 응답을 끝냈어도 서버와 컨트롤러가 살아 있으면 같은 세션에서 후속 턴을 시작합니다.
메인이 작업 중이면 완료 메시지를 디스크 큐에 보관하고, 현재 턴이 끝난 뒤 사용자에게 완료·실패와 결과 요약을 알립니다.

**Node.js 18+와 Git, 제공된 Codex CLI만 사용합니다. Python·npm install·tmux는 필요 없습니다.**
macOS/Linux용입니다. 실제 검증 환경과 범위는 [VALIDATION.md](VALIDATION.md)에 기록합니다.

## 설치

```bash
git clone --branch v0.4.1 https://github.com/for2gles/codex-parallel-worktrees.git "$HOME/.agents/skills/parallel-worktrees"
```

기존 설치를 갱신하려면 로컬 변경이 없는지 확인한 뒤:

```bash
git -C "$HOME/.agents/skills/parallel-worktrees" fetch origin --tags
git -C "$HOME/.agents/skills/parallel-worktrees" checkout v0.4.1
```

Codex에서 인식되지 않으면 재실행한 다음 다음과 같이 요청합니다.

```text
$parallel-worktrees
먼저 doctor --probe로 제공된 환경을 확인해줘.
필요한 독립 작업을 하위칩으로 나눠서 실행해줘.
하위칩은 필요하면 자식 하위칩을 만들 수 있고, 모든 칩의 Worktree는 분리해야 해.
진행 상태를 확인하고 자식 결과부터 부모 순서로 검토·통합·검증해줘.
칩 목록과 다른 터미널에서 접속하는 방법도 보여줘.
```

## 리모트 주소를 외우지 않고 열기

프로젝트 루트의 다른 터미널에서:

```bash
S="$HOME/.agents/skills/parallel-worktrees/scripts"
sh "$S/list.sh" --repo "$PWD"
sh "$S/remote.sh" api --repo "$PWD"
sh "$S/attach.sh" api --repo "$PWD"
```

- `list.sh`: 부모→자식 칩 목록, 상태, 세션 ID, Worktree, 복사할 접속 명령
- `remote.sh api`: 해당 칩의 리모트 주소·전체 세션 ID·접속 명령
- `attach.sh api`: 같은 실행 중 세션을 Codex 터미널 화면으로 열기
- `watch.sh api`: 입력 없이 상태와 출력만 보기

여기서 접속에 필요한 것은 로컬 Unix 소켓 주소와 세션 ID의 조합입니다.
`attach.sh`가 둘 다 찾아주므로 직접 입력할 필요가 없습니다. 접속 화면에서 `/exit`하면 화면만 닫히고 칩은 유지됩니다.
접속은 칩 서버가 살아 있는 동안, 즉 `merge`·`stop` 전까지 가능합니다. 기록은 정리 후에도 `watch`로 확인할 수 있습니다.

## 자식 하위칩

```bash
sh "$S/start.sh" api --repo "$PWD" --sandbox workspace-write --prompt 'API 작업. 필요하면 자식 칩을 만들고 결과를 먼저 통합해줘.'
sh "$S/start.sh" api-db --repo "$PWD" --parent api --prompt 'DB 부분을 구현·검증·커밋해줘.'
sh "$S/list.sh" --repo "$PWD"
```

하위칩 내부에서 자신의 Worktree를 `--repo`로 넘겨 자식을 생성해도 부모 관계가 자동 기록됩니다.
자식은 부모의 현재 커밋에서 분기합니다. 따라서 자식 생성 전 부모의 작업 내용이 커밋돼 있고 Worktree가 깨끗해야 합니다.
자식 결과는 **자식→해당 부모→상위 부모** 순서로 합칩니다. 자식 Worktree가 남아 있으면 부모 정리를 거부합니다.

## 상위칩 자동 재개

```text
자식 턴 완료/실패 → 영구 outbox → 상위 컨트롤러 inbox
→ 메인 실행 중: 수신 순서대로 큐에 보관, 현재 턴 유지
→ 메인 응답 종료: turn/start로 같은 세션에서 알림 처리
→ 메인이 사용자에게 칩 이름·완료/실패·결과 요약 보고
```

상위 모델이 `status`·`wait`를 반복 호출할 필요는 없습니다. 승인·입력 대기 중에는 알림을 보관하며 자동 승인하지 않습니다.
여러 메시지가 대기 중이면 수신 순서대로 한 번에 전달하고, 알림 처리 중 도착한 메시지는 다음 알림 턴으로 넘깁니다.
알림의 기본 동작은 사용자 보고이며, 알림 자체가 하위칩 회신·추가 작업·자동 병합을 요청하지 않습니다.
완료는 모델 턴 종료를 뜻하므로, 상위는 실제 변경·검사·통합 상태를 검토해야 합니다.

스킬이 만든 부모→자식 관계는 자동 연결됩니다. **스킬 밖에서 시작한 최상위 세션**은 자식 생성 전에 한 번 등록하세요.
해당 세션이 실행되는 App Server의 접근 가능한 Unix WebSocket 주소와 세션 ID가 필요합니다.

```bash
sh "$S/bind-parent.sh" --repo "$PWD" --remote unix:///absolute/parent.sock --session PARENT_SESSION_ID
sh "$S/start.sh" api --repo "$PWD" --prompt '독립 작업을 구현·검증·커밋해줘.'
sh "$S/notifications.sh" --repo "$PWD"
# 알림 연결만 해제하며 상위 서버와 작업은 유지합니다.
sh "$S/unbind-parent.sh" --repo "$PWD"
```

세션 ID만으로 임의의 Desktop 채팅을 깨우지는 못합니다. 위 주소가 제공되지 않는 환경이나 종료된 서버에는 전달할 수 없습니다.
상위를 등록하지 않은 최상위 칩은 알림을 `unconfigured`로 기록합니다. `--notify off`로 수동 확인 방식을 선택할 수도 있습니다.
전달 실패·중복 제거·불확실한 전송 처리는 [명령 설명](references/commands.md)에 적었습니다.

승인 요청은 자동 승인하지 않습니다. 제공된 Codex나 보안 설정을 변경하지 않으며, Cofa에서의 실행 허용 여부는 해당 환경에서 확인해야 합니다.
상세 명령과 제한은 [명령 설명](references/commands.md)을 참고하세요.

## 검증

```bash
node --test tests/*.test.cjs
```

인증 정보·실행 로그·과제 자료는 공개 저장소에 올리지 마세요. 이 패키지에는 재사용 가능한 소스만 포함합니다.
