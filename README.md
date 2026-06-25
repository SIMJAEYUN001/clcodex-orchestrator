# clcodex-orchestrator

Discord 포럼 스레드를 프로젝트 단위로 사용하고, 공식 Claude Code·Codex 하네스를 **네 개의 역할별 Discord 봇**으로 운용하는 사양 기반 멀티에이전트 control plane입니다.

```text
Discord Forum Thread
        │
        ├─ Orchestrator Bot ─ 목표 수집, 사양서·워크플로 문서, 관리자 UI, 단일 통합
        ├─ Backend Bot      ─ API·데이터·DB·인프라·성능 task
        ├─ Frontend Bot     ─ UI·상호작용·접근성·스타일 task
        └─ Reviewer Bot     ─ diff·요구사항·회귀 검토, 재작업 판정
                  │
                  ▼
       requirements/design/tasks
                  │
          dependency task waves
        ┌─────────┴─────────┐
  backend worktree    frontend worktree
        └─────────┬─────────┘
             Merge Queue
                  │
          Single Integrator
                  │
      검증 → review → main → optional push
```

핵심 원칙은 다음과 같습니다.

- 각 역할은 서로 다른 Discord Application/Bot 계정을 사용합니다.
- 모든 관리·설정 명령은 오케스트레이터 봇에만 등록됩니다.
- 오케스트레이터는 제품 코드를 직접 수정하지 않고 사양·워크플로 문서를 관리합니다.
- 백엔드·프론트엔드 작업은 승인된 task manifest의 역할, 의존성, 파일 범위, 수용 기준을 기준으로 배정됩니다.
- reviewer는 통합 후보의 읽기 전용 snapshot과 diff만 검토합니다.
- 독립 task는 별도 Git worktree에서 병렬 실행되고, merge queue는 하나의 integrator가 직렬 처리합니다.
- 완료·중단·리뷰 판정은 자연어 파싱이 아니라 로컬 command tool event로 전달됩니다.
- Claude Code와 Codex는 프로젝트 내부 `.harness/`에만 설치하고, 사용자 전역 설치·설정·세션을 수정하지 않습니다.

## 1. 실행 구성

### Discord 봇 4개

| 역할 | Discord 계정 | 주요 책임 |
| --- | --- | --- |
| orchestrator | Orchestrator Bot | `/help`, 관리자 명령, `/goal`, 사양 승인, 통합 상태 |
| backend | Backend Bot | 백엔드 task 진행·완료·commit 기록 |
| frontend | Frontend Bot | 프론트엔드 task 진행·완료·commit 기록 |
| reviewer | Reviewer Bot | 검토 결과·재작업 요청·판정 기록 |

Supervisor process는 네 Discord client를 함께 관리하지만, 메시지는 각 역할 계정이 직접 전송합니다. 토큰 문자열 또는 로그인 후 Discord user ID가 중복되면 시작을 거부합니다.

### 하네스 격리

```text
.harness/
├── packages/node_modules/@anthropic-ai/claude-code
├── packages/node_modules/@openai/codex
├── bin/claude
├── bin/codex
└── state/...

.runtime/
├── state.sqlite
├── harness-state/<harness>/<provider>/<session>/
├── planning/<spec>/snapshot
├── reviews/<spec>/snapshot
├── worktrees/<spec>/<task>
└── integration/<spec>
```

각 session은 별도의 `HOME`, XDG 디렉터리, `CLAUDE_CONFIG_DIR` 또는 `CODEX_HOME`을 사용합니다. 공식 CLI에 전달되는 credential은 upstream API key가 아니라 해당 session 전용 localhost gateway token입니다.

## 2. 설치

요구사항:

- Node.js 22.13 이상
- Git
- Linux 또는 macOS 권장
- 동일 Discord guild에 초대한 서로 다른 봇 네 개
- 오케스트레이터 Discord application의 Activities 활성화
- 정적 Activity를 제공할 HTTPS origin
- HTTPS/WSS를 제공하는 공개 relay 한 개

기본 설치:

```bash
npm install
npm run harness:install
cp .env.example .env
```

`npm run harness:install`은 `npm -g`를 사용하지 않습니다.

### Discord 봇 권한

각 봇에 다음 권한을 부여합니다.

- View Channels
- Send Messages
- Send Messages in Threads
- Read Message History
- Use Application Commands
- Embed Links
- Attach Files

Message Content privileged intent는 사용하지 않습니다. `.env`의 네 token은 반드시 서로 달라야 합니다.

```dotenv
DISCORD_GUILD_ID=123456789012345678
DISCORD_FORUM_CHANNEL_ID=123456789012345679
DISCORD_ORCHESTRATOR_BOT_TOKEN=...
DISCORD_BACKEND_BOT_TOKEN=...
DISCORD_FRONTEND_BOT_TOKEN=...
DISCORD_REVIEWER_BOT_TOKEN=...
```

### Activity relay 프로비저닝

다음 명령은 installation ID, outbound device token, device signing key, Activity 공개 설정을 생성합니다.

```bash
npm run admin:provision -- \
  --discord-client-id 123456789012345678 \
  --relay-http-url https://relay.example.com \
  --relay-ws-url wss://relay.example.com \
  --activity-origin https://activity.example.com
```

생성 결과:

```text
.runtime/admin-relay/
├── provisioning.json              # mode 0600
├── device-signing-private.jwk     # mode 0600
├── orchestrator.env               # 로컬 오케스트레이터용
└── relay.env                      # 공개 relay용; client secret 추가 필요

activity/public/config.json         # 공개키와 relay 주소만 포함
```

1. `.runtime/admin-relay/orchestrator.env` 값을 로컬 `.env`에 반영합니다.
2. `relay.env`의 `RELAY_DISCORD_CLIENT_SECRET`을 채운 뒤 공개 relay 배포 환경에 넣습니다.
3. Activity를 빌드해 정적 호스팅에 배포합니다.

```bash
npm run activity:build
# dist/activity/를 activity.example.com에 배포
```

4. Discord Developer Portal에서 Activity URL Mapping을 정적 Activity origin에 연결합니다.
5. relay는 TLS terminator 뒤에서 실행합니다.

```bash
cp .env.relay.example .env.relay
# 또는 생성된 relay.env 사용
npm run relay
```

6. 로컬 오케스트레이터를 시작합니다.

```bash
npm run check
npm start
```

기본 `activity-relay` 모드에서 로컬 오케스트레이터는 공개 relay로 **outbound WSS 연결만** 생성합니다. 관리용 inbound HTTP listener, 포트포워딩, 공개 IP 또는 reverse tunnel은 필요하지 않습니다. 상세 배포 절차는 [Activity relay](docs/activity-relay.md)를 참고합니다.

## 3. 관리자 명령 소유권

모든 관리 명령은 오케스트레이터 application의 guild command로만 등록됩니다.

```text
/help [topic]
/admin
/providers panel
/providers audit
/role-models panel
/role-models status
/role-bots status
/project status|create|bind|delete
/goal
/spec status|approve|run|sync|mediate|files|cancel
/resume
/orchestrator-model
/orchestrator-history
```

- `/admin`, `/providers`, `/role-models`, `/role-bots`, `/project`: guild owner 또는 Discord `Administrator`만 사용
- 관리 component interaction에서도 권한과 최초 호출자를 다시 검사
- DM 명령 비활성화
- backend/frontend/reviewer application에는 `/admin`을 포함한 관리 명령 미등록

워커 봇에는 해당 역할의 조회 명령만 존재합니다.

```text
/backend-model      /backend-history
/frontend-model     /frontend-history
/reviewer-model     /reviewer-history
```

## 4. 통합 Control Center

관리의 기본 진입점은 오케스트레이터 봇의 `/admin`입니다. 명령은 URL을 응답하지 않고 Discord의 `LAUNCH_ACTIVITY` callback으로 Control Center를 클라이언트 내부에서 직접 실행합니다.

```text
Discord /admin
      │ Administrator 검사 + 1회용 grant
      ▼
Discord Activity (정적 SPA)
      │ Discord RPC OAuth code
      │ ECDH → AES-256-GCM RPC
      ▼
공개 relay ── 암호문 frame만 전달
      ▲
      │ outbound WSS :443
      │ device token + pinned signing key
로컬 오케스트레이터
      │ 현재 Administrator 권한 재검사
      └─ allowlisted 관리 RPC 실행
```

Discord Embedded App SDK의 RPC OAuth `authorize()` 호출에는 일반 웹 OAuth와 달리 `redirect_uri`를 넣지 않습니다. Activity는 RPC로 받은 `code`와 배포 설정의 `oauthRedirectUri`를 relay에 전달하고, relay는 같은 `RELAY_OAUTH_REDIRECT_URI` 값을 Discord `/oauth2/token` 교환에만 포함합니다. `oauthRedirectUri`와 `RELAY_OAUTH_REDIRECT_URI`는 Discord Developer Portal의 OAuth2 Redirects에 등록된 값과 정확히 일치해야 하며, 이 설치의 기본값은 `https://127.0.0.1`입니다. Activity RPC OAuth `authorize()`에 PKCE `code_challenge`/`code_verifier`나 `redirect_uri`를 직접 섞으면 `Redirect URI cannot be used in the RPC OAuth2 Authorization flow` 오류가 날 수 있습니다.

로컬 서버에는 관리용 inbound endpoint가 없습니다. Relay는 provider API key, Basic Auth password, 역할 binding payload를 복호화할 키를 보유하지 않습니다. Activity가 pin한 로컬 device signing public key로 핸드셰이크를 검증하고, RPC payload는 Activity와 로컬 오케스트레이터 사이에서만 복호화됩니다.

Control Center 영역:

```text
/admin
  ├─ 개요
  ├─ 공급자·credential·model catalog
  ├─ Codex 역할별 model·approval·sandbox·reasoning
  ├─ Claude Code 역할별 model·permission·effort·tools
  ├─ 전체 spec 오케스트레이션 preset·workflow·병렬도
  ├─ 실행 중 session·감사 이력
  └─ 자체 도움말
```

`open-codex`의 검색 가능한 model picker, 현재값 우선 표시, approval mode 선택, help/history overlay와 실행 중 model 고정 방식을 웹 UI 상호작용으로 재구성했습니다. `open-codex` 자체를 설치하거나 fork하지 않으며, 공식 Codex와 Claude Code 하네스는 프로젝트 내부에 격리 설치합니다.

Codex 탭:

- provider와 model
- approval policy
- sandbox mode
- reasoning effort
- output verbosity
- web search mode

Claude Code 탭:

- provider와 model
- permission mode
- effort
- allowed/disallowed tools
- fallback model

오케스트레이션 탭은 `strict-spec`, `balanced`, `rapid`, `review-heavy` preset과 workflow, 최대 병렬 에이전트, 자동 실행, 실패 차단, 자동 재개를 저장합니다. Reviewer 필수 검토, coder 이의의 자동 중재, 직렬 merge queue는 완화할 수 없는 invariant입니다.

설정 우선순위는 현재 포럼 스레드 override → 서버 전체 기본값 → 내장 안전 기본값입니다. 포럼 스레드에서 연 Activity는 guild/user뿐 아니라 해당 thread ID까지 `/admin` grant에 결합합니다. 실행 중 하네스 process의 provider/model/runtime policy는 바꾸지 않고 신규 session부터 반영합니다.

## 5. 프록시 공급자 설정

Discord native modal은 credential용 password input을 제공하지 않으므로, 민감한 공급자 설정은 Discord Activity 안의 Control Center에서 수행합니다. `/providers panel`의 `통합 관리 UI` 버튼도 `/admin`과 동일한 Activity launcher를 호출하며 관리 URL을 출력하지 않습니다.

설정 흐름:

```text
/admin 또는 /providers panel
      ↓ Discord Activity
하네스 + 이름 + Base URL + 모델 경로
      ↓
인증 방식 dropdown
  ├─ Bearer Token → password input
  ├─ API Key      → header name + password input
  └─ Basic Auth   → username + password input
      ↓
초기 모델 ID 한 개 (예: gpt-4o)
      ↓
연결 테스트 + 모델 목록 fetch
      ↓
저장할 모델 선택
      ↓
오케스트레이터/백엔드/프론트엔드/리뷰어 모델 바인딩
      ↓
공급자·credential·catalog·binding 저장
```

API 키를 포함한 Activity RPC body는 ECDH/HKDF로 합의한 session key를 사용해 AES-256-GCM으로 암호화됩니다. Relay에는 sequence, IV, ciphertext와 제한된 routing metadata만 보입니다. 로컬 오케스트레이터는 요청마다 Discord Administrator 권한을 다시 확인한 후 allowlist에 등록된 RPC만 실행합니다.

직접 입력 credential은 로컬 vault에 AES-256-GCM으로 다시 암호화됩니다. 원문은 Discord 메시지, relay storage, audit log, HTML 응답 또는 CLI config에 기록하지 않습니다. 저장 후 UI에는 구성 여부와 마스킹된 hint만 표시합니다.

### 레거시 loopback 모드

장애 복구 또는 로컬 단독 개발에만 다음 모드를 명시적으로 사용할 수 있습니다.

```dotenv
ADMIN_UI_MODE=legacy-loopback
ADMIN_SETUP_HOST=127.0.0.1
ADMIN_SETUP_PORT=8787
ADMIN_FRAME_ANCESTORS='none'
```

이 모드는 기본값이 아니며 외부 공개를 전제로 하지 않습니다. `ADMIN_SETUP_PUBLIC_URL`과 일반 reverse proxy로 로컬 관리 서버를 인터넷에 노출하는 구성을 권장하지 않습니다.

### Provider gateway

```text
Claude Code / Codex
        │ short-lived gateway token
        ▼
127.0.0.1:<dynamic>/providers/<route>
        │ authentication rewrite
        ├─ Authorization: Bearer ...
        ├─ X-API-Key: ...
        └─ Authorization: Basic ...
        ▼
Configured upstream proxy
```

- Claude Code: 격리된 `CLAUDE_CONFIG_DIR/settings.json`의 `apiKeyHelper`가 gateway token만 반환
- Codex: 격리된 `CODEX_HOME/config.toml`에 custom `model_providers`와 Responses API 설정 생성
- upstream key는 supervisor process에서만 복호화
- 실행 중 session에는 credential/model을 hot-swap하지 않으며 다음 session부터 적용

## 6. 역할별 모델 라우팅

```text
/role-models panel scope:서버 전체 기본값
/role-models panel scope:현재 포럼 스레드
```

선택 흐름은 `역할 → 공급자 → 모델 → 저장`입니다. 적용 우선순위는 다음과 같습니다.

```text
현재 forum thread override
          ↓ 없으면
server global binding
```

각 역할은 서로 다른 공급자·하네스·모델을 사용할 수 있습니다.

```text
orchestrator → Claude Code / subscription-compatible or proxy profile
backend      → Codex / official-compatible or proxy profile
frontend     → Claude Code / another proxy/model
reviewer     → Claude Code / read-only review model
```

모델 이름은 고정 열거형이 아니라 공급자가 반환하거나 관리자가 추가한 model ID입니다.

## 7. 사양 기반 개발

### 프로젝트 문서 구조

```text
<project>/.clcodex/
├── steering/
│   ├── product.md
│   ├── tech.md
│   ├── structure.md
│   └── role-policy.md
└── specs/<spec-slug>/
    ├── requirements.md 또는 bugfix.md
    ├── design.md
    ├── tasks.md
    ├── workflow.md
    └── spec.json
```

`steering` 문서는 장기 프로젝트 컨텍스트이고, `specs/<slug>`는 목표별 요구사항·설계·task graph·실행 상태의 source of truth입니다. Kiro의 Specs/Steering 구조를 참고하되, 본 구현에서는 역할별 Discord bot, worktree 격리, merge queue, command tool을 함께 결합했습니다.

### 목표 생성

Discord 포럼 스레드에서 실행합니다.

```text
/goal objective:<목표> type:<Feature|Bugfix> workflow:<방식> auto_run:<true|false>
```

지원 workflow:

- `Requirements First`: requirements → 승인 → design → 승인 → tasks → 승인
- `Design First`: design → 승인 → requirements → 승인 → tasks → 승인
- `Quick Plan`: Feature spec의 requirements + design + task manifest를 한 번에 생성하고 실행 대기

표준 workflow는 각 단계에서 `/spec approve` 승인 gate를 사용합니다.

### 요구사항

Feature spec은 stable ID와 EARS 형태의 관찰 가능한 요구사항을 작성합니다.

```text
### REQ-001
WHEN 관리자가 유효한 proxy 정보를 제출하면
THE SYSTEM SHALL 모델 catalog를 조회하고 선택 가능한 역할 모델을 표시한다.
```

Bugfix spec은 재현 조건, 현재 동작, 기대 동작, 유지되어야 하는 동작, 회귀 경계를 별도로 기록합니다.

### Task manifest와 자동 배정

오케스트레이터가 생성하는 task에는 다음 필드가 필요합니다.

```json
{
  "id": "backend-provider-store",
  "role": "backend",
  "title": "공급자 저장 계층 확장",
  "description": "인증 방식과 model catalog를 저장한다.",
  "dependencies": [],
  "requirementRefs": ["REQ-001"],
  "acceptanceCriteria": ["Bearer/API Key/Basic Auth가 구분 저장된다."],
  "fileScope": ["src/providers/**", "test/providers/**"],
  "testCommands": ["npm test -- test/providers.test.js"]
}
```

Manifest 저장 전 다음 추적성 검증을 통과해야 합니다.

- 각 task는 최소 한 개의 stable requirement ID와 수용 기준을 가져야 합니다.
- task가 참조한 ID는 승인된 `requirements.md` 또는 `bugfix.md`에 실제 존재해야 합니다.
- 승인된 모든 requirement ID는 최소 한 task에 배정되어야 합니다.
- `design.md`에도 모든 승인 requirement ID가 명시적으로 추적되어야 합니다.

배정 규칙:

1. `role=backend`는 Backend Bot/모델에 전달됩니다.
2. `role=frontend`는 Frontend Bot/모델에 전달됩니다.
3. dependency가 모두 merge된 task만 실행 가능합니다.
4. 같은 wave의 file scope가 겹치면 manifest를 거부합니다.
5. 각 task는 전용 branch/worktree에서 실행됩니다.
6. 완료 시 command tool의 `task.complete` event가 필요합니다.
7. host는 실제 변경 파일이 승인된 `fileScope` 안에 있는지 재검사합니다.
8. merge queue가 commit을 integration branch에 하나씩 cherry-pick합니다.
9. task의 `testCommands`는 허용된 command prefix만 사용할 수 있고 shell operator 없이 직접 실행됩니다.
10. 검증 process는 Discord/API/OAuth credential을 상속하지 않는 격리된 `HOME/XDG` 환경을 사용합니다.

### Reviewer와 최종 통합

모든 task가 merge queue를 통과하면 reviewer가 다음을 검사합니다.

- requirement ID와 acceptance criterion 충족 여부
- 전체 diff와 회귀 가능성
- 보안·오류 처리·이름·주석·유지보수성
- 제품 코드/주석/UI에 작업 과정이나 구현 완료를 설명하는 메타 문구가 들어갔는지

Reviewer는 `approve`, `rework`, `blocked` 중 하나를 structured verdict로 제출합니다. 승인된 경우 configured verification suite를 실행하고 single integrator가 main에 병합합니다.

Reviewer의 `rework` verdict는 해당 task를 같은 역할 coder에게 즉시 자동 재배정합니다. Coder가 재작업 지시가 승인 사양과 충돌한다고 판단하면 `dispute.raise` command를 제출하며, 이때 오케스트레이터가 별도 read-only 중재 세션으로 자동 호출됩니다.

```text
review.verdict(rework)
    ↓ 자동 재배정
coder 작업
    ├─ 수용 → task.complete
    └─ 사양 충돌 → dispute.raise
                      ↓
              orchestrator mediation
                      ↓ dispute.resolve
          ┌───────────┴───────────┐
      reviewer 판정           coder 판정
      재작업 자동 재배정       재작업 폐기·리뷰 자동 재개
```

- `decision=reviewer`: 재작업 worktree를 유지하고 구속력 있는 중재 지시를 추가해 같은 coder 역할에 자동 재배정
- `decision=coder`: 재작업 worktree를 폐기하고 기존 integration 상태를 유지한 채 reviewer를 자동 재호출
- 다음 reviewer prompt에는 과거 중재 결정이 binding context로 포함됨
- `/spec mediate`는 자동 중재 하네스가 구조화 `dispute.resolve`를 제출하지 못한 경우에만 사용하는 비상 관리자 override

### 중단과 재개

```text
/resume
```

다음 상태를 SQLite와 spec 문서에서 복원합니다.

- 중단된 requirements/design/tasks planning session
- 기존 task worktree가 남아 있는 backend/frontend session
- reviewer session
- blocked task의 재실행 대기 상태
- 미완료 `DISPUTE` 상태는 오케스트레이터 중재 세션을 자동 재시작

자연어 출력만 남기고 process가 종료된 경우 완료로 처리하지 않고 `blocked` 상태로 전환합니다.

## 8. 역할별 작업 기록

각 역할 bot은 자신에게 배정된 session의 메시지를 직접 작성하고 동일 메시지를 갱신합니다.

표시 항목:

- role, 상태, goal/spec ID, task ID
- harness, provider revision, model
- worktree branch, commit SHA
- credential redaction을 거친 최근 terminal output
- 완료 또는 실패 요약

이벤트는 `role_work_events`에 `(guild, thread, role)` 기준으로 저장되므로 병렬 작업 기록이 섞이지 않습니다.

## 9. 데이터 저장

주요 SQLite table:

- `provider_profiles`, `provider_models`, `provider_secrets`
- `role_model_bindings`, `provider_audit`, `role_work_events`
- `runtime_role_settings`, `orchestration_policies`, `orchestration_audit`
- `spec_projects`, `specs`, `spec_artifacts`, `spec_tasks`, `spec_events`

SQLite는 WAL과 busy timeout을 사용합니다.

## 10. 환경 변수

기본 예시는 [.env.example](.env.example)과 [.env.relay.example](.env.relay.example)을 사용합니다.

로컬 오케스트레이터:

```dotenv
RUNTIME_ROOT=.runtime
HARNESS_ROOT=.harness
DATABASE_PATH=.runtime/state.sqlite
PROJECTS_ROOT=.runtime/projects

ADMIN_UI_MODE=activity-relay
ADMIN_RELAY_WS_URL=wss://relay.example.com
ADMIN_RELAY_INSTALLATION_ID=<generated>
ADMIN_RELAY_DEVICE_TOKEN=<generated>
ADMIN_RELAY_DEVICE_KEY_PATH=.runtime/admin-relay/device-signing-private.jwk
ADMIN_GRANT_TTL_MS=60000
ADMIN_SESSION_TTL_MS=300000

PROXY_ALLOWED_HOSTS=
ALLOW_LOOPBACK_PROXY=true
ALLOW_INSECURE_LOOPBACK_PROXY=true

SPEC_VERIFICATION_COMMANDS=["npm test","npm run build"]
TASK_COMMAND_PREFIXES=[]
SPEC_AUTO_PUSH=false
```

공개 relay:

```dotenv
RELAY_ACTIVITY_ORIGINS=https://activity.example.com
RELAY_DEVICES_JSON={"<installation-id>":"<device-token>"}
RELAY_DISCORD_CLIENT_ID=<orchestrator-application-id>
RELAY_DISCORD_CLIENT_SECRET=<discord-oauth-client-secret>
RELAY_OAUTH_SESSION_TTL_MS=120000
RELAY_ACTIVITY_SESSION_TTL_MS=300000
```

`RELAY_ACTIVITY_ORIGINS`는 wildcard가 아닌 정확한 HTTPS origin만 허용합니다. `ADMIN_RELAY_WS_URL`은 운영 환경에서 `wss://`여야 하며 loopback 개발에만 `ws://`가 허용됩니다. `PROXY_ALLOWED_HOSTS`에는 사설 네트워크 proxy hostname을 명시적으로 등록해야 합니다.

## 11. 검증

```bash
npm run check
npm audit --omit=dev
```

테스트 범위:

- `/admin` Activity 직접 실행과 관리자 권한/application command 소유권
- outbound-only relay device 인증, Discord Activity OAuth code exchange, exact Origin CORS
- ECDH/HKDF/AES-GCM RPC와 pinned device signature, replay sequence
- 네 역할 bot token/account 고유성
- 인증 dropdown·password input·초기 모델 단일 input
- provider fetch → model 선택 → 네 역할 binding
- Bearer/API Key/Basic Auth gateway rewrite
- credential 암호화와 legacy schema migration
- global/thread provider·runtime policy routing
- requirement → design → task 전 구간 추적성
- task dependency wave와 file-scope 충돌
- task verification command allowlist, no-shell 실행, credential-free 환경
- 병렬 role worktree와 직렬 integration
- 읽기 전용 review snapshot
- reviewer 자동 재작업 라우팅, coder 이의 제기, 오케스트레이터 자동 중재와 비상 `/spec mediate` override
- `/resume`을 위한 persistent spec state

## 문서

- [Discord 명령어](docs/commands.md)
- [네 봇 topology](docs/four-bot-topology.md)
- [통합 Control Center](docs/control-center.md)
- [Outbound Activity relay 배포](docs/activity-relay.md)
- [Open Codex UI 적용 메모](docs/open-codex-adaptation.md)
- [Provider 설정 마법사](docs/provider-setup.md)
- [역할별 모델 UI](docs/role-model-ui.md)
- [사양 기반 워크플로](docs/spec-driven-workflow.md)
- [보안 경계](docs/security.md)
