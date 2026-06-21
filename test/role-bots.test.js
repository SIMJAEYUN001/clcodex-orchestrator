import assert from 'node:assert/strict';
import test from 'node:test';
import { PermissionFlagsBits } from 'discord.js';
import { loadRoleBotTokens } from '../src/config.js';
import { RoleBotSupervisor } from '../src/discord/role-bot-supervisor.js';
import { ROLES } from '../src/roles.js';

function tokens() {
  return {
    orchestrator: 'token-orchestrator',
    backend: 'token-backend',
    frontend: 'token-frontend',
    reviewer: 'token-reviewer',
  };
}

function supervisor(selectedTokens = tokens()) {
  return new RoleBotSupervisor({
    guildId: 'guild',
    forumChannelId: 'forum',
    tokens: selectedTokens,
    service: { list: () => [] },
    store: {
      resolveBinding: () => null,
      listWorkEvents: () => [],
    },
  });
}

test('configuration requires four distinct role bot tokens', () => {
  const environment = {
    DISCORD_ORCHESTRATOR_BOT_TOKEN: 'a',
    DISCORD_BACKEND_BOT_TOKEN: 'b',
    DISCORD_FRONTEND_BOT_TOKEN: 'c',
    DISCORD_REVIEWER_BOT_TOKEN: 'd',
  };
  assert.deepEqual(loadRoleBotTokens(environment), {
    orchestrator: 'a', backend: 'b', frontend: 'c', reviewer: 'd',
  });
  assert.throws(() => loadRoleBotTokens({ ...environment, DISCORD_REVIEWER_BOT_TOKEN: 'c' }), /distinct/);
  assert.throws(() => supervisor({ ...tokens(), reviewer: 'token-backend' }), /different Discord bot token/);
});

test('admin UI commands are registered only on the orchestrator application', () => {
  const instance = supervisor();
  instance.setAdminHandlers([
    { commandJson: () => ({ name: 'providers' }) },
    { commandJson: () => ({ name: 'role-models' }) },
  ]);
  const names = Object.fromEntries(ROLES.map((role) => [role, instance.commandsFor(role).map((item) => item.name)]));
  assert.deepEqual(names.orchestrator.sort(), [
    'orchestrator-history',
    'orchestrator-model',
    'providers',
    'role-bots',
    'role-models',
  ].sort());
  assert.deepEqual(names.backend.sort(), ['backend-history', 'backend-model']);
  assert.deepEqual(names.frontend.sort(), ['frontend-history', 'frontend-model']);
  assert.deepEqual(names.reviewer.sort(), ['reviewer-history', 'reviewer-model']);
  for (const role of ['backend', 'frontend', 'reviewer']) {
    assert.equal(names[role].includes('providers'), false);
    assert.equal(names[role].includes('role-models'), false);
  }
});

test('role-bots status command is administrator-only and unavailable in DMs', () => {
  const command = supervisor().commandsFor('orchestrator').find((item) => item.name === 'role-bots');
  assert.equal(command.default_member_permissions, PermissionFlagsBits.Administrator.toString());
  assert.equal(command.dm_permission, false);
});
