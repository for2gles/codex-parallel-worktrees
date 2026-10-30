# 앱 전용 실행 절차

`A`는 설치된 `scripts/app.cjs`의 절대 경로, `R`은 대상 Git 저장소입니다.
스크립트는 기록과 메시지 준비만 담당합니다. 채팅·Worktree·메시지 전송은 실제 Codex 앱 도구를 호출해야 합니다.

## 내 소유 하위칩과 새 생성의 구분

처음부터 현재 세션의 실제 ID·호스트로 자기 소유 목록을 조회합니다. 런타임이 제공한 `CODEX_THREAD_ID`를 사용할 수 있으며,
호스트 ID는 실제 앱 문맥에서 확인합니다. 현재 세션을 제목 검색이나 전역 목록의 첫 번째 결과로 추정하지 마세요.

```bash
node "$A" owned --repo "$R" --owner-thread CURRENT_PARENT_THREAD_ID --owner-host ACTUAL_HOST_ID
```

이 명령은 해당 부모의 **직접 자식만** 반환합니다. 소유 관계는 호스트+부모 세션 ID로 고정하며 이름이 같아도 다른 부모의 칩을 고르지 않습니다.
정본은 Git common dir의 `parallel-worktrees-app/state.json`, 세션별 목록은 `parallel-worktrees-app/owners/<owner-hash>.json`입니다.
정확한 경로는 `owned`의 `registry_file`·`owner_file`에 나오므로 해시를 외울 필요가 없습니다. 목록이 비어 있어도 소유자 파일을 생성합니다.
소유자 파일은 정본에서 갱신되는 조회용 기록이며 변경은 스크립트로 처리합니다. 기존 schema 1의 부모 정보는 소유자별 색인으로 이행됩니다.
이름만 보고 과거 CLI 하위칩을 가져오거나 소유자를 바꾸지 않습니다.

- `하위칩 생성하고 hi라고 보내줘`: 새 채팅·새 Worktree를 생성하고 초기 프롬프트에 hi를 넣습니다.
- `내 api 칩에 hi라고 보내줘`: 내 목록에서 api를 고르고 실제 앱 상태를 확인합니다.
- `하위칩에 hi라고 보내줘`: hi는 메시지 본문입니다. 현재 대화에서 새 생성으로 합의했다면 새로 생성하고,
  기존 대상이 불명확하면 확인합니다. 전역/보관 목록에서 이름이 hi인 채팅을 골라 보내지 않습니다.

기존 대상에 보내기 전 다음 검증을 사용합니다. `--thread-state`는 실제 앱 조회 결과여야 합니다.

```bash
node "$A" target api --repo "$R" --owner-thread CURRENT_PARENT_THREAD_ID \
  --owner-host ACTUAL_HOST_ID --thread-state active --message-file /absolute/message.txt
```

소유자가 다르면 거부하고, archived/unknown이면 메시지 요청을 만들지 않습니다. active는 보관되지 않았다는 뜻이며 모델이 idle이라는 뜻은 아닙니다.
실제 전송은 직접적인 사용자 허가 아래 네이티브 도구로 합니다. 보관 상태 때문에 거부되면 자동 보관 해제·restore·resume을 하지 마세요.
보관 해제는 사용자가 그 채팅을 명시적으로 다시 열라고 요청한 경우에만 앱에서 처리하며, 소유 관계 변경과는 별개입니다.

## 네이티브 생성

`list_projects`에서 요청한 Git 프로젝트를 찾았으면 다음 형태로 실제 도구를 호출합니다.

```json
{
  "target": {
    "type": "project",
    "projectId": "ACTUAL_PROJECT_ID",
    "environment": { "type": "worktree" }
  },
  "title": "하위칩 · 로그인 API",
  "prompt": "You are 하위칩 api. 독립 작업 범위·확인 조건·상위 채팅 정보와 완료 보고 절차"
}
```

`title`은 상위칩이 정합니다. 사용자가 제목을 지정하면 그대로 쓰고, 없으면 `하위칩 · 로그인 테스트`처럼 짧은 작업명을 선택합니다.
역할 설명 `You are 하위칩 ...`은 prompt에만 넣습니다. projectless 생성에도 title을 넘기고, 실제 생성된 제목을 확인합니다.
제목이 지시문으로 잡히거나 요청된 fork의 제목을 지정해야 하면 준비된 실제 threadId로 `set_thread_title`을 호출합니다.
사용자가 이후 바꾼 제목은 자동으로 덮어쓰지 않습니다.

저장되지 않은 저장소는 요청된 별도 projectless 채팅을 생성하고, 그 채팅에서 첫 작업으로 `create_worktree`를 사용합니다.
`sourceRoot`와 `ref`는 승인된 실제 소스/커밋이어야 합니다. `allowAsync: true`로 요청하고 반환된 상태를 확인하세요.
설정 실패 시 코드를 시작하지 않습니다. 모델 제한으로 첫 턴이 시작되지 않으면 Worktree도 생성됐다고 가정하지 않습니다.
`create_worktree`의 경로를 해당 채팅에 명시적으로 사용하고 등록 성공을 확인합니다.

```bash
node "$A" doctor --repo "$R"
node "$A" register api --repo "$R" \
  --thread ACTUAL_THREAD_ID --host ACTUAL_HOST_ID --title '하위칩 · 로그인 API' \
  --source /absolute/source --worktree /actual/app/worktree \
  --parent-thread ACTUAL_PARENT_THREAD_ID --parent-host ACTUAL_PARENT_HOST_ID \
  --authorization-thread ACTUAL_HUMAN_REQUEST_THREAD_ID
node "$A" register api-db --repo "$R" \
  --thread ACTUAL_CHILD_THREAD_ID --host ACTUAL_HOST_ID \
  --source /actual/app/worktree --worktree /actual/child/worktree \
  --parent api --authorization-thread ACTUAL_HUMAN_REQUEST_THREAD_ID
node "$A" list --repo "$R" --owner-thread CURRENT_PARENT_THREAD_ID --owner-host ACTUAL_HOST_ID
```

ID·소스·부모·허가 근거를 임의로 채우지 마세요. `register`는 Git 구조와 중복을 검사하지만, 앱이 생성한 사실이나
사용자 허가를 암호학적으로 인증하는 API는 아닙니다. 실제 앱 도구 결과와 사용자 요청은 호출자가 확인합니다.
`list`의 `live_status: unknown`은 현재 앱 상태를 조회했다는 뜻이 아닙니다.

## 완료와 큐

작업이 끝난 칩이 완료 요약 파일을 쓰고 다음 명령을 호출합니다. 파일은 실행 기록 폴더 등 비공개 위치에 둡니다.

```bash
node "$A" complete api --repo "$R" --turn ACTUAL_TURN_ID \
  --status completed --summary-file /absolute/result.txt
node "$A" notifications --repo "$R" --owner-thread CURRENT_PARENT_THREAD_ID --owner-host ACTUAL_HOST_ID
node "$A" claim --repo "$R" --parent-thread ACTUAL_PARENT_THREAD_ID \
  --parent-host ACTUAL_PARENT_HOST_ID --parent-state busy
```

busy/unknown이면 전송 요청을 만들지 않고 큐를 보존합니다. 실제 앱의 `wait_threads`로 부모의 현재 턴이 끝날 때까지
최대 30초씩 이벤트 대기를 합니다. 실제 부모가 idle일 때만:

```bash
node "$A" claim --repo "$R" --parent-thread ACTUAL_PARENT_THREAD_ID \
  --parent-host ACTUAL_PARENT_HOST_ID --parent-state idle
```

이 명령은 `delivery_id`, `tool: send_message_to_thread`, `arguments`를 반환합니다. 최대 16개씩 수신 순서대로 묶고,
중복 claim은 거부합니다. 반환 직후 부모 상태와 직접적인 사용자 허가를 확인하고 실제 도구를 호출합니다.
부모가 다시 바빠졌으면 보관한 `arguments`를 유지하고 기다립니다. 새 claim으로 이전 배치를 대체하지 마세요.
native 도구의 응답을 파일로 저장하고 결과를 기록합니다.

```bash
node "$A" ack --repo "$R" --delivery ACTUAL_DELIVERY_ID \
  --status accepted --receipt-file /absolute/native-tool-receipt.txt
```

| 상태 | 의미 |
|---|---|
| queued | 아직 전송되지 않은 영구 큐 |
| prepared | 한 호출자가 전송 배치를 확보. 아직 수락 확인 없음 |
| accepted | 네이티브 도구가 입력을 수락. 사용자 보고 완료를 뜻하지 않음 |
| failed | 입력 수락 전에 명확하게 거부됨 |
| ambiguous | 시간 초과·연결 끊김 등으로 수락 여부 불명 |

부모는 사용자에게 완료/실패·결과를 보고합니다. `wait_threads`의 실제 후속 응답이 보고 증거이며,
`accepted`만 보고 성공으로 취급하지 않습니다. 모델 사용량 제한이나 실패는 성공 보고로 바꾸지 마세요.
명확한 실패만 `retry --event ACTUAL_EVENT_ID --repo "$R"`로 재시도할 수 있습니다.
prepared/ambiguous/accepted는 자동으로 재생하거나 잠금을 삭제하지 않습니다. `wait_threads`/`read_thread`로 실제 이력을 확인하세요.

현재의 대기는 완료한 칩의 살아 있는 모델 턴이 수행합니다. 별도 background dispatcher는 없습니다.
모든 모델 턴이 종료·중단된 뒤 큐 파일만으로 자동 재개되지는 않습니다. 메인은 칩을 시작한 뒤 자기 턴을 끝내
idle 상태가 될 수 있어야 합니다. 메인이 자식을 기다리고 자식이 메인 idle을 기다리는 구조를 만들지 마세요.
부모 상태 확인과 메시지 전송은 원자적 단일 연산이 아니므로, 상태 확인 사이의 경합과 앱 내부 큐 동작은 실검증이 필요합니다.

## 다른 터미널과 정리

`remote`는 실제 앱 채팅·호스트·Worktree를 보여줍니다. 현재 앱이 공식 도구에 리모트 엔드포인트를 반환하지 않아
같은 실행 중 세션을 여는 터미널 명령을 생성하지 않습니다. `codex resume ID`나 기본 `unix://`가 같은 서버라고 가정하지 마세요.
요청한 같은 세션의 타 터미널 접속은 앱 모드에서 아직 충족하지 못한 항목입니다.

앱에서 생성한 Worktree는 앱의 archive/restore 도구로 관리합니다. 다른 채팅 소유의 Worktree는 임의로 연결·삭제하지 않습니다.
병합이 요청되면 별도 브랜치가 없는 detached HEAD 커밋도 검토한 뒤 직접 부모에 통합할 수 있습니다.
앱 정책에 따른 자동 정리나 소유권 제한을 우회하지 마세요.
허가된 보관 처리가 성공하면 실제 도구 receipt를 파일로 저장하고 로컬 목록에도 반영합니다.

```bash
node "$A" archive-record api --repo "$R" --owner-thread CURRENT_PARENT_THREAD_ID \
  --owner-host ACTUAL_HOST_ID --receipt-file /absolute/archive-receipt.json
```

receipt는 정확한 threadId와 archived=true를 확인한 앱 응답이어야 합니다. 보관 뒤에도 소유 이력은 유지하고 기본 목록에서는 제외합니다.
사용자가 해당 채팅의 재개를 직접 요청해 앱에서 보관 해제에 성공한 경우에만, archived=false인 정확한 receipt로
`restore-record`를 호출해 조회 기록을 갱신할 수 있습니다. 이 명령은 앱의 보관을 해제하지 않으며 자동 복구 절차로 사용하지 않습니다.

런타임 기록과 소유자별 목록은 Git common dir의 `parallel-worktrees-app/`에 보관합니다. 이전 CLI 기록과 분리하며
기존 세션·Worktree·소켓을 옮기거나 종료하지 않습니다. 실행 중인 구버전 칩은 해당 버전의 절차로 별도 정리합니다.
이 폴더의 요약·경로·대화 ID·도구 receipt는 공개하거나 커밋하지 않습니다.
