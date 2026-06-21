# Implementation status

## 구현됨

- Guild-scoped `/providers` management UI
- Guild-scoped `/role-models` role routing UI
- Administrator default command permission
- Administrator/owner runtime authorization on every interaction
- DM command disablement
- Four independent role groups
- Global and forum-thread bindings with inheritance
- Provider/model pagination
- AES-256-GCM, ENV, file secret modes
- Provider CRUD, model sync, connection test, audit log
- Claude Code apiKeyHelper/bearer isolation
- Codex custom model provider config generation
- Project-local CLI installer
- Automated syntax, security, routing, and command-permission tests

## 배포 시 입력 필요

- Discord guild/forum IDs and bot token
- Proxy endpoints and real model IDs
- API key or secret reference
- Private proxy hostname allowlist where applicable
- Existing orchestrator output/command bus integration point

## 의도적으로 제외

- Subscription OAuth token extraction or conversion
- API key plaintext display/export
- Runtime credential hot-swap
- User-global Claude/Codex config modification
