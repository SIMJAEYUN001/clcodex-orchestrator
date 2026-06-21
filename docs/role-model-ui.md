# 역할별 모델 Discord UI 설계

## 명령 경계

```text
Guild slash command
  /providers
  /role-models
        │
        ├─ default_member_permissions = Administrator
        ├─ dm_permission = false
        └─ interaction마다 Administrator 재검사
```

Discord 명령 노출 제한만 신뢰하지 않고 버튼·select menu interaction에서도 권한을 다시 확인합니다.

## `/role-models panel`

```text
[역할군 선택]
  오케스트레이터 | 백엔드 | 프론트엔드 | 리뷰어
          ↓
[공급자 선택]
          ↓
[모델 선택]
          ↓
[역할 설정 저장]
```

Discord select menu의 option 제한을 고려해 공급자와 모델을 각각 25개 단위로 페이지 처리합니다.

## 범위

### 서버 전체

```text
scope_type = global
scope_id   = *
```

### 포럼 스레드

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

## 권한 검사

허용:

- guild owner
- `Administrator` permission 보유자

거부:

- `Manage Guild`만 보유한 사용자
- 다른 guild의 interaction
- 명령을 실행한 관리자와 다른 사용자가 누른 component
- 15분이 지난 UI component
- DM interaction

## 설정 반영

binding 저장 시 다음 검증을 수행합니다.

1. 공급자가 같은 guild에 속하는지 확인
2. 공급자가 활성 상태인지 확인
3. 선택한 model ID가 해당 공급자의 활성 catalog에 있는지 확인
4. `(guild, scope, role)` 단위로 upsert
5. actor와 변경 내용을 audit에 기록

모델 catalog에서 model ID가 삭제되면 해당 model을 가리키는 role binding도 같은 transaction에서 제거합니다.

## 세션 경계

이미 실행 중인 Claude Code/Codex process에는 새 설정을 hot-swap하지 않습니다. 각 process는 시작 시 provider revision을 기록하며, 다음 session부터 변경된 binding과 credential을 사용합니다.
