# Implementation status

## 구현됨

### Discord topology와 권한

- 서로 다른 Discord bot account 네 개
  - 오케스트레이터
  - 백엔드 코더
  - 프론트엔드 코더
  - 리뷰어
- 네 token 및 로그인 후 Discord user ID 고유성 검증
- `/admin`을 포함한 모든 관리·설정·사양 명령을 오케스트레이터 application으로 집중
- 오케스트레이터 전용 `/help [topic]`
- 관리자 명령의 `Administrator` 기본 권한과 runtime 재검사
- 워커 application에서 모든 관리 명령 제외
- 역할별 작업 메시지와 SQLite 작업 ledger

### 통합 Control Center

- `/admin` interaction callback으로 직접 실행하는 Administrator 전용 Discord Activity
- Open Codex식 검색 가능한 model selector와 현재 선택값 우선 정렬
- 개요, Provider, Codex, Claude Code, 오케스트레이션, 세션·이력, 도움말 탭
- server global 및 forum-thread override와 상속 상태 표시
- 실행 중 session의 provider/model/runtime snapshot 고정
- Provider와 orchestration 설정 감사 로그
- local inbound 관리 HTTP listener가 없는 outbound-only WSS device
- Discord OAuth authorization code + PKCE(S256)
- exact Activity Origin, installation device token, one-use guild/user/thread grant
- pinned ECDSA device identity + ephemeral ECDH/HKDF/AES-256-GCM RPC
- RPC별 Administrator 권한 재검사와 sequence replay 방지
- relay가 provider credential과 RPC plaintext를 해석하지 않는 opaque forwarding

### Provider와 역할 모델 UI

- Bearer Token / API Key / Basic Auth dropdown
- 인증 방식별 동적 username/header/password field
- 별도 password credential input
- 단일 초기 모델 ID input (`예: gpt-4o`)
- provider 연결 검사와 원격 model catalog fetch
- 저장할 모델 선택 후 네 역할 binding까지 이어지는 완료 흐름
- global/forum-thread model binding inheritance
- AES-256-GCM, ENV, file secret mode
- localhost credential gateway
- Claude Code `apiKeyHelper` 격리
- Codex custom `model_providers` 격리

### Codex 관리 UI

- 역할별 provider/model 선택
- approval policy: `untrusted`, `on-request`, `never`
- sandbox: `read-only`, `workspace-write`, `danger-full-access`
- reasoning effort와 verbosity
- web search mode
- 격리된 `CODEX_HOME/config.toml`에 신규 session별 반영
- Reviewer read-only/never, Orchestrator read-only invariant

### Claude Code 관리 UI

- 역할별 provider/model 선택
- permission mode와 effort
- allowed/disallowed tools
- fallback model
- 격리된 Claude Code CLI argument로 신규 session별 반영
- Reviewer plan + write tool deny, Orchestrator bypass deny invariant

### 전체 오케스트레이션 선택 UI

- `strict-spec`, `balanced`, `rapid`, `review-heavy` preset
- Requirements First, Design First, Quick Plan workflow
- 자동 실행과 최대 병렬 에이전트 설정
- 실패 시 spec 차단과 `/resume` 자동 복구 설정
- Reviewer 필수, 자동 분쟁 중재, 직렬 cherry-pick invariant
- 선택한 최대 병렬도가 실제 task dispatch queue에 적용

### 사양 기반 오케스트레이션

- `.clcodex/steering` 프로젝트 문서
- `.clcodex/specs/<slug>` requirements/bugfix, design, tasks, workflow, spec manifest
- stable requirement ID와 requirement→design→task 추적성 검증
- dependency wave, 역할 ownership, file-scope 충돌 검증
- backend/frontend 전용 worktree 병렬 실행
- command-tool 기반 structured completion
- allowlisted no-shell verification과 credential-free 검증 환경
- reviewer read-only snapshot과 diff
- single integrator 직렬 merge queue

### 자동 재작업·중재

- reviewer `rework` → 명시 task를 같은 역할 coder에게 자동 재배정
- coder `dispute.raise` → spec을 mediating으로 전환
- 오케스트레이터 전용 read-only 중재 session 자동 시작
- 승인 사양·reviewer 의견·coder 근거·diff·과거 판정을 중재 prompt에 포함
- `dispute.resolve(reviewer)` → 기존 재작업 worktree를 유지해 coder 자동 재시작
- `dispute.resolve(coder)` → 재작업 worktree 폐기, 기존 integration 유지, reviewer 자동 재호출
- 중재 결과를 binding event로 저장하고 이후 reviewer context에 포함
- `/resume`으로 미완료 중재 session 자동 재시작
- `/spec mediate`는 자동 판정 실패 시에만 사용하는 비상 override

## 검증

- JavaScript syntax 검사
- Node test suite 57개
- production dependency audit
- project-local harness 설치 스크립트
- ZIP 무결성 검사는 release artifact 생성 시 수행

## 배포 시 입력 필요

- 동일 guild의 서로 다른 Discord application/bot 네 개
- 네 bot token과 guild/forum ID
- 각 bot의 channel/thread/application-command 권한
- proxy endpoint와 실제 model ID
- API key 또는 secret reference
- 정적 Discord Activity HTTPS origin과 URL Mapping
- HTTPS/WSS public relay 및 Discord OAuth client secret
- relay installation ID/device token과 local device signing key

## 의도적으로 제외

- Subscription OAuth token 추출 또는 proxy credential 변환
- API key plaintext 표시/export
- 실행 중 process credential/model/runtime hot-swap
- 사용자 global Claude/Codex config 수정
- webhook 기반 역할 impersonation
- 완전한 kernel/VM sandbox
