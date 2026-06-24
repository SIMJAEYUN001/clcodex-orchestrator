import {
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';
import { ROLES, roleDefinition, roleLabel } from '../roles.js';
import { isServerAdministrator } from './common.js';

const EPHEMERAL = MessageFlags.Ephemeral;

const TOPICS = [
  { name: '전체 개요', value: 'overview' },
  { name: '관리자 명령', value: 'admin' },
  { name: '통합 Control Center', value: 'control-center' },
  { name: '오케스트레이터', value: 'orchestrator' },
  { name: '백엔드 코더', value: 'backend' },
  { name: '프론트엔드 코더', value: 'frontend' },
  { name: '리뷰어', value: 'reviewer' },
  { name: 'Provider/API 키', value: 'providers' },
  { name: '역할별 모델 라우팅', value: 'routing' },
  { name: '사양 기반 워크플로', value: 'specs' },
  { name: '작업 이력', value: 'history' },
];

function roleCommands(role) {
  const prefix = roleDefinition(role).commandPrefix;
  return [
    `/${prefix}-model — 현재 채널에 적용되는 provider/model 확인`,
    `/${prefix}-history — 현재 채널에서 해당 역할이 수행한 최근 작업 이력 확인`,
  ];
}

export class HelpUi {
  constructor({ guildId, roleBots }) {
    this.guildId = guildId;
    this.roleBots = roleBots;
  }

  commandJson() {
    return new SlashCommandBuilder()
      .setName('help')
      .setDescription('clcodex 자체 명령어와 역할별 사용법 표시')
      .addStringOption((option) => option
        .setName('topic')
        .setDescription('자세히 볼 명령 영역')
        .addChoices(...TOPICS))
      .setDMPermission(false)
      .toJSON();
  }

  async handle(interaction) {
    if (!interaction.isChatInputCommand?.() || interaction.commandName !== 'help') return false;
    if (interaction.guildId !== this.guildId) return false;
    const topic = interaction.options.getString('topic') || 'overview';
    const administrator = isServerAdministrator(interaction, this.guildId);
    await interaction.reply({
      embeds: [this.view(topic, administrator)],
      flags: EPHEMERAL,
    });
    return true;
  }

  view(topic, administrator) {
    const embed = new EmbedBuilder()
      .setColor(roleDefinition('orchestrator').color)
      .setTitle('clcodex 명령어 도움말')
      .setFooter({
        text: administrator
          ? '현재 사용자: 서버 관리자 · 관리 명령 사용 가능'
          : '현재 사용자: 관리자 권한 없음 · 🔒 명령은 Administrator 권한 필요',
      });

    if (topic === 'overview') {
      embed
        .setDescription('모든 관리·설정 명령은 **오케스트레이터 봇**에만 등록됩니다. 워커 봇은 자기 역할의 작업 출력과 조회 명령만 담당합니다.')
        .addFields(
          {
            name: '오케스트레이터 봇 · 전체 진입점',
            value: [
              '/help — 이 도움말',
              '🔒 /admin — Codex·Claude Code·공급자·오케스트레이션 통합 Control Center',
              '🔒 /providers panel — proxy/provider/API 키 관리',
              '🔒 /role-models panel — 역할별 provider/model 설정',
              '🔒 /role-bots status — 네 역할 봇 연결 확인',
              '🔒 /project — 포럼 스레드 프로젝트 생성·연결·삭제',
              '/goal — 요구사항·설계·task 사양 작성 시작',
              '/spec — 승인·실행·상태·비상 중재 override',
              '/resume — 중단된 실행과 자동 중재 재개',
              ...roleCommands('orchestrator'),
            ].join('\n'),
          },
          ...ROLES.filter((role) => role !== 'orchestrator').map((role) => ({
            name: `${roleLabel(role)} 봇`,
            value: roleCommands(role).join('\n'),
          })),
        );
      return embed;
    }

    if (topic === 'admin') {
      embed
        .setTitle('관리자 명령 도움말')
        .setDescription('아래 명령은 오케스트레이터 봇에만 존재하며 서버 소유자 또는 Discord Administrator만 실행할 수 있습니다.')
        .addFields(
          {
            name: '/admin',
            value: 'Codex/Claude Code 런타임, proxy/provider, 역할별 모델, 전체 spec 오케스트레이션과 세션 이력을 한 웹 UI에서 관리합니다.',
          },
          {
            name: '/providers panel',
            value: 'Claude Code/Codex proxy profile 생성·수정·삭제, API key secret 연결, model catalog 동기화와 연결 테스트.',
          },
          {
            name: '/providers audit',
            value: 'provider, model, secret descriptor 변경 이력 확인. API key 원문은 기록하지 않습니다.',
          },
          {
            name: '/role-models panel scope:<범위>',
            value: '오케스트레이터·백엔드·프론트엔드·리뷰어별 provider/model을 server global 또는 현재 forum thread 범위로 설정.',
          },
          {
            name: '/role-models status',
            value: '현재 채널에 실제 적용되는 역할별 bot/provider/model 확인.',
          },
          {
            name: '/role-bots status',
            value: '네 Discord bot account가 모두 연결되어 있는지 확인.',
          },
          {
            name: '/project create|bind|delete|status',
            value: 'Forum thread와 Git 프로젝트를 연결합니다. create/bind/delete는 Administrator 전용입니다.',
          },
          {
            name: '/goal · /spec · /resume',
            value: '사양 작성, 승인 gate, task 실행, 상태 확인과 중단 세션 재개. reviewer 재작업은 자동 재배정되며 coder 이의는 오케스트레이터가 자동 중재합니다.',
          },
        );
      return embed;
    }

    if (topic === 'control-center') {
      return embed
        .setTitle('통합 Control Center 도움말')
        .setDescription('오케스트레이터 봇의 `/admin`으로 관리자 전용 일회성 링크를 발급합니다.')
        .addFields(
          { name: 'Providers', value: 'Bearer Token/API Key/Basic Auth, password 입력, 모델 조회, 공급자 등록과 즉시 역할 바인딩.' },
          { name: 'Codex', value: '역할별 provider/model, approval policy, sandbox, reasoning effort, verbosity, web search.' },
          { name: 'Claude Code', value: '역할별 provider/model, permission mode, effort, allowed/disallowed tools와 fallback model.' },
          { name: 'Orchestration', value: 'strict-spec/balanced/rapid/review-heavy preset, 기본 workflow, 최대 병렬 agent, 자동 실행·재개 정책.' },
          { name: '적용 시점', value: '실행 중 session은 immutable snapshot을 유지하고 새 session부터 변경값을 적용합니다.' },
        );
    }

    if (ROLES.includes(topic)) {
      const identity = this.roleBots?.identity(topic);
      embed
        .setColor(roleDefinition(topic).color)
        .setTitle(`${roleLabel(topic)} 명령 도움말`)
        .setDescription(`담당 Discord 봇: ${identity?.mention || identity?.tag || '연결되지 않음'}`)
        .addFields({ name: '명령', value: roleCommands(topic).join('\n') });
      if (topic === 'orchestrator') {
        embed.addFields({
          name: '관리 명령',
          value: 'Provider, API key, model routing, bot 상태 관리 명령은 모두 이 봇에만 등록됩니다. 자세한 내용은 `/help topic:관리자 명령`을 사용합니다.',
        });
      }
      return embed;
    }

    if (topic === 'providers') {
      return embed
        .setTitle('Provider/API 키 도움말')
        .setDescription('오케스트레이터 봇의 `/admin` 또는 `/providers panel`에서 관리합니다.')
        .addFields(
          { name: 'Provider', value: '보안 설정 폼에서 Claude Code/Codex, base URL, Bearer Token/API Key/Basic Auth를 dropdown으로 설정합니다.' },
          { name: 'Secret', value: '직접 입력은 password input으로 받아 AES-256-GCM 암호화하며, ENV와 mode 0600 file 참조도 지원합니다.' },
          { name: '주의', value: '키 원문은 다시 표시되지 않으며 실행 중 session에는 hot-swap하지 않습니다.' },
        );
    }

    if (topic === 'specs') {
      return embed
        .setTitle('사양 기반 워크플로 도움말')
        .setDescription('오케스트레이터가 목표를 requirements/design/tasks 문서로 변환하고 승인된 task graph만 coder에게 배정합니다.')
        .addFields(
          { name: '시작', value: '`/goal` → 요구사항·설계·task manifest 작성 → `/spec approve` gate → `/spec run`' },
          { name: 'Reviewer 재작업', value: '`review.verdict: rework`가 들어오면 해당 task가 같은 역할 coder에게 자동 재배정됩니다.' },
          { name: 'Coder 이의', value: '`dispute.raise` → 오케스트레이터 전용 read-only 중재 세션 → `dispute.resolve` → 재작업 또는 리뷰 재개까지 자동 처리됩니다.' },
          { name: '비상 override', value: '오케스트레이터 하네스가 구조화 판정을 내리지 못한 경우에만 `/spec mediate`를 사용합니다.' },
          { name: '재개', value: '`/resume`은 planning/task/review뿐 아니라 미완료 자동 중재도 다시 시작합니다.' },
        );
    }

    if (topic === 'routing') {
      return embed
        .setTitle('역할별 모델 라우팅 도움말')
        .setDescription('오케스트레이터 봇의 `/admin`에서 검색 가능한 provider/model picker를 사용하거나 `/role-models panel`을 사용합니다.')
        .addFields(
          { name: '서버 기본값', value: '모든 project/forum thread에 적용되는 global binding.' },
          { name: '스레드 override', value: '현재 forum thread에만 적용되며 없으면 global 값을 상속합니다.' },
          { name: '역할 봇 확인', value: '선택한 역할의 실제 Discord bot account가 현재 채널에 preview 메시지를 전송합니다.' },
        );
    }

    return embed
      .setTitle('작업 이력 도움말')
      .setDescription('각 역할의 작업 메시지는 해당 역할 bot account가 직접 작성합니다.')
      .addFields(
        { name: 'Discord 기록', value: 'task/goal, harness, provider revision, model, branch, commit, 상태와 최근 출력이 역할별 embed로 표시됩니다.' },
        { name: '조회', value: ROLES.map((role) => `/${roleDefinition(role).commandPrefix}-history`).join('\n') },
        { name: '분리 기준', value: 'guild + forum thread + role 기준으로 `role_work_events`에 저장됩니다.' },
      );
  }
}

export const __test = { roleCommands, TOPICS };
