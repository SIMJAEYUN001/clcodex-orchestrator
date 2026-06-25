# Discord Activity outbound relay

## 목적

기본 관리자 UI는 로컬 오케스트레이터의 HTTP 서버를 공개하지 않습니다. Discord Activity는 정적 SPA로만 배포되고, 로컬 오케스트레이터는 공개 relay에 outbound WebSocket 연결만 생성합니다.

```text
Discord /admin
      │ LAUNCH_ACTIVITY
      ▼
Activity static SPA
      │ Discord OAuth authorization code + PKCE(S256)
      │ pinned ECDSA device identity
      │ ephemeral ECDH(P-256)
      │ HKDF-SHA256 → AES-256-GCM
      ▼
Public relay
      │ ciphertext routing only
      ▲
      │ outbound WSS
Local orchestrator
```

관리용 포트포워딩, 공인 IP, reverse tunnel, 로컬 inbound HTTP listener는 필요하지 않습니다. Provider gateway와 command-tool endpoint는 기존대로 `127.0.0.1`에만 존재합니다.

## 신뢰 경계

### Activity 정적 호스트

공개로 배포되는 파일에는 다음 정보만 들어 있습니다.

- Discord application ID
- relay HTTPS/WSS URL
- installation ID
- 로컬 device signing public key
- public-key fingerprint

device token, Discord client secret, provider credential, vault key, private signing key는 포함하지 않습니다.

### Relay

Relay가 볼 수 있는 정보:

- installation ID
- Discord OAuth로 확인한 user ID
- guild/channel ID가 포함된 handshake routing metadata
- session ID, sequence, IV, ciphertext 크기
- 연결 시각과 상태

Relay가 볼 수 없는 정보:

- provider API key 및 Basic Auth password
- 관리 RPC method/params/result
- 역할별 model binding payload
- orchestration policy payload
- 로컬 vault 내용

Discord OAuth access token은 Embedded App SDK의 `authenticate`를 위해 Activity에 한 번 반환됩니다. Relay는 이를 storage에 저장하지 않지만 OAuth exchange 과정에서는 메모리상 처리합니다. Provider credential과 관리 RPC는 별도 E2EE channel로 보호됩니다.

### 로컬 오케스트레이터

로컬 프로세스만 다음을 수행합니다.

- `/admin` one-use grant 발급·소비
- 현재 guild owner/Administrator 권한 검증
- Activity가 열린 Discord thread와 grant scope 일치 검사
- E2EE session key 합의 및 device transcript 서명
- allowlisted RPC 실행
- provider credential vault 저장

## 인증 순서

1. Administrator가 오케스트레이터 봇에서 `/admin`을 실행합니다.
2. command 처리기가 guild와 `Administrator` 권한을 확인하고 1회용 grant를 발급합니다.
3. Discord interaction callback `LAUNCH_ACTIVITY`로 Activity를 엽니다.
4. Activity가 Embedded App SDK에서 OAuth authorization code를 요청합니다.
5. Activity는 PKCE verifier/challenge를 생성하고 relay를 통해 Discord token endpoint와 교환합니다.
6. Relay는 exact HTTPS Origin을 검사하고 단기 single-use relay session token을 발급합니다.
7. Activity가 relay WebSocket에 연결하고 guild/user/channel과 ephemeral ECDH public key를 보냅니다.
8. Relay는 해당 frame을 outbound 연결된 로컬 device로 전달합니다.
9. 로컬 device는 Discord API로 Administrator 권한을 다시 조회하고 `/admin` grant를 소비합니다.
10. 포럼 thread에서 발급된 grant라면 Activity channel ID가 동일해야 합니다.
11. 로컬 device는 ephemeral ECDH key를 만들고 handshake transcript를 장기 device ECDSA key로 서명합니다.
12. Activity는 provision된 public key/fingerprint로 서명을 확인합니다.
13. 양쪽은 ECDH + HKDF-SHA256으로 AES-256-GCM session key를 만듭니다.
14. 이후 RPC는 방향·session·sequence를 AEAD additional data에 포함해 암호화합니다.
15. 각 RPC 실행 직전에도 로컬 오케스트레이터가 Administrator 권한을 다시 확인합니다.

## RPC allowlist

Relay frame 안의 plaintext를 해석하지 않습니다. 로컬 control plane은 복호화 후에도 다음 메서드만 허용합니다.

```text
admin.bootstrap
providers.discover
providers.create
providers.test
providers.sync
providers.toggle
providers.delete
bindings.save
policy.save
```

임의 shell, SQL, 파일 읽기, URL fetch 또는 generic method dispatch는 제공하지 않습니다.

## 프로비저닝

```bash
npm install
npm run admin:provision -- \
  --discord-client-id 123456789012345678 \
  --relay-http-url https://relay.example.com \
  --relay-ws-url wss://relay.example.com \
  --activity-origin https://activity.example.com
```

명령은 기존 installation ID, device token과 signing key가 있으면 재사용합니다. 운영 중 Activity에 pin된 device public key를 변경하려면 Activity `config.json`을 다시 배포해야 합니다.

## Activity 배포

```bash
npm run activity:build
```

`dist/activity/`를 HTTPS 정적 호스트에 배포합니다. 다음 파일은 build 전에 자동 생성됩니다.

- `activity/public/control-center-app.js`: 기존 Control Center client bundle
- `activity/public/config.json`: 공개 relay/device metadata

두 파일은 Git에서 제외됩니다. `config.json`은 `npm run admin:provision`으로 생성하는 것을 권장합니다.

Discord Developer Portal에서 다음을 설정합니다.

- Activities 활성화
- Activity URL Mapping → 정적 Activity origin
- OAuth client secret은 relay에만 저장
- 오케스트레이터 application이 `/admin` command를 보유

## Relay 배포

`.runtime/admin-relay/relay.env` 또는 `.env.relay.example`을 기준으로 환경을 설정합니다.

```dotenv
RELAY_HOST=127.0.0.1
RELAY_PORT=8790
RELAY_ACTIVITY_ORIGINS=https://activity.example.com
RELAY_DEVICES_JSON={"installation-id":"long-random-device-token"}
RELAY_DISCORD_CLIENT_ID=123456789012345678
RELAY_DISCORD_CLIENT_SECRET=...
RELAY_OAUTH_SESSION_TTL_MS=120000
RELAY_ACTIVITY_SESSION_TTL_MS=300000
RELAY_MAX_PAYLOAD_BYTES=1000000
RELAY_MAX_MESSAGES_PER_MINUTE=180
```

```bash
npm run relay
```

Relay process 자체는 기본적으로 loopback에 bind합니다. Cloudflare, Fly.io, Render, reverse proxy 또는 다른 TLS platform에서 다음 endpoint를 HTTPS/WSS로 노출합니다.

```text
GET  /health
POST /v1/oauth/token
WS   /v1/device
WS   /v1/activity
```

`RELAY_ACTIVITY_ORIGINS`는 exact HTTPS origin 목록입니다. wildcard, path, query, embedded credential은 허용하지 않습니다.

## 로컬 오케스트레이터

프로비저닝 결과의 `orchestrator.env`를 `.env`에 반영합니다.

```dotenv
ADMIN_UI_MODE=activity-relay
ADMIN_RELAY_WS_URL=wss://relay.example.com
ADMIN_RELAY_INSTALLATION_ID=...
ADMIN_RELAY_DEVICE_TOKEN=...
ADMIN_RELAY_DEVICE_KEY_PATH=.runtime/admin-relay/device-signing-private.jwk
ADMIN_RELAY_STARTUP_TIMEOUT_MS=15000
ADMIN_GRANT_TTL_MS=60000
ADMIN_SESSION_TTL_MS=300000
```

오케스트레이터는 relay handshake가 완료되지 않으면 startup timeout 후 종료합니다. `/admin` 호출 시 relay가 끊겨 있으면 Activity grant를 발급하지 않습니다.

## 방화벽 기준

로컬 호스트에서 필요한 외부 방향은 다음과 같습니다.

```text
Discord Gateway/API       TCP 443 outbound
Admin relay               TCP 443 outbound
Claude/Codex provider     TCP 443 outbound 또는 명시된 proxy
```

관리 UI를 위한 inbound rule은 필요하지 않습니다. Relay가 로컬 호스트로 직접 접속할 경로도 없습니다.

## 회전과 폐기

### Device token 회전

1. 새로운 token으로 relay의 `RELAY_DEVICES_JSON`을 갱신합니다.
2. 로컬 `ADMIN_RELAY_DEVICE_TOKEN`을 같은 값으로 변경합니다.
3. relay와 로컬 오케스트레이터를 재시작합니다.

### Device signing key 회전

1. 로컬 signing private JWK를 안전하게 백업하거나 제거합니다.
2. `npm run admin:provision`을 다시 실행합니다.
3. 새 `activity/public/config.json`으로 Activity를 재배포합니다.
4. 로컬 오케스트레이터를 재시작합니다.

이전 public key가 pin된 Activity build는 새 device와 연결되지 않습니다.

### Discord client secret 회전

Relay 환경만 갱신합니다. 정적 Activity와 로컬 오케스트레이터에는 client secret을 배포하지 않습니다.

## 레거시 복구 모드

```dotenv
ADMIN_UI_MODE=legacy-loopback
ADMIN_SETUP_HOST=127.0.0.1
ADMIN_SETUP_PORT=8787
ADMIN_FRAME_ANCESTORS='none'
```

이 모드는 로컬 장애 복구와 개발용입니다. 외부 reverse proxy나 public URL을 통해 공개하지 않습니다.
