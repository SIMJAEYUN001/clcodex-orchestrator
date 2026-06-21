# Four-bot Discord topology

## 원칙

역할 구분은 message prefix나 webhook display name이 아니라 서로 다른 Discord bot account로 보장합니다.

| 역할 | Discord account | 책임 |
| --- | --- | --- |
| orchestrator | Orchestrator Bot | 목표 수신, 관리자 UI, 계획·통합 상태 |
| backend | Backend Bot | backend/data/infra/performance 작업 기록 |
| frontend | Frontend Bot | UI/design/frontend 작업 기록 |
| reviewer | Reviewer Bot | diff 검토, 재작업 요청, 판정 기록 |

## Supervisor

```text
RoleBotSupervisor
  ├─ Client(orchestrator token)
  ├─ Client(backend token)
  ├─ Client(frontend token)
  └─ Client(reviewer token)
```

네 client는 shared SQLite와 provider resolver를 사용하지만 Discord identity, application command registry, outbound message author가 분리됩니다.

Startup invariant:

1. 네 token이 모두 존재해야 한다.
2. token 문자열이 모두 달라야 한다.
3. login 후 Discord user ID가 모두 달라야 한다.
4. 하나라도 login/command registration에 실패하면 연결된 client를 모두 종료한다.

## Command ownership

```text
Orchestrator application
  /providers
  /role-models
  /role-bots
  /orchestrator-model
  /orchestrator-history

Backend application
  /backend-model
  /backend-history

Frontend application
  /frontend-model
  /frontend-history

Reviewer application
  /reviewer-model
  /reviewer-history
```

관리 command를 worker application에 복제하지 않습니다. 동일 이름의 command를 여러 application에 등록하지 않으므로 Discord command picker에서 어느 bot의 command인지 모호해지지 않습니다.

## Work output routing

```text
ManagedHarnessRuntime.start(role=backend)
        │
        ├─ ProviderResolver → backend provider/model
        ├─ isolated PTY
        └─ RoleOutputRouter
                │
                └─ RoleBotSupervisor.send(backend, thread)
                           └─ Backend Bot message
```

Output router는 task마다 메시지 하나를 생성하고 terminal output을 일정 간격으로 edit합니다. 완료 시 같은 메시지에 commit과 요약을 반영합니다.

## Ledger

각 lifecycle transition은 `role_work_events`에 저장됩니다.

```text
task.started
task.completed
task.failed
task.interrupted
```

조회 조건은 `(guild_id, thread_id, role)`입니다. 따라서 같은 forum thread에서 병렬 실행하더라도 backend, frontend, reviewer 이력이 섞이지 않습니다.

## UI 연결 확인

`/role-models panel`의 `역할 봇 확인` 버튼은 선택한 역할 account로 현재 채널에 메시지를 전송합니다. 확인 대상은 다음 세 요소입니다.

1. Discord bot identity
2. provider/harness
3. model 및 global/thread scope

## Process isolation

기본 배포는 shared state와 command registration의 원자성을 위해 한 supervisor process에서 네 gateway client를 실행합니다. Discord account와 credential은 분리됩니다. OS process까지 역할별로 나누려면 supervisor interface를 유지한 채 role별 entrypoint를 분리할 수 있지만, shared command bus와 startup health coordination이 추가로 필요합니다.
