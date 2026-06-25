# clcodex Control Center

`/admin`은 오케스트레이터 Discord application에만 등록되는 통합 관리자 UI 진입점입니다. 서버 소유자 또는 `Administrator`가 실행하면 Discord Activity를 직접 열며, URL이나 로컬 서버 주소를 메시지로 반환하지 않습니다.

## 전송 구조

```text
/admin
  → guild Administrator 검사
  → one-use grant
  → Discord Activity 실행
  → Discord OAuth + PKCE
  → pinned E2EE handshake
  → public relay의 opaque WebSocket routing
  → outbound-only local orchestrator
  → 현재 Administrator 권한 재검사
  → allowlisted control-plane RPC
```

Activity와 relay 배포는 [Outbound Activity relay](activity-relay.md)를 참고합니다.

## 화면 구성

| 탭 | 관리 대상 |
| --- | --- |
| 개요 | 공급자 수, 역할 바인딩, 실행 중 세션, 현재 포럼 스레드의 최근 사양 |
| 공급자 | proxy 등록, 인증정보, 연결 시험, model catalog 동기화, 초기 역할 바인딩 |
| Codex | 역할별 공급자·모델, approval policy, sandbox, reasoning effort, verbosity, web search |
| Claude Code | 역할별 공급자·모델, permission mode, effort, allowed/disallowed tools, fallback model |
| 오케스트레이션 | spec workflow, preset, 자동 실행, 최대 병렬도, 실패·재개 정책 |
| 세션·이력 | 실행 중 역할 세션과 provider/runtime 설정 변경 감사 로그 |
| 도움말 | 오케스트레이터 관리 명령과 보안 경계 |

## Open Codex에서 차용한 상호작용

`open-codex`의 terminal UI를 그대로 복제하지 않고 다음 상호작용을 웹 UI에 적용했습니다.

- 공급자에서 model catalog를 비동기로 조회합니다.
- 모델 검색 결과에서 현재 선택값을 최상단에 유지합니다.
- 역할마다 model과 실행 승인 정책을 한 카드에서 선택합니다.
- 실행이 시작된 session의 provider/model/runtime policy는 고정하고 새 session부터 변경을 적용합니다.
- 세션과 설정 변경 이력을 별도 화면에서 조회합니다.
- 도움말을 UI 내부와 Discord `/help` 양쪽에서 제공합니다.

## Provider 등록 흐름

```text
공급자 탭
  → Claude Code 또는 Codex 선택
  → Base URL과 model-list path 입력
  → 인증 방식 dropdown 선택
      Bearer Token | API Key | Basic Auth
  → credential password input
  → 초기 모델 ID 한 개 입력(선택)
  → 연결 테스트 및 model catalog 조회
  → 저장할 model 선택
  → 역할별 초기 model binding 선택
  → 공급자·암호화 credential·catalog·binding 저장
```

인증 방식과 credential은 서로 다른 필드입니다. API Key는 header 이름을, Basic Auth는 username을 추가로 표시합니다. credential 원문은 저장 후 다시 UI에 표시하지 않습니다.

## Codex 역할 설정

각 역할 카드에서 다음 값을 저장합니다.

- 적용 범위: 서버 전체 기본값 또는 현재 포럼 스레드 override
- provider와 model
- `approval_policy`: `untrusted`, `on-request`, `never`
- `sandbox_mode`: `read-only`, `workspace-write`, `danger-full-access`
- `model_reasoning_effort`: `minimal`, `low`, `medium`, `high`, `xhigh`
- `model_verbosity`: `low`, `medium`, `high`
- `web_search`: `disabled`, `cached`, `live`

저장된 값은 격리된 `CODEX_HOME/config.toml` 생성 시 반영됩니다. Reviewer는 항상 `read-only`와 `never`, Orchestrator는 항상 `read-only`로 강제되므로 UI에서 쓰기 경계를 완화할 수 없습니다.

## Claude Code 역할 설정

각 역할 카드에서 다음 값을 저장합니다.

- 적용 범위: 서버 전체 기본값 또는 현재 포럼 스레드 override
- provider와 model
- permission mode
- effort
- allowed tools
- disallowed tools
- fallback model

새 session을 시작할 때 해당 설정이 격리된 Claude Code CLI 인자로 변환됩니다. Reviewer는 항상 `plan`이며 `Edit`, `Write`, `NotebookEdit`가 금지됩니다. Orchestrator에서 `bypassPermissions`를 선택해도 `plan`으로 정규화됩니다.

## 전체 오케스트레이션 선택

| Preset | 기본 workflow | 자동 실행 | 최대 병렬도 | 용도 |
| --- | --- | ---: | ---: | --- |
| `strict-spec` | Requirements → Design → Tasks | 아니요 | 2 | 승인 gate를 모두 거치는 보수적 작업 |
| `balanced` | Requirements → Design → Tasks | 아니요 | 3 | 일반적인 기능 개발 |
| `rapid` | Quick Plan → Tasks | 예 | 4 | 작은 변경과 빠른 반복 |
| `review-heavy` | Design → Requirements → Tasks | 아니요 | 2 | 설계 검토 비중이 큰 변경 |

Preset 선택 후 workflow, 최대 병렬 에이전트, 최종 승인 후 자동 실행, 실패 시 spec 차단, `/resume` 복구를 조정할 수 있습니다.

변경할 수 없는 invariant:

- Reviewer 검토 필수
- Coder 이의 제기 시 Orchestrator 자동 중재
- Merge Queue의 직렬 cherry-pick
- Orchestrator와 Reviewer의 제품 코드 쓰기 제한

## 범위와 상속

```text
현재 포럼 스레드 override
          ↓ 없으면
서버 전체 기본값
          ↓ 없으면
내장 안전 기본값
```

포럼 스레드에서 `/admin`을 실행하면 grant와 E2EE transcript가 해당 thread ID에 결합됩니다. 다른 channel에서 열린 Activity가 그 grant를 사용할 수 없습니다. 일반 guild channel에서 실행하면 global scope만 사용할 수 있습니다.

## 권한과 session 보안

- `/admin`의 `default_member_permissions`는 `Administrator`입니다.
- command 실행 시 guild owner/Administrator 권한을 검사합니다.
- Activity 연결 시 로컬 오케스트레이터가 Discord API로 권한을 다시 조회합니다.
- 모든 관리 RPC 실행 직전 권한을 다시 조회하므로 세션 도중 권한이 회수되면 종료됩니다.
- `/admin` grant는 guild/user/thread에 묶이고 한 번만 소비됩니다.
- OAuth authorization code는 PKCE(S256)로 교환합니다.
- relay의 HTTP/WS 접근은 exact Activity Origin과 device bearer token으로 제한합니다.
- Activity는 provision된 device ECDSA public key/fingerprint를 pinning합니다.
- RPC는 ECDH(P-256), HKDF-SHA256, AES-256-GCM으로 종단간 암호화합니다.
- 방향, session ID, sequence를 AEAD additional data에 포함해 replay와 재정렬을 거부합니다.
- relay는 RPC plaintext와 provider credential을 저장하거나 해석하지 않습니다.

## 실행 중 설정 변경

Control Center의 설정은 process를 hot-swap하지 않습니다. session 시작 시 다음 값을 snapshot으로 고정합니다.

- 역할과 thread scope
- provider ID와 revision
- model ID
- Codex 또는 Claude runtime policy revision
- task/spec ID

provider를 비활성화하거나 역할 model을 변경해도 이미 실행 중인 session은 기존 snapshot으로 종료되고, 다음 session부터 새 설정을 사용합니다.
