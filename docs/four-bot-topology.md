# Four-bot Discord topology

## 계정 분리

| 역할 | Discord account | 책임 |
| --- | --- | --- |
| orchestrator | Orchestrator Bot | `/help`, 관리 UI, 목표·통합 상태 |
| backend | Backend Bot | backend/data/infra/performance 작업 기록 |
| frontend | Frontend Bot | UI/design/frontend 작업 기록 |
| reviewer | Reviewer Bot | diff 검토, 재작업 요청, 판정 기록 |

역할 구분은 webhook display name이 아니라 서로 다른 bot account로 보장합니다.

## Supervisor

```text
RoleBotSupervisor
  ├─ Client(orchestrator token)
  ├─ Client(backend token)
  ├─ Client(frontend token)
  └─ Client(reviewer token)
```

Startup invariant:

1. 네 token이 모두 존재한다.
2. token 문자열이 모두 다르다.
3. login 후 Discord user ID가 모두 다르다.
4. 하나라도 login/command registration에 실패하면 연결된 client를 종료한다.

## Command ownership

```text
Orchestrator application
  /help
  /providers
  /role-models
  /role-bots
  /project
  /goal
  /spec
  /resume
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

관리 command를 worker application에 복제하지 않습니다.

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

Output router는 task마다 메시지 하나를 만들고 terminal output을 일정 간격으로 edit합니다. 완료 시 같은 메시지에 commit과 요약을 반영합니다.

## Ledger

각 lifecycle transition은 `role_work_events`에 저장합니다.

```text
task.started
task.completed
task.failed
task.interrupted
```

조회 조건은 `(guild_id, thread_id, role)`입니다.
