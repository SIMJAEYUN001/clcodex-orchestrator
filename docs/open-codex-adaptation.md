# Open Codex UI adaptation notes

Reference: `https://github.com/ymichael/open-codex`

`open-codex` is an Ink/React terminal application. clcodex does not embed or install that fork. It retains the official project-local Codex CLI and adapts the following interaction concepts to the Discord Activity 기반 Control Center.

| Open Codex interaction | clcodex adaptation |
| --- | --- |
| Asynchronous model discovery | Provider model-list request followed by searchable model catalog |
| Typeahead model overlay | Role card model search and filtered selector |
| Current model kept at the top | Active model is sorted before the remaining matches |
| Approval mode overlay | Codex role card with approval and sandbox selectors |
| Model changes restricted after a response | Provider/model/runtime policy snapshot at session start; no hot swap |
| Help overlay | `/help` plus Control Center Help tab |
| Command/file history overlay | Role-scoped Discord history plus Control Center session/audit tab |

## Claude Code equivalent

Claude Code receives a parallel role card rather than being forced into Codex terminology.

- Provider and model
- Permission mode
- Effort
- Allowed tools
- Disallowed tools
- Fallback model

Settings are translated into official Claude Code CLI arguments only when a new isolated session is created.

## Orchestration layer

The Control Center adds a layer that Open Codex does not provide:

- Kiro-style requirements/design/tasks workflow selection
- Backend/frontend dependency-wave scheduling
- Maximum parallel agent limit
- Read-only reviewer policy
- Automatic reviewer-to-coder rework routing
- Automatic orchestrator mediation for coder disputes
- Serial single-integrator merge queue

## Source boundary

No Open Codex source file is copied into this project. The implementation is an independent browser UI that uses the same general interaction patterns. This keeps the official Codex and Claude Code harness boundary intact.


## 전송 경계

Control Center는 공개된 로컬 웹 서버가 아니라 정적 Discord Activity와 outbound-only E2EE relay를 사용합니다. Open Codex의 UI 개념만 참고하며, provider credential과 orchestration RPC는 relay에서 복호화되지 않습니다.
