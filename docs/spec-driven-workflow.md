# 사양 기반 멀티에이전트 워크플로

## 목표

오케스트레이터가 자연어 목표를 즉시 coder에게 전달하지 않고, 저장 가능한 요구사항·설계·task graph로 변환한 뒤 그 사양을 기준으로 역할을 배정합니다.

```text
Goal
  → Requirements 또는 Bugfix Analysis
  → Design
  → Task Manifest
  → Approval Gate
  → Dependency Waves
  → Role-specific Worktrees
  → Merge Queue
  → Read-only Review
  → Single Integrator
  → main
```

## Steering

`.clcodex/steering/`은 프로젝트 전반에 계속 적용되는 컨텍스트입니다.

| 파일 | 내용 |
| --- | --- |
| `product.md` | 제품 목적, 대상 사용자, 핵심 기능, 사업 제약 |
| `tech.md` | runtime, framework, storage, test, deployment, NFR |
| `structure.md` | 디렉터리 ownership, naming, architecture boundary |
| `role-policy.md` | 역할별 권한과 금지사항 |

## Spec artifact

`.clcodex/specs/<slug>/`에 목표별 문서를 보관합니다.

- `requirements.md`: EARS 형태 요구사항과 NFR
- `bugfix.md`: 재현·현재·기대·불변 동작과 회귀 경계
- `design.md`: architecture, data/control flow, API/UI, 보안, migration, 검증
- `tasks.md`: dependency wave별 사람이 읽는 계획
- `spec.json`: 기계가 검증하는 task manifest와 상태
- `workflow.md`: phase, status, revision, role assignment, merge policy

## Approval gate

`requirements-first`, `design-first` workflow는 각 planning phase 종료 후 `awaiting_approval` 상태가 됩니다. spec 생성자 또는 Administrator가 `/spec approve`를 실행해야 다음 phase가 시작됩니다.

`quick-plan`은 requirements, design, task manifest를 한 번에 생성하는 경량 흐름이며, 실행 전 `/spec run` 경계는 유지됩니다.

## Task graph validation

Manifest는 다음 조건을 만족해야 합니다.

- stable unique task ID
- backend 또는 frontend 역할
- non-empty description와 file scope
- 존재하는 dependency만 참조
- dependency cycle 없음
- 각 task에 최소 한 개의 stable requirement ID
- 승인된 모든 requirement ID가 task에 배정됨
- task 참조 ID가 requirements/bugfix와 design에 모두 존재
- 관찰 가능한 acceptance criterion
- 같은 wave에서 file scope 비중첩
- README, docs, `.clcodex`, `.github` 등 orchestrator-owned path를 coder scope에 포함하지 않음

## Worktree isolation

```text
clcodex/spec/<slug>               integration branch
agent/<slug>/<task>-r<attempt>    task branch
.runtime/worktrees/<spec>/<task>  task worktree
.runtime/integration/<spec>       single integration worktree
```

Task 완료 시 host가 다음을 수행합니다.

1. 남은 변경을 task commit으로 작성
2. integration branch와 비교해 실제 변경 파일 계산
3. manifest `fileScope` 밖 변경 거부
4. allowlist에 포함된 task verification command를 shell 없이 직접 실행
5. merge queue에 enqueue
6. integration worktree에서 cherry-pick
7. 다음 dependency wave dispatch


## Verification command policy

Task manifest의 `testCommands`는 오케스트레이터가 임의 shell script로 취급하지 않습니다.

- 각 command는 하나의 executable과 argv로 파싱됩니다.
- `&&`, `||`, `;`, pipe, redirect, command substitution, 줄바꿈을 거부합니다.
- 기본 allowlist는 npm/pnpm/yarn/bun의 test/run, `node --test`, Vitest, pytest, Cargo, Go, .NET, Maven, Gradle, Make test/check 계열입니다.
- `TASK_COMMAND_PREFIXES`로 배포 환경에 맞는 prefix를 명시할 수 있습니다.
- 최종 `SPEC_VERIFICATION_COMMANDS`도 shell 없이 순서대로 직접 실행됩니다.
- 검증 process에는 Discord bot token, provider credential, Claude/Codex credential, supervisor vault key가 전달되지 않습니다.
- 검증 전용 `HOME`, XDG, Cargo/NPM config 경로를 사용하고 system/global Git config를 비활성화합니다.

이 경계는 command injection과 credential 유출을 줄이지만 완전한 OS sandbox는 아닙니다. 신뢰도가 낮은 repository는 별도 OS user, container 또는 VM에서 실행해야 합니다.

## Structured completion

Agent prose는 완료 신호가 아닙니다.

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

`CLCODEX_TOOL_TOKEN`은 server가 역할·spec·task context와 함께 발급합니다. Agent가 payload의 actor role이나 task ID를 임의로 바꿀 수 없습니다.

## Reviewer

Reviewer는 integration candidate의 `.git`이 제거된 read-only snapshot과 별도 diff 파일을 받습니다. 리뷰 메모만 별도 writable scratch에 기록할 수 있습니다.

- `approve`: verification 후 main 병합
- `rework`: 명시한 task를 같은 역할에 다시 배정
- `blocked`: user/orchestrator 개입 대기

## Reviewer-coder 중재

Reviewer 재작업 task에서 coder가 승인된 사양과 충돌하는 지시를 발견하면 `dispute.raise`를 제출할 수 있습니다. 단순 자연어 반론은 상태 전환으로 인정하지 않습니다.

```text
review.verdict(rework)
    ↓ 같은 역할 coder에게 자동 재배정
coder
    ├─ 지시 수용 → task.complete
    └─ 승인 사양 충돌 → dispute.raise
                              ↓
                     spec = mediating
                              ↓
              orchestrator read-only mediation
                              ↓ dispute.resolve
              ├─ reviewer → 기존 rework worktree 재사용, coder 자동 재시작
              └─ coder    → rework worktree 폐기, 기존 integration 유지, reviewer 자동 재호출
```

중재 결과는 `spec_events`에 저장되고 이후 reviewer prompt에 binding context로 포함됩니다. 동일 쟁점은 새로운 객관적 증거가 없는 한 다시 열 수 없습니다. 오케스트레이터 하네스가 구조화 판정을 제출하지 못한 경우에만 `/spec mediate`를 비상 override로 사용합니다. `/resume`은 미완료 dispute를 찾아 중재 세션을 자동 재시작합니다.

## Workflow 문서 갱신

모든 state transition에서 `workflow.md`를 다시 렌더링합니다.

```text
planning → awaiting_approval → ready → running → review → completed
                                      ↘ blocked ↗
```

최종 승인 시 single integrator가 code branch를 main에 병합한 뒤 `.clcodex` 최종 상태를 별도 documentation commit으로 기록합니다.

## Resume

`/resume`은 DB status와 기존 worktree를 사용합니다.

- planning: 같은 phase 재호출
- running: 기존 worktree가 있으면 재사용
- review: read-only snapshot과 diff 재생성
- mediating/dispute: 오케스트레이터 중재 세션 자동 재시작
- blocked: phase에 따라 planning, task 또는 review 재개
