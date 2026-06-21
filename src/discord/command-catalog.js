export const HELP_CATEGORIES = [
  {
    id: 'overview',
    label: '시작 및 구조',
    description: '명령 소유권과 역할별 봇 동작 방식',
    commands: [
      { syntax: '/help [category]', description: '이 도움말 UI를 엽니다.' },
    ],
    notes: [
      '모든 slash command와 관리 UI는 오케스트레이터 봇에만 등록됩니다.',
      '백엔드·프론트엔드·리뷰어 봇은 자기 역할의 작업 기록만 게시합니다.',
      '작업 봇에는 관리 명령이 남지 않도록 시작 시 guild command 목록을 비웁니다.',
    ],
  },
  {
    id: 'providers',
    label: '프록시 공급자',
    description: 'Claude Code·Codex 프록시 endpoint와 credential 관리',
    commands: [
      { syntax: '/providers panel', description: '공급자 생성·수정·키 설정·모델 동기화 UI를 엽니다.', adminOnly: true },
      { syntax: '/providers audit', description: '키 원문을 제외한 최근 공급자 관리 이력을 확인합니다.', adminOnly: true },
    ],
    notes: [
      '직접 입력한 키는 AES-256-GCM으로 암호화하거나 ENV/파일 참조로 저장할 수 있습니다.',
      '설정은 새 하네스 세션부터 적용되며 실행 중 프로세스에는 hot-swap하지 않습니다.',
    ],
  },
  {
    id: 'models',
    label: '역할별 모델',
    description: '역할·프로젝트 범위별 provider/model 라우팅',
    commands: [
      { syntax: '/role-models panel scope:<server|thread>', description: '역할 → 공급자 → 모델 설정 UI를 엽니다.', adminOnly: true },
      { syntax: '/role-models status', description: '현재 채널에 적용되는 네 역할의 모델을 확인합니다.', adminOnly: true },
      { syntax: '/role-models history [role] [limit]', description: '현재 프로젝트 또는 서버의 역할별 실행 이력을 조회합니다.', adminOnly: true },
      { syntax: '/role-models bots', description: '연결된 네 Discord 봇 계정과 ID를 확인합니다.', adminOnly: true },
    ],
    notes: [
      'thread override가 없으면 서버 전체 기본값을 상속합니다.',
      '설정 변경 알림은 선택한 역할의 봇 계정으로 게시됩니다.',
    ],
  },
  {
    id: 'activity',
    label: '작업 기록',
    description: '역할 봇별 작업 시작·진행·완료 기록',
    commands: [],
    notes: [
      '각 하네스 세션은 역할에 대응하는 Discord 봇 계정으로 기록됩니다.',
      '메시지에는 goal/task/provider/model/branch/session 정보가 포함됩니다.',
      'PTY 출력은 버퍼링하고 ANSI·일반적인 credential 패턴·mention을 제거한 뒤 게시합니다.',
      '특정 역할 봇 장애 시 다른 봇 계정으로 대체 출력하지 않습니다.',
    ],
  },
  {
    id: 'permissions',
    label: '권한',
    description: '명령 실행 권한과 Discord 초대 권한',
    commands: [],
    notes: [
      '/providers와 /role-models는 서버 소유자 또는 Administrator만 사용할 수 있습니다.',
      '/help는 서버 구성원이 열 수 있지만 관리 명령은 실행 권한이 없으면 사용할 수 없습니다.',
      '오케스트레이터 봇만 applications.commands scope가 필요합니다.',
      '작업 봇은 View Channels, Send Messages in Threads, Embed Links 권한만 있으면 됩니다.',
    ],
  },
];

export function findHelpCategory(id) {
  return HELP_CATEGORIES.find((category) => category.id === id) || HELP_CATEGORIES[0];
}
