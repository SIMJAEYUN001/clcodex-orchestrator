# 역할별 모델 Discord UI 설계

## 명령 경계

관리 UI는 오케스트레이터 bot application에만 등록합니다.

```text
Orchestrator Bot
  /help
  /admin
  /providers
  /role-models
  /role-bots

Backend / Frontend / Reviewer Bot
  자기 역할 model/history 조회와 작업 출력만 담당
```

## 권한 경계

```text
/admin
/providers
/role-models
/role-bots
        │
        ├─ default_member_permissions = Administrator
        ├─ dm_permission = false
        └─ 모든 component interaction에서 Administrator 재검사
```

`/help`는 guild member가 사용할 수 있지만 오케스트레이터 bot에만 등록됩니다.

## `/role-models panel`

```text
[역할 선택]
        ↓
[provider 선택]
        ↓
[model 선택]
        ↓
[역할 설정 저장] [역할 봇 확인]
```

현재 routing 행에는 역할 bot mention, provider, model, inheritance 상태가 표시됩니다. provider와 model은 각각 25개 단위로 page 처리합니다.

`역할 봇 확인`은 선택한 role의 실제 bot account를 이용해 현재 channel에 preview embed를 전송합니다.

## Scope

```text
global: scope_type=global, scope_id=*
thread: scope_type=thread, scope_id=Discord thread ID
```

실효값은 thread binding을 우선하고 없으면 global binding을 사용합니다.

## Session 경계

실행 중인 Claude Code/Codex process에는 설정을 hot-swap하지 않습니다. 다음 session부터 변경된 binding과 credential을 사용합니다.

## 통합 Control Center

`/admin`은 outbound-only E2EE relay를 사용하는 Discord Activity로 열립니다. provider/model 선택뿐 아니라 Codex approval/sandbox/reasoning, Claude permission/effort/tools, 전체 orchestration preset을 한 화면에서 관리합니다. `/role-models panel`은 Discord component만으로 빠르게 binding을 변경하는 보조 경로입니다.
