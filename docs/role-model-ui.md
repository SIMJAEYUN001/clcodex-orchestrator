# 역할별 모델 Discord UI 설계

## Bot 경계

관리 UI는 오케스트레이터 bot application에만 등록합니다.

```text
Orchestrator Bot
  /providers
  /role-models
  /role-bots

Backend / Frontend / Reviewer Bot
  역할별 model/history 조회와 작업 출력만 담당
```

네 role은 서로 다른 token과 Discord user ID를 사용해야 합니다.

## 권한 경계

```text
Guild slash command
  /providers
  /role-models
  /role-bots
        │
        ├─ default_member_permissions = Administrator
        ├─ dm_permission = false
        └─ 모든 component interaction에서 Administrator 재검사
```

허용:

- guild owner
- `Administrator` permission 보유자

거부:

- `Manage Guild`만 보유한 사용자
- 다른 guild interaction
- UI를 연 관리자와 다른 사용자의 component 조작
- 15분이 지난 UI session
- DM interaction

## `/role-models panel`

```text
[역할 선택]
  오케스트레이터 | 백엔드 | 프론트엔드 | 리뷰어
          ↓
[provider 선택]
          ↓
[model 선택]
          ↓
[역할 설정 저장] [역할 봇 확인]
```

현재 routing 행에는 역할 bot mention, provider, model, inheritance 상태가 표시됩니다. Discord select menu option 제한에 맞춰 provider와 model을 각각 25개 단위로 page 처리합니다.

`역할 봇 확인`은 선택한 role의 실제 bot account를 이용해 현재 channel에 preview embed를 전송합니다. 관리 panel 자체는 ephemeral입니다.

## Scope

서버 기본값:

```text
scope_type = global
scope_id   = *
```

포럼 스레드 override:

```text
scope_type = thread
scope_id   = Discord thread ID
```

실효값 계산:

```text
thread binding이 있으면 사용
없으면 global binding 사용
```

스레드 UI에서 explicit binding이 없고 global 값이 적용 중이면 `서버 기본값 상속`으로 표시합니다.

## 저장 검증

1. provider가 같은 guild에 속하는지 확인
2. provider가 활성 상태인지 확인
3. model ID가 provider의 활성 catalog에 있는지 확인
4. `(guild, scope, role)` 단위 upsert
5. actor와 변경 내용을 audit에 기록

model catalog에서 model ID가 삭제되면 해당 model을 가리키는 role binding도 같은 transaction에서 제거합니다.

## Session 경계

이미 실행 중인 Claude Code/Codex process에는 새 설정을 hot-swap하지 않습니다. 각 process는 시작 시 provider revision과 model을 확정하며 다음 session부터 변경된 binding과 credential을 사용합니다.
