# Implementation status

## 구현됨

- 서로 다른 Discord 애플리케이션을 사용하는 4-role bot fleet
- 오케스트레이터 봇 전용 `/providers`, `/role-models` management UI
- backend/frontend/reviewer 관리 명령 미등록
- 네 bot token과 실제 Discord user ID 중복 거부
- role bot 하나라도 준비되지 않으면 fail-closed startup
- role 간 Discord 출력 fallback 금지
- 역할 봇 명의의 작업 시작·진행·완료·실패·중단 기록
- task/goal/provider/model/branch/session metadata embed
- PTY 로그 버퍼링, ANSI 제거, credential redaction, mention 차단
- Guild-scoped provider/model routing UI
- Administrator default command permission
- Administrator/owner runtime authorization on every interaction
- DM command disablement
- Global and forum-thread bindings with inheritance
- 역할별 모델 설정 변경을 해당 역할 봇으로 통지
- AES-256-GCM, ENV, file secret modes
- Provider CRUD, model sync, connection test, audit log
- Claude Code apiKeyHelper/bearer isolation
- Codex custom model provider config generation
- Project-local CLI installer
- `role_activity` 실행 이력 metadata 저장
- Automated syntax, security, routing, bot identity, and command-permission tests

## 배포 시 입력 필요

- Discord guild/forum IDs
- 서로 다른 bot token 4개
- 선택 사항인 admin log text channel ID
- Proxy endpoints and real model IDs
- API key or secret reference
- Private proxy hostname allowlist where applicable
- Existing orchestrator task/merge queue integration point

## 의도적으로 제외

- Subscription OAuth token extraction or conversion
- API key plaintext display/export
- Runtime credential hot-swap
- User-global Claude/Codex config modification
- 역할 봇 장애 시 다른 역할 봇으로 대체 출력
