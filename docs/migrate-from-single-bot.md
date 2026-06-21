# Single bot에서 four role bots로 이전

## 1. Discord application 생성

기존 오케스트레이터 application은 유지하고 다음 세 application을 추가합니다.

- Backend Bot
- Frontend Bot
- Reviewer Bot

각 application에서 bot user를 생성하고 동일 guild에 초대합니다. 최소 권한은 다음과 같습니다.

```text
View Channels
Send Messages
Send Messages in Threads
Read Message History
Use Application Commands
Embed Links
```

## 2. 환경변수 변경

기존:

```dotenv
DISCORD_ORCHESTRATOR_BOT_TOKEN=...
```

변경:

```dotenv
DISCORD_ORCHESTRATOR_BOT_TOKEN=...
DISCORD_BACKEND_BOT_TOKEN=...
DISCORD_FRONTEND_BOT_TOKEN=...
DISCORD_REVIEWER_BOT_TOKEN=...
```

네 token은 서로 달라야 합니다. 같은 token을 복사해 넣으면 startup validation이 실패합니다.

## 3. 재시작

```bash
npm install
npm run check
npm start
```

startup 시 각 application의 guild command registry가 역할에 맞게 교체됩니다. 오케스트레이터에만 관리자 UI가 등록되고 worker bot에는 역할별 model/history command만 등록됩니다.

## 4. 확인

오케스트레이터 봇:

```text
/role-bots status
/role-models status
```

`/role-models panel`에서 역할을 선택하고 `역할 봇 확인`을 누릅니다. 선택한 역할의 실제 bot account가 채널에 확인 메시지를 작성해야 합니다.

## 5. 기존 데이터

기존 provider profile, secret descriptor, model catalog, role binding table은 그대로 사용합니다. `role_work_events` table만 migration 과정에서 추가됩니다.
