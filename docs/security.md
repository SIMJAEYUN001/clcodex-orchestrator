# 보안 경계

## Credential 경계

- Claude Code와 Codex는 `.harness/` 아래의 프로젝트 로컬 설치만 사용합니다.
- 역할/provider별 `HOME`, XDG, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`을 분리합니다.
- 자식 process에는 supervisor 전체 환경이 아니라 allowlist 환경만 전달합니다.
- upstream credential은 supervisor vault에서만 복원됩니다.
- 하네스에는 session 전용 localhost gateway token만 전달합니다.
- Claude Code custom provider는 격리된 `apiKeyHelper`를 사용합니다.
- Codex custom provider는 격리된 `model_providers` 설정과 전용 환경 변수만 사용합니다.
- 공식 구독 OAuth credential은 공식 CLI 경계 밖으로 추출하거나 proxy credential로 변환하지 않습니다.

## Provider 네트워크 경계

- embedded URL credential, query, fragment를 거부합니다.
- metadata, link-local, multicast, unspecified endpoint를 차단합니다.
- 사설 주소는 `PROXY_ALLOWED_HOSTS`의 명시적 hostname만 허용합니다.
- 평문 HTTP는 설정에서 허용한 loopback endpoint에만 사용할 수 있습니다.
- redirect를 따르지 않고, timeout과 response size limit를 적용합니다.

이 검사는 application-level SSRF 완화입니다. 신뢰하지 않는 네트워크에서 운영할 때는 egress firewall도 함께 적용해야 합니다.

## Discord 권한 경계

- 네 역할은 서로 다른 Discord bot account를 사용합니다.
- 관리 명령은 오케스트레이터 application에만 등록합니다.
- `/admin`, `/providers`, `/role-models`, `/role-bots`, `/project`는 guild owner 또는 `Administrator`만 사용할 수 있습니다.
- `/admin` 링크는 ephemeral로 발급하고 관리 session은 최초 호출자, guild, 현재 thread scope를 고정합니다.
- URL token은 fragment로 전달하고 server session map에는 SHA-256 digest만 저장합니다.
- Control Center API는 bearer 인증, no-store 응답, CSP와 frame-ancestor 정책을 적용합니다.
- 관리 button/select/form session은 최초 호출자와 guild를 고정합니다.
- credential 원문은 Discord modal 또는 message로 받지 않습니다.

## Repository 권한 경계

| 역할 | 제품 코드 쓰기 | 사양/워크플로 쓰기 | 비고 |
| --- | --- | --- | --- |
| orchestrator | 금지 | 허용 | 목표 분해, 사양, task graph, 중재 |
| backend | 배정된 backend scope만 | 금지 | 전용 worktree |
| frontend | 배정된 frontend scope만 | 금지 | 전용 worktree |
| reviewer | 금지 | 금지 | read-only snapshot과 diff |
| integrator | 승인 commit 통합만 | 최종 상태 기록 | 직렬 merge queue |

Task 완료 시 실제 변경 경로를 manifest `fileScope`와 다시 비교합니다. 같은 dependency wave에서 scope가 겹치는 task는 실행 전에 거부합니다.

## Command tool 경계

Agent의 자연어 출력은 상태 전환 신호가 아닙니다. 역할·spec·task에 묶인 단기 token으로 다음 structured event만 받습니다.

```text
spec.publish
spec.publish-tasks
spec.publish-plan
task.complete
task.blocked
review.verdict
dispute.raise
dispute.resolve
```

Task verification command는 shell operator를 거부하고 허용된 executable/argv prefix만 직접 실행합니다. 검증 process에는 Discord token, provider credential, vault key를 전달하지 않습니다.

## 자동 중재 경계

Reviewer의 `rework`는 명시된 task만 같은 역할 coder에게 자동 재배정합니다. Coder의 `dispute.raise`는 다음 조건에서만 허용됩니다.

- 현재 actor가 실제 배정된 backend/frontend 역할
- task가 실행 중
- reviewer가 생성한 재작업 task
- reason 필수
- 동일 쟁점 재개 시 새로운 객관적 evidence 필수

중재는 오케스트레이터 전용 read-only snapshot, 승인 사양, diff, 양측 근거를 사용합니다. `dispute.resolve` 결과는 binding event로 저장되며 자동으로 재작업 재배정 또는 reviewer 재호출까지 수행합니다. `/spec mediate`는 자동 중재 session이 구조화 판정을 제출하지 못한 경우의 관리자 비상 override입니다.

## OS 격리 한계

Worktree, read-only snapshot, 환경 allowlist는 제어면 경계이며 완전한 kernel sandbox가 아닙니다. 신뢰도가 낮은 repository나 임의 build script를 실행할 때는 전용 OS user, container 또는 VM을 사용해야 합니다.

## Runtime policy 경계

- Reviewer는 Codex `read-only/never`, Claude `plan`과 write-tool deny로 정규화됩니다.
- Orchestrator는 Codex `read-only`이며 Claude `bypassPermissions`를 사용할 수 없습니다.
- UI에서 제한값을 제출해도 server-side validation이 역할 invariant를 다시 적용합니다.
- provider/model/runtime policy는 session 시작 시 revision과 함께 snapshot으로 고정됩니다.
- 설정 변경은 실행 중 process에 주입하지 않고 신규 session부터 적용합니다.
