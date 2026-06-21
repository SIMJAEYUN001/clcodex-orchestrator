export const ROLE_DEFINITIONS = Object.freeze({
  orchestrator: Object.freeze({
    key: 'orchestrator',
    label: '오케스트레이터',
    commandPrefix: 'orchestrator',
    color: 0x7c3aed,
    tokenEnvironment: 'DISCORD_ORCHESTRATOR_BOT_TOKEN',
  }),
  backend: Object.freeze({
    key: 'backend',
    label: '백엔드 코더',
    commandPrefix: 'backend',
    color: 0x16a34a,
    tokenEnvironment: 'DISCORD_BACKEND_BOT_TOKEN',
  }),
  frontend: Object.freeze({
    key: 'frontend',
    label: '프론트엔드 코더',
    commandPrefix: 'frontend',
    color: 0x2563eb,
    tokenEnvironment: 'DISCORD_FRONTEND_BOT_TOKEN',
  }),
  reviewer: Object.freeze({
    key: 'reviewer',
    label: '리뷰어',
    commandPrefix: 'reviewer',
    color: 0xd97706,
    tokenEnvironment: 'DISCORD_REVIEWER_BOT_TOKEN',
  }),
});

export const ROLES = Object.freeze(Object.keys(ROLE_DEFINITIONS));
const ROLE_SET = new Set(ROLES);

export function isRole(value) {
  return ROLE_SET.has(value);
}

export function requireRole(value) {
  if (!isRole(value)) throw new Error(`Unknown role: ${value}`);
  return value;
}

export function roleDefinition(role) {
  return ROLE_DEFINITIONS[requireRole(role)];
}

export function roleLabel(role) {
  return roleDefinition(role).label;
}
