# Provider 설정 마법사

## 호출과 권한

Provider 추가·수정 명령은 오케스트레이터 Discord application에만 등록됩니다.

```text
/admin
# 또는 provider 탭으로 바로 안내하는 /providers panel
```

- Discord 서버 소유자 또는 `Administrator`만 호출할 수 있습니다.
- component interaction에서도 권한과 최초 호출자를 다시 확인합니다.
- DM에서는 실행되지 않습니다.
- Discord modal은 password 타입을 제공하지 않으므로 credential 원문은 Discord 입력창으로 받지 않습니다.

`통합 관리 UI` 버튼은 만료 시간이 짧은 관리자 URL을 발급합니다. URL token은 fragment에 배치되어 일반 HTTP request target에 포함되지 않으며, 서버는 token 원문 대신 digest만 보관합니다.

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

초기 모델 ID는 모델 조회가 아직 지원되지 않거나 catalog가 비어 있을 때 사용할 단일 bootstrap 값입니다. 여러 모델은 연결 검사 후 반환된 catalog에서 checkbox로 선택합니다.

## 모델 조회와 역할 바인딩

Provider 저장만으로 설정을 끝내지 않습니다. 마법사는 다음 단계를 한 transaction 성격의 흐름으로 수행합니다.

1. URL과 인증 필드 검증
2. credential을 메모리에서만 사용해 model-list endpoint 호출
3. 반환 model ID 정규화 및 중복 제거
4. 관리자가 저장할 모델 선택
5. provider profile·credential descriptor·model catalog 저장
6. 오케스트레이터·백엔드·프론트엔드·리뷰어별 binding 저장
7. 다음 하네스 session부터 선택한 provider/model 적용

기존 provider는 `/admin`의 공급자 탭에서 연결 테스트, model catalog 동기화, 활성화/비활성화, 삭제를 수행할 수 있습니다. catalog에서 제거된 모델을 가리키는 오래된 binding은 자동으로 해제되므로 `/role-models panel`에서 다시 선택해야 합니다.

## Credential 저장

지원 모드:

- 직접 입력: AES-256-GCM encrypted record
- ENV reference: 환경 변수 이름만 SQLite에 저장
- File reference: 지정된 secret root 아래 상대 경로만 저장

금지 사항:

- credential 원문 재표시 또는 export
- Discord message/audit log에 credential 기록
- CLI 설정 파일에 upstream credential 기록
- 공식 구독 OAuth token 추출 또는 proxy token으로 변환

## 원격 접속

기본적으로 설정 폼은 loopback에 bind합니다.

```dotenv
ADMIN_SETUP_HOST=127.0.0.1
ADMIN_SETUP_PORT=8787
ADMIN_SETUP_SESSION_TTL_MS=600000
```

다른 장치에서 열려면 HTTPS reverse proxy와 `ADMIN_SETUP_PUBLIC_URL`을 사용하고, VPN·IP allowlist·SSO 중 하나 이상의 추가 접근 통제를 적용해야 합니다.
