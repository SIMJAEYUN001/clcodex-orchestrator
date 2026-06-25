# Changelog

## 0.8.0

- Replaced direct and loopback administrator links with an orchestrator-only Discord Activity launch.
- Added an outbound-only local relay client; no public or inbound local admin HTTP endpoint is required.
- Added a standalone HTTPS/WSS relay with exact Activity Origin checks and per-installation device authentication.
- Added Discord OAuth authorization-code exchange with PKCE(S256) and short-lived single-use relay sessions.
- Added one-use `/admin` grants bound to guild, user, and forum-thread context.
- Added pinned P-256 device signatures and ephemeral ECDH/HKDF/AES-256-GCM end-to-end encrypted RPC.
- Added ordered sequence enforcement, tamper detection, payload limits, rate limits, and current Administrator verification for every RPC.
- Added transport-neutral allowlisted administration methods and retained an explicit legacy loopback recovery mode.
- Added Activity/relay provisioning, static Activity build, deployment documentation, and key-rotation procedures.
- Added 57 automated tests, including full outbound-device/relay/E2EE RPC coverage.

## 0.7.0

- Added the orchestrator-only `/admin` Control Center.
- Added provider, Codex, Claude Code, orchestration, session/audit, and help views.
- Added Open Codex-inspired searchable model selection and runtime policy controls.
- Added role-scoped Codex approval, sandbox, reasoning, verbosity, and web-search settings.
- Added role-scoped Claude Code permission, effort, tool, and fallback-model settings.
- Added global/thread runtime-policy inheritance and audit records.
- Added strict-spec, balanced, rapid, and review-heavy orchestration presets.
- Enforced selected maximum parallelism in the task dispatcher.
- Preserved reviewer/orchestrator write restrictions server-side.
- Added 49 automated tests covering the Control Center and existing orchestration behavior.
