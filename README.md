# clcodex-orchestrator

Discord 포럼 스레드와 역할별로 Claude Code·Codex 공급자/모델을 선택하는 관리 계층입니다. 공식 CLI는 프로젝트 안에만 설치하고, 프록시 API 키·모델 목록·역할 라우팅을 Discord 서버 명령어와 상호작용 UI로 관리합니다.

## 이번 버전의 UI

### `/providers panel`

프록시 공급자를 관리합니다.

- Claude Code 또는 Codex 프로필 생성
- Base URL, 모델 목록 경로, 인증 방식 수정
- API 키 직접 암호화 저장
- 환경변수 또는 파일 secret 참조
- 모델 ID 직접 편집 및 `/v1/models` 동기화
- 연결 테스트
- 활성화/비활성화와 삭제
- 키 원문을 제외한 감사 로그

### `/role-models panel`

역할군별 모델을 관리합니다.

- 오케스트레이터
- 백엔드 코더
- 프론트엔드 코더
- 리뷰어

UI에서 역할 → 공급자 → 모델 순서로 선택한 뒤 `역할 설정 저장`을 누릅니다.

적용 범위는 다음 두 가지입니다.

- **서버 전체 기본값**: 모든 프로젝트/스레드의 기본 라우팅
- **현재 포럼 스레드**: 해당 프로젝트 스레드에만 적용되는 override

스레드 override가 없으면 서버 전체 기본값을 자동 상속합니다. `현재 범위 설정 해제`를 누르면 스레드는 서버 기본값으로 복귀합니다.

## 관리자 권한 정책

두 명령은 Discord **guild command**로만 등록되며 DM 사용을 비활성화합니다.

```text
/providers ...
/role-models ...
```

명령 정의에는 `Administrator`를 `default_member_permissions`로 설정합니다. interaction을 처리할 때도 다음 조건을 다시 검사합니다.

```text
서버 소유자
또는
Discord Administrator 권한 보유자
```

`Manage Server`만 가진 사용자나 별도 allowlist 사용자는 허용하지 않습니다. 권한은 UI를 처음 호출할 때뿐 아니라 버튼과 select menu를 누를 때마다 재검증합니다. 각 UI session은 호출한 사용자와 guild에 묶이고 15분 후 만료됩니다.

## 설치

요구사항:

- Node.js 22.13 이상
- Git
- Linux 또는 macOS 권장
- Discord 애플리케이션과 오케스트레이터 봇

```bash
npm install
npm run harness:install
cp .env.example .env
npm run check
npm start
```

`node-pty`가 사전 빌드 바이너리를 제공하지 않는 환경에서는 C/C++ 빌드 도구와 현재 Node.js 버전의 개발 헤더가 필요할 수 있습니다.

### 프로젝트 로컬 하네스

```text
.harness/
├── packages/node_modules/@anthropic-ai/claude-code
├── packages/node_modules/@openai/codex
└── bin/
    ├── claude
    └── codex
```

설치 스크립트는 `npm -g`를 사용하지 않으며 일반 `~/.claude`, `~/.codex`를 수정하지 않습니다.

## Discord 설정

`.env`를 작성합니다.

```dotenv
DISCORD_GUILD_ID=123456789012345678
DISCORD_FORUM_CHANNEL_ID=123456789012345679
DISCORD_ORCHESTRATOR_BOT_TOKEN=...
```

봇에는 application command를 등록하고 interaction에 응답할 권한이 필요합니다. 메시지 내용 privileged intent는 사용하지 않습니다.

실행 후 guild에 다음 명령이 등록됩니다.

```text
/providers panel
/providers audit
/role-models panel scope:서버 전체 기본값
/role-models panel scope:현재 포럼 스레드
/role-models status
```

`현재 포럼 스레드` 범위는 `DISCORD_FORUM_CHANNEL_ID` 아래의 thread에서만 선택할 수 있습니다.

## API 키 저장

### ENV 참조 — 운영 권장

```dotenv
FRONTEND_PROXY_API_KEY=...
```

`/providers panel → API 키 → ENV 참조`에서 `FRONTEND_PROXY_API_KEY`를 입력합니다. SQLite에는 환경변수 이름만 저장됩니다.

### 파일 참조 — 운영 권장

기본 root:

```text
.runtime/external-secrets/
```

```bash
install -m 600 /dev/null .runtime/external-secrets/frontend.key
printf '%s' 'your-key' > .runtime/external-secrets/frontend.key
```

UI에는 `frontend.key`만 입력합니다. root 밖 경로와 root 밖으로 향하는 symlink는 거부됩니다.

### 직접 입력·암호화

Discord modal 값을 수신한 직후 AES-256-GCM으로 암호화합니다.

- provider ID를 AAD로 사용
- 랜덤 96-bit nonce
- 인증 태그 저장
- UI에는 마지막 네 글자 hint만 표시
- 감사 로그에 원문 키 미기록

마스터 키는 `PROVIDER_VAULT_MASTER_KEY`로 공급하거나 다음 위치에 mode `0600`으로 자동 생성합니다.

```text
.runtime/secrets/provider-master-key
```

직접 입력값은 암호화되기 전 Discord interaction 경로를 통과합니다. 민감도가 높은 배포에서는 ENV 또는 파일 참조를 사용하십시오.

## Claude Code 프록시

각 공급자마다 독립된 `CLAUDE_CONFIG_DIR`을 생성합니다.

```text
.runtime/harness-state/claude/<provider-id>/claude-config/
```

`api-key-helper` 방식에서는 `settings.json`에 helper 경로만 저장하고 키는 자식 프로세스의 전용 환경변수에만 전달합니다. `bearer` 방식에서는 helper를 제거한 뒤 해당 격리 프로세스에만 `ANTHROPIC_AUTH_TOKEN`을 설정합니다. 두 방식을 동시에 설정하지 않습니다.

사용자의 전역 `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`은 managed child 환경으로 상속하지 않습니다.

## Codex 프록시

각 공급자마다 독립된 `CODEX_HOME/config.toml`을 생성합니다.

```toml
model = "selected-model"
model_provider = "clcodex_<provider-id>"

[model_providers.clcodex_<provider-id>]
name = "provider name"
base_url = "https://proxy.example.com/v1"
env_key = "CLCODEX_PROFILE_API_KEY"
wire_api = "responses"
requires_openai_auth = false
```

키 원문은 TOML에 저장하지 않습니다. `x-api-key` 방식은 `env_http_headers`를 사용합니다. 사용자의 전역 `OPENAI_API_KEY`, `OPENAI_BASE_URL`은 managed child 환경으로 상속하지 않습니다.

## 런타임 사용

오케스트레이터는 새 세션을 시작할 때 역할의 현재 binding을 해석합니다.

```js
const session = runtime.start({
  guildId,
  threadId,
  role: 'frontend',
  cwd: assignedWorktree,
  taskId,
  onData(chunk) {
    // Discord output router로 전달
  },
});
```

라우팅 우선순위:

```text
현재 forum thread binding
        ↓ 없으면
server global binding
```

설정 변경은 이미 실행 중인 하네스의 credential을 교체하지 않습니다. 새 agent session 또는 `/resume`으로 재생성되는 session부터 적용합니다.

## 네트워크 방어

- 원격 공급자는 HTTPS 필수
- HTTP는 허용된 loopback 공급자에만 사용
- URL 내 사용자명/비밀번호, query, fragment 거부
- metadata, link-local, multicast, unspecified 주소 거부
- private/CGNAT 주소는 `PROXY_ALLOWED_HOSTS`에 명시
- redirect 거부
- timeout 및 응답 크기 제한

로컬 프록시:

```dotenv
ALLOW_LOOPBACK_PROXY=true
ALLOW_INSECURE_LOOPBACK_PROXY=true
```

사설 호스트:

```dotenv
PROXY_ALLOWED_HOSTS=proxy.internal.example,*.ai.internal.example
```

## 데이터 모델

- `provider_profiles`: 하네스, endpoint, 인증 방식, revision
- `provider_models`: 공급자별 model ID
- `provider_secrets`: encrypted/env/file descriptor
- `role_model_bindings`: global/thread 역할 라우팅
- `provider_audit`: 원문 키를 제외한 변경 이력

## 검증

```bash
npm run check
npm audit --omit=dev
```

검증 범위:

- guild command의 `Administrator` 기본 권한
- DM 비활성화
- 서버 소유자/Administrator 런타임 이중 검사
- `Manage Server`만 가진 사용자의 거부
- 네 역할군 독립 라우팅
- thread override와 global 상속
- 삭제된 모델의 stale binding 제거
- AES-GCM과 provider-bound AAD
- ENV/파일 secret reference
- Claude `apiKeyHelper` 격리
- Codex custom provider TOML 격리
- SSRF 관련 주소 분류와 loopback 정책

상세 설계는 [docs/role-model-ui.md](docs/role-model-ui.md)를 참고하십시오.
