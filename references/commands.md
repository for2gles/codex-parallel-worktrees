# 하위칩 명령

`S`는 이 스킬의 `scripts` 절대 경로, `R`은 원본 프로젝트 경로입니다.
모든 명령은 Node.js 18+만 사용합니다. 실행 권한이 없어도 `sh "$S/명령.sh"`로 실행할 수 있습니다.

## 시작·조회·지시

```bash
sh "$S/doctor.sh" --repo "$R" --probe
sh "$S/start.sh" api --repo "$R" --sandbox workspace-write --prompt '작업 범위와 검증 조건'
sh "$S/start.sh" ui --repo "$R" --prompt-file /absolute/task.txt
sh "$S/list.sh" --repo "$R"
sh "$S/status.sh" api --repo "$R"
sh "$S/message.sh" api --repo "$R" --prompt '추가 조건'
sh "$S/wait.sh" api ui --repo "$R" --timeout 30
```

`doctor --probe`는 실제 Unix WebSocket 연결만 확인하며 모델 턴은 시작하지 않습니다.
인증·모델 접근·편집·대회 환경 허용까지 입증하는 검사는 아닙니다.
`start`는 `--codex /existing/codex`, `--model MODEL`, `--sandbox read-only|workspace-write`를 선택적으로 받습니다.
지정하지 않으면 기존 CLI 설정을 사용하고, 자식은 부모의 CLI·명시된 모델·요청 sandbox를 이어받습니다.
기존 camel-case sandbox 인자도 정상 wire 값으로 변환합니다. Full-access나 승인 우회 인자는 제공하지 않습니다.

## 부모→자식→손자

```bash
sh "$S/start.sh" api-db --repo "$R" --parent api --prompt 'DB 작업'
# 하위칩 내부에서는 --repo에 자신의 Worktree를 주면 부모를 자동으로 감지합니다.
sh "$S/start.sh" api-db-tests --repo /absolute/api-db/worktree --prompt '독립 테스트 작업'
```

모든 칩 ID는 저장소 안에서 유일해야 합니다. 사용했던 ID를 덮어쓰지 않습니다.
상태에 `parent_id`, `depth`, `root_repo`, `repo`(직접 부모의 통합 경로), `worktree`를 기록합니다.
자식의 기준은 **직접 부모의 현재 커밋**입니다. 대화·미커밋 변경은 자동 복제되지 않습니다.
부모 Worktree가 더러우면 자식 생성을 거부합니다. 같은 작업을 그대로 재귀 위임하지 마세요.

`wait PARENT`는 그 아래 자손도 포함하며, 어떤 자손이든 입력이 필요하면 즉시 반환합니다.
상위 칩을 멈추기 전에 실행 중인 자손부터 멈추세요. 칩 생성에 필요한 프로세스·Git·소켓 권한은 실행 환경이 판단합니다.

## 리모트 정보와 다른 터미널

```bash
sh "$S/list.sh" --repo "$R"
sh "$S/list.sh" --repo "$R" --json
sh "$S/remote.sh" api-db --repo "$R"
sh "$S/remote.sh" api-db --repo "$R" --json
sh "$S/attach.sh" api-db --repo "$R"
sh "$S/attach.sh" api-db --repo "$R" --print
sh "$S/watch.sh" api-db --repo "$R"
sh "$S/watch.sh" api-db --repo "$R" --timeout 10 --interval 0.5
```

접속에 필요한 값은 **리모트 URI와 세션 ID**입니다.
`remote --json`은 `chip`, `parent`, `session_id`, `worktree`, `remote`, `attach_command`, `terminal_command`를 반환합니다.
`attach`는 저장된 CLI로 `codex resume --remote unix://SOCKET --cd WORKTREE SESSION_ID`를 실행합니다.
새 세션을 만들거나 포크하지 않습니다. 독립된 터미널에서 동일한 실행 중 세션과 완료된 턴을 볼 수 있습니다.
TUI에서 추가 입력을 보내도 메인 컨트롤러가 같은 세션의 새 턴을 계속 추적합니다.
일반적인 폴더 신뢰·승인 화면은 정상 절차로 처리합니다. `/exit`로 TUI만 닫을 수 있습니다.

`watch`는 조회만 하며 턴을 시작하지 않습니다. Ctrl-C는 관찰 화면만 닫습니다.
`attach`는 대화형 터미널이 필요하며, 서버를 멈추는 `merge`·`stop` 전까지만 가능합니다.
병합 전에 붙어 있는 TUI를 닫으세요. `cleanup` 후 Worktree는 없어지지만 상태와 출력 기록은 유지됩니다.
실행 중인 칩을 일반 로컬 `codex resume`로 열어 경쟁하는 서버 소유자를 만들지 마세요.

## 완료 PUSH와 상위 자동 재개

기본값은 `--notify on`이며 자식이 상속합니다. 스킬 내부 부모 관계는 자동 연결됩니다.
자식 컨트롤러가 `turn/completed` 이벤트를 받아 outbox에 저장하고, 직접 부모 컨트롤러로 전송합니다.
상위 inbox에 영구 저장한 뒤 수신 확인을 반환하고, 실행 중이면 `turn/steer`, 응답이 끝났으면 같은 세션의 `turn/start`를 호출합니다.
상위 모델의 polling이나 shell hook 설치는 필요 없습니다. 서버와 컨트롤러는 살아 있어야 합니다.
명시적인 `stop`에 의한 중단은 알리지 않으며, 모델 실패·App Server 연결 실패는 실패 결과로 알립니다.
컨트롤러 자체가 강제 종료되면 그 프로세스가 알림을 보낼 수 없으므로 자동 복구를 보장하지 않습니다.

승인·사용자 입력 대기 중에는 inbox에 보관합니다. 명시적으로 처리한 뒤 전달을 재개하며 알림으로 승인 권한을 부여하지 않습니다.
하위칩은 여러 턴을 가질 수 있으므로 턴별 완료가 각각 전달됩니다. 자동 재개된 상위도 자기 턴을 끝내면 다시 자신의 부모에게 결과를 보냅니다.
완료 알림 자체가 Git 병합을 실행하지는 않습니다. 상위 모델이 원래 작업 범위 안에서 결과를 검토하고 helper로 통합합니다.

외부에서 시작한 최상위 세션은 자식을 만들기 **전에** 한 번 연결합니다.

```bash
sh "$S/bind-parent.sh" --repo "$R" --remote unix:///absolute/parent.sock --session PARENT_SESSION_ID
sh "$S/bind-parent.sh" --repo "$R"  # 현재 연결과 상태 조회
sh "$S/start.sh" api --repo "$R" --prompt '구현·검증·커밋'
sh "$S/notifications.sh" --repo "$R"
sh "$S/notifications.sh" api --repo "$R"
sh "$S/unbind-parent.sh" --repo "$R"
```

등록은 기존 세션에 구독만 하며 새 모델 턴을 시작하지 않습니다. `unbind-parent`는 이 어댑터만 연결 해제하고 상위를 중단하지 않습니다.
로컬 Unix WebSocket과 세션 ID를 실제 상위 실행 환경에서 확보해야 합니다. 관리되는 칩 주소는 `remote.sh`로 조회할 수 있습니다.
일반 Desktop/CLI가 접근 가능한 App Server 주소를 노출한다고 가정하지 마세요. 세션 ID만으로 연결할 수 없습니다.
기존 세션의 서버를 재시작하거나 임의 채팅으로 우회 전달하지 않습니다. 등록 후 만든 최상위 칩만 이 연결을 사용합니다.
최상위 연결이 없으면 outbox는 `unconfigured`입니다. `--notify off`는 자동 전송을 끄며 기존 `status`·`wait` 흐름을 유지합니다.

`notifications`는 모든 칩과 등록된 최상위 어댑터의 inbox/outbox를 반환합니다.

| 위치 | 상태 | 의미 |
|---|---|---|
| outbox | pending / sending | 상위 컨트롤러 전송 대기 / 시도 중 |
| outbox | accepted | 상위 inbox 저장 확인. 모델의 처리 완료를 뜻하지 않음 |
| outbox | failed / unconfigured | 전송 실패 / 상위 미등록 |
| inbox | queued | 모델 전달 대기. 승인 대기 중에도 유지 |
| inbox | sending / delivered | 모델 RPC 시도 중 / 입력 수락 확인 |
| inbox | failed | 서버가 입력을 명시적으로 거절 |
| inbox | ambiguous | timeout·연결 끊김으로 입력 수락 여부 불명 |

컨트롤러 전송은 최대 3번 시도하며, 칩 ID+턴 ID 기반 `event_id`로 수신 중복을 제거합니다.
모델 입력을 전송한 뒤 응답이 끊기면 정확히 한 번 처리를 보장할 수 없습니다. `ambiguous`나 남은 `sending`을 자동 재생하지 않습니다.
이벤트·세션 상태를 확인해 중복 처리를 피하세요. 살아 있는 컨트롤러의 명확한 `failed`만 다음 명령으로 재시도할 수 있습니다.

```bash
sh "$S/notify-retry.sh" api --repo "$R"
sh "$S/notify-retry.sh" '$root' --repo "$R"  # 외부 최상위 어댑터
```

상위 응답이 끝난 것과 서버가 종료된 것은 다릅니다. 전자는 자동 재개하고, 후자는 실패로 남깁니다.
진행 상태 조회 자체는 계속 `status`, `watch`, `wait`를 사용합니다.

## 입력·승인

`waiting_for_input`의 `pending_requests`에는 정확한 요청 ID·method·params가 있습니다.
사용자가 허용한 결정이나 명시적인 답변에만 다음 명령을 사용합니다.

```bash
sh "$S/respond.sh" api 123 --repo "$R" --decision accept
sh "$S/respond.sh" api 123 --repo "$R" --decision decline
sh "$S/respond.sh" api REQUEST_ID --repo "$R" --json-file /absolute/answer.json
```

`--decision`은 command/file 승인에만 사용합니다. 그 외 요청의 result는 해당 CLI 버전 스키마에 맞는 JSON을 직접 전달합니다.
알 수 없는 요청은 자동 처리하지 않습니다. RPC timeout 뒤에는 이미 입력이 수신됐을 수 있으므로 상태와 이벤트부터 확인하세요.

## 통합·정리

```bash
sh "$S/merge.sh" api-db-tests --repo "$R"
sh "$S/cleanup.sh" api-db-tests --repo "$R"
sh "$S/merge.sh" api-db --repo "$R"
sh "$S/cleanup.sh" api-db --repo "$R"
sh "$S/merge.sh" api --repo "$R"
# 원본에서 통합 검증을 실행한 뒤:
sh "$S/cleanup.sh" api --repo "$R"
```

통합 대상은 각 칩에 기록된 **직접 부모 Worktree**입니다. 원본에서 명령을 실행해도 자식을 최상위로 건너뛰어 병합하지 않습니다.
완료·커밋·깨끗한 작업 상태를 검사하고, 자손 Worktree가 남은 부모의 병합·정리는 거부합니다.
충돌은 그대로 두므로 직접 해결해 커밋하거나 `git merge --abort`로 중단하세요.
정리는 강제 삭제하지 않으며 미반영 커밋·사용자 변경을 보호합니다. 브랜치와 진단 기록은 보존합니다.

```bash
sh "$S/stop.sh" api-db-tests --repo "$R"
sh "$S/stop.sh" api-db --repo "$R"
sh "$S/stop.sh" api --repo "$R"
```

## 상태·실패·제한

`wait` 종료 코드: 0=선택한 모든 칩/자손의 턴 완료, 1=실패·중단·연결 끊김, 2=대기 시간 만료, 3=승인/입력 필요.
`completed`는 모델 턴 종료만 뜻합니다. 구현·테스트·통합 성공은 결과를 별도로 검증해야 합니다.

런타임은 `$(git rev-parse --git-common-dir)/parallel-worktrees/ID/`에 저장합니다.
`state.json`, `events.jsonl`, `messages.log`, `controller.log`, `app-server.stderr.log`, `inbox/`, `outbox/`는 프롬프트와 작업 내용을 포함할 수 있으므로 공개하면 안 됩니다.
Unix 소켓은 사용자 전용 0700 임시 디렉터리와 0600 소켓으로 보호합니다. TCP 포트는 열지 않습니다.

원자적 디렉터리 잠금(`*.lockdir`)은 프로세스가 비정상 종료되면 남을 수 있습니다. 자동 삭제·임의 PID 종료·자동 재실행은 하지 않습니다.
연결 끊김이나 잠금 잔존 시 실제 프로세스와 Worktree를 조사한 뒤 복구해야 합니다. 실패한 칩도 진단을 위해 보존합니다.
중단된 컨트롤러는 `attach`나 `message`를 받지 못합니다. 종료된 서버를 자동으로 다시 시작하지 않습니다.
Codex 프로토콜은 [공식 App Server 문서](https://learn.chatgpt.com/docs/app-server)를 참고합니다.
