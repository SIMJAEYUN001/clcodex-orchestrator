# Discord 명령어

## 명령 소유권

모든 관리·사양 명령은 **오케스트레이터 bot application**에만 등록됩니다. Backend, Frontend, Reviewer application에는 자기 역할의 조회 명령만 등록됩니다.

## 오케스트레이터 application

### `/help [topic]`

전체 자체 명령어와 역할별 사용법을 ephemeral embed로 표시합니다. 일반 guild member도 사용할 수 있지만 관리자 전용 명령은 `🔒`로 표시됩니다.

### 관리자 전용

| 명령 | 설명 |
| --- | --- |
| `/admin` | Discord Activity Control Center 직접 실행: provider, Codex, Claude Code, 역할 model, orchestration, session/audit |
| `/providers panel` | 동일한 Discord Activity를 여는 provider 빠른 진입점 |
| `/providers audit` | provider 설정 변경 감사 로그 |
| `/role-models panel` | 역할별 global/thread provider/model binding |
| `/role-models status` | 현재 채널의 실효 역할 routing 확인 |
| `/role-bots status` | 네 역할 bot account 연결 상태 확인 |
| `/project status` | 현재 forum thread의 프로젝트 연결 확인 |
| `/project create` | 내부 Git 프로젝트 생성 및 thread 연결 |
| `/project bind` | 서버의 기존 Git 프로젝트 연결 |
| `/project delete` | 프로젝트 연결 또는 관리 대상 파일 제거 |

`/admin`을 포함한 위 명령은 서버 소유자 또는 Discord `Administrator`만 실행할 수 있습니다. `/admin`은 URL 대신 Activity를 직접 실행하며, DM에서는 비활성화되고 worker application에는 등록되지 않습니다.

### 사양 기반 실행

| 명령 | 설명 |
| --- | --- |
| `/goal` | 목표를 requirements/design/tasks workflow로 시작 |
| `/spec status` | 현재 spec phase, 상태, task 확인 |
| `/spec approve` | 현재 planning artifact 승인 |
| `/spec run` | 승인된 task manifest 실행 |
| `/spec sync` | task manifest와 workflow 문서 재생성 |
| `/spec files` | spec artifact 경로 확인 |
| `/spec cancel` | 현재 spec 취소 |
| `/resume` | 중단된 planning/task/review/자동 중재 session 재개 |

`/goal`, `/spec`의 변경 작업은 spec 생성자 또는 서버 Administrator가 수행합니다.

### `/spec mediate`의 제한

정상 흐름에서는 사용하지 않습니다.

```text
review.verdict(rework)
  → coder 자동 재배정
  → dispute.raise
  → orchestrator 자동 중재 session
  → dispute.resolve
  → coder 재작업 또는 reviewer 재호출
```

`/spec mediate`는 오케스트레이터 하네스가 종료되거나 구조화 `dispute.resolve`를 제출하지 못했을 때만 사용하는 Administrator 비상 override입니다.

### 오케스트레이터 역할 조회

- `/orchestrator-model`
- `/orchestrator-history [limit]`

## Backend application

- `/backend-model`
- `/backend-history [limit]`

## Frontend application

- `/frontend-model`
- `/frontend-history [limit]`

## Reviewer application

- `/reviewer-model`
- `/reviewer-history [limit]`

## 등록 invariant

```text
management/spec command → orchestrator application only
role work/read command   → owning role application only
```

Startup 시 각 application의 guild command 목록을 이 정의로 교체하므로 이전 버전에서 worker bot에 잘못 등록된 관리 명령도 제거됩니다.
