# clcodex-orchestrator

Discord 포럼에서 Claude Code와 Codex 기반 에이전트를 운영하는 **4-bot 역할 분리 control plane**입니다. 네 역할은 서로 다른 Discord Application/Bot 계정을 사용하며, 각 역할이 수행한 작업은 해당 봇의 이름·프로필 이미지·embed 색상으로 기록됩니다.

```text
Discord forum thread
        │
        ├─ Orchestrator Bot ─ 목표/상태/관리 UI/통합 결과
        ├─ Backend Bot      ─ 백엔드 작업 진행/완료/commit
        ├─ Frontend Bot     ─ 프론트엔드 작업 진행/완료/commit
        └─ Reviewer Bot     ─ 리뷰 결과/재작업 요청/판정
                  │
         Shared supervisor + SQLite
                  │
        isolated Claude Code / Codex PTYs
```

한 프로세스가 네 gateway client를 관리하지만, Discord 상에서는 네 개의 독립된 bot account입니다. webhook이나 nickname 변경으로 역할을 흉내 내지 않습니다. token이 누락되거나 두 역할이 같은 token을 사용하면 startup을 거부합니다.

## Discord 명령 배치

### 오케스트레이터 봇

관리·조정 명령만 오케스트레이터 봇에 등록됩니다.

```text
/providers panel
/providers audit
/role-models panel
/role-models status
/role-bots status
/orchestrator-model
/orchestrator-history
```

`/providers`, `/role-models`, `/role-bots`는 Discord `Administrator` 권한이 있는 서버 관리자 또는 서버 소유자만 사용할 수 있습니다. DM에서는 등록되지 않으며 버튼과 select menu interaction에서도 권한을 다시 검사합니다.

### 역할 봇

각 bot application에는 자기 역할의 조회 명령만 등록됩니다.

```text
Backend Bot:  /backend-model,  /backend-history
Frontend Bot: /frontend-model, /frontend-history
Reviewer Bot: /reviewer-model, /reviewer-history
```

작업 실행 명령을 추가할 때는 해당 역할 client에만 handler를 연결합니다.

```js
roleBotSupervisor.addInteractionHandler('backend', async (interaction) => {
  // backend 전용 Discord command 처리
});
```

## 역할별 작업 기록

`ManagedHarnessRuntime`은 role binding을 해석해 Claude Code 또는 Codex PTY를 시작합니다. `threadId`가 있으면 `RoleOutputRouter`가 해당 역할 봇으로 한 개의 작업 메시지를 전송하고 진행 중에는 메시지를 edit합니다.

```js
const session = managedHarnessRuntime.start({
  guildId,
  threadId,
  role: 'backend',
  goalId: 'goal-42',
  taskId: 'backend-db-01',
  title: 'DB migration 구현',
  branch: 'agent/goal-42/backend-db-01',
  cwd: assignedWorktree,
});
```

작업 메시지에는 다음 정보가 포함됩니다.

- 역할과 역할 전용 bot identity
- 상태
- goal/task ID
- 하네스, provider, model
- 전용 worktree branch
- 최종 commit SHA
- 최근 terminal output
- 완료 또는 실패 요약

터미널 출력은 일정 간격으로 batching하여 Discord spam을 방지합니다. ANSI control sequence를 제거하고 API key, bearer token, token/secret assignment 패턴을 redaction합니다. 시작·완료·실패 이벤트는 `role_work_events`에 저장되어 각 역할 봇의 `<role>-history` 명령으로 조회할 수 있습니다.

## 역할별 모델 UI

서버 관리자는 오케스트레이터 봇에서 다음 명령을 실행합니다.

```text
/role-models panel scope:서버 전체 기본값
/role-models panel scope:현재 포럼 스레드
```

UI 흐름:

```text
역할 선택 → provider 선택 → model 선택 → 역할 설정 저장
```

각 역할 행에는 실제 연결된 bot mention이 함께 표시됩니다. `역할 봇 확인` 버튼을 누르면 선택한 역할 bot account가 현재 채널에 확인 embed를 직접 전송합니다. 따라서 model routing과 Discord identity가 올바르게 연결됐는지 배포 전에 확인할 수 있습니다.

라우팅 우선순위:

```text
현재 forum thread override
          ↓ 없으면
server global binding
```

## 설치

요구사항:

- Node.js 22.13 이상
- Git
- Linux 또는 macOS 권장
- 동일 guild에 초대한 서로 다른 Discord Bot 네 개

```bash
npm install
npm run harness:install
cp .env.example .env
npm run check
npm start
```

`.env`의 네 token은 반드시 서로 달라야 합니다.

```dotenv
DISCORD_GUILD_ID=123456789012345678
DISCORD_FORUM_CHANNEL_ID=123456789012345679
DISCORD_ORCHESTRATOR_BOT_TOKEN=...
DISCORD_BACKEND_BOT_TOKEN=...
DISCORD_FRONTEND_BOT_TOKEN=...
DISCORD_REVIEWER_BOT_TOKEN=...
```

각 bot에 필요한 guild/channel 권한:

- View Channels
- Send Messages
- Send Messages in Threads
- Read Message History
- Use Application Commands
- Embed Links

Message Content privileged intent는 사용하지 않습니다.

## 프로젝트 로컬 하네스

```text
.harness/
├── packages/node_modules/@anthropic-ai/claude-code
├── packages/node_modules/@openai/codex
└── bin/
    ├── claude
    └── codex
```

설치 스크립트는 `npm -g`를 사용하지 않으며 사용자의 일반 `~/.claude`, `~/.codex`를 수정하지 않습니다.

## Provider와 API key

`/providers panel`에서 Claude Code 또는 Codex proxy profile을 생성하고 다음 방식을 사용할 수 있습니다.

- ENV secret reference
- mode `0600` file reference
- AES-256-GCM 직접 암호화 저장

직접 입력한 key는 다시 표시되지 않습니다. 운영 환경에서는 ENV 또는 file reference를 권장합니다.

Claude Code proxy profile은 provider별 `CLAUDE_CONFIG_DIR`과 `apiKeyHelper` 또는 bearer token을 사용합니다. 두 credential mechanism을 동시에 활성화하지 않습니다. Codex profile은 provider별 `CODEX_HOME/config.toml`에 custom `model_providers` entry를 생성하고 key 원문 대신 전용 environment variable 이름을 기록합니다.

## 설정 변경 경계

Provider/model binding 변경은 실행 중인 PTY에 hot-swap하지 않습니다. 새 task session 또는 `/resume`으로 재생성된 session부터 새 설정을 사용합니다. 작업 메시지에는 session 시작 시 확정된 provider revision과 model을 사용하므로 실행 중 설정 변경으로 이력이 뒤섞이지 않습니다.

## 데이터 모델

- `provider_profiles`: harness, endpoint, auth style, revision
- `provider_models`: provider별 model catalog
- `provider_secrets`: encrypted/env/file descriptor
- `role_model_bindings`: global/thread 역할 routing
- `provider_audit`: 관리자 변경 이력
- `role_work_events`: 역할별 작업 lifecycle ledger

## 검증

```bash
npm run check
npm audit --omit=dev
```

검증 항목에는 네 bot token 고유성, admin command 격리, 역할별 command 배치, 역할별 work ledger, output credential redaction, provider/model routing, Claude/Codex config isolation이 포함됩니다.

상세 구조는 [docs/four-bot-topology.md](docs/four-bot-topology.md), [docs/role-model-ui.md](docs/role-model-ui.md), [docs/migrate-from-single-bot.md](docs/migrate-from-single-bot.md)를 참고하십시오.
