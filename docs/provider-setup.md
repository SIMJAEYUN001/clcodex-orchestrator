# Provider 설정 마법사

## 호출과 권한

Provider 추가·수정 명령은 오케스트레이터 Discord application에만 등록됩니다.

```text
/admin
# 또는 provider 탭의 빠른 진입점인 /providers panel
```

- Discord 서버 소유자 또는 `Administrator`만 호출할 수 있습니다.
- command, Activity 연결, 각 RPC에서 권한을 반복 검사합니다.
- DM에서는 실행되지 않습니다.
- Discord modal은 password 타입을 제공하지 않으므로 credential 원문은 Discord 입력창으로 받지 않습니다.
- `통합 관리 UI` 버튼은 URL을 출력하지 않고 Discord Activity를 직접 실행합니다.

## 입력 흐름

```text
Harness + 이름 + Base URL + model-list path
        ↓
인증 방식 선택
  ├─ Bearer Token
  │    └─ Token (password input)
  ├─ API Key
  │    ├─ Header name
  │    └─ API key (password input)
  └─ Basic Auth
       ├─ Username
       └─ Password (password input)
        ↓
초기 모델 ID 단일 input
        예: gpt-4o
        ↓
연결 검사와 모델 catalog 조회
        ↓
저장할 모델 선택
        ↓
역할별 provider/model binding 선택
        ↓
원자적 저장
```

초기 모델 ID는 모델 조회가 지원되지 않거나 catalog가 비어 있을 때 사용할 단일 bootstrap 값입니다. 여러 모델은 연결 검사 후 반환된 catalog에서 선택합니다.

## 모델 조회와 역할 바인딩

Provider 저장만으로 설정을 끝내지 않습니다.

1. URL과 인증 필드 검증
2. credential을 Activity→local E2EE RPC로 전달
3. 로컬 오케스트레이터가 model-list endpoint 호출
4. 반환 model ID 정규화 및 중복 제거
5. 관리자가 저장할 모델 선택
6. provider profile·credential descriptor·model catalog 저장
7. 오케스트레이터·백엔드·프론트엔드·리뷰어별 binding 저장
8. 다음 하네스 session부터 선택한 provider/model 적용

기존 provider는 공급자 탭에서 연결 테스트, model catalog 동기화, 활성화/비활성화, 삭제를 수행할 수 있습니다. catalog에서 제거된 모델의 오래된 binding은 자동으로 해제됩니다.

## Credential 전송과 저장

전송:

- Activity와 로컬 device가 ephemeral ECDH key를 합의합니다.
- HKDF-SHA256으로 AES-256-GCM session key를 생성합니다.
- credential을 포함한 RPC는 relay가 복호화할 수 없는 ciphertext로 전달됩니다.
- sequence와 direction을 인증 데이터에 포함합니다.

저장:

- 직접 입력: AES-256-GCM encrypted record
- ENV reference: 환경 변수 이름만 SQLite에 저장
- File reference: 지정된 secret root 아래 상대 경로만 저장

금지 사항:

- credential 원문 재표시 또는 export
- Discord message/relay/audit log에 credential 기록
- CLI 설정 파일에 upstream credential 기록
- 공식 구독 OAuth token 추출 또는 proxy token으로 변환

## 네트워크 구조

관리 UI의 기본 경로는 [Outbound Activity relay](activity-relay.md)입니다. 로컬 오케스트레이터에 inbound 관리 HTTP listener를 열지 않습니다.

하네스가 실제 provider에 접근할 때는 별도의 localhost credential gateway를 사용합니다.

```text
Claude Code / Codex
        │ session-local token
        ▼
127.0.0.1 provider gateway
        │ upstream auth rewrite
        ▼
Configured provider
```

## 레거시 복구 모드

```dotenv
ADMIN_UI_MODE=legacy-loopback
ADMIN_SETUP_HOST=127.0.0.1
ADMIN_SETUP_PORT=8787
ADMIN_FRAME_ANCESTORS='none'
```

로컬 개발 또는 Activity relay 장애 복구에만 사용합니다. 외부 public URL이나 reverse proxy로 공개하지 않습니다.
