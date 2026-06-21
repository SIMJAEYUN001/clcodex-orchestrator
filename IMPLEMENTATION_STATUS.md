# Implementation status

## 구현됨

- 서로 다른 Discord bot account 네 개
  - 오케스트레이터
  - 백엔드 코더
  - 프론트엔드 코더
  - 리뷰어
- 네 token이 모두 존재하고 서로 다른지 startup에서 검증
- 관리 UI는 오케스트레이터 봇에만 등록
- 역할별 작업 시작·진행·완료 메시지는 해당 역할 봇이 직접 전송
- 역할별 고유 embed 색상, task/goal/model/provider/branch/commit 표시
- 터미널 출력 batching, ANSI 제거, credential redaction
- 역할별 작업 이력 SQLite ledger
- 각 역할 봇의 `<role>-model`, `<role>-history` 명령
- 관리자 전용 `/role-bots status`
- 관리자 전용 `/providers`, `/role-models` UI
- `/role-models`에서 역할 봇 identity 표시 및 역할 봇 확인 메시지 전송
- Guild-scoped global/forum-thread binding inheritance
- AES-256-GCM, ENV, file secret modes
- Claude Code apiKeyHelper/bearer isolation
- Codex custom model provider config generation
- 프로젝트 로컬 Claude Code/Codex installer

## 배포 시 입력 필요

- 동일 guild에 초대한 서로 다른 Discord application/bot 네 개
- 네 bot token
- guild/forum IDs
- 각 bot의 View Channels, Send Messages, Send Messages in Threads, Read Message History, Use Application Commands 권한
- proxy endpoint와 실제 model ID
- API key 또는 secret reference
- private proxy hostname allowlist

## 의도적으로 제외

- Subscription OAuth token 추출 또는 proxy credential 변환
- API key plaintext 표시/export
- 실행 중 process의 credential hot-swap
- 사용자 global Claude/Codex config 수정
- webhook을 이용한 역할 impersonation
