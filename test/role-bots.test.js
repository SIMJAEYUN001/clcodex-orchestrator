import assert from 'node:assert/strict';
import test from 'node:test';
import { PermissionFlagsBits } from 'discord.js';
import { loadRoleBotTokens } from '../src/config.js';
import { HelpUi } from '../src/discord/help-ui.js';
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

test('all management and help commands are registered only on the orchestrator application', () => {
  const instance = supervisor();
  const help = new HelpUi({ guildId: 'guild', roleBots: instance });
  instance.setOrchestratorHandlers([
    help,
    { commandJson: () => ({ name: 'admin' }) },
    { commandJson: () => ({ name: 'providers' }) },
    { commandJson: () => ({ name: 'role-models' }) },
  ]);
  const names = Object.fromEntries(ROLES.map((role) => [role, instance.commandsFor(role).map((item) => item.name)]));
  assert.deepEqual(names.orchestrator.sort(), [
    'admin',
    'help',
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
    for (const management of ['admin', 'help', 'providers', 'role-models', 'role-bots']) {
      assert.equal(names[role].includes(management), false, `${management} leaked to ${role}`);
    }
  }
});

test('role-bots status is administrator-only while help is guild-only and public', () => {
  const instance = supervisor();
  const help = new HelpUi({ guildId: 'guild', roleBots: instance });
  instance.setOrchestratorHandlers([help]);
  const commands = instance.commandsFor('orchestrator');
  const status = commands.find((item) => item.name === 'role-bots');
  const helpCommand = commands.find((item) => item.name === 'help');
  assert.equal(status.default_member_permissions, PermissionFlagsBits.Administrator.toString());
  assert.equal(status.dm_permission, false);
  assert.equal(helpCommand.default_member_permissions, undefined);
  assert.equal(helpCommand.dm_permission, false);
});
