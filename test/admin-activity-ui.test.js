import assert from 'node:assert/strict';
import test from 'node:test';
import { PermissionFlagsBits } from 'discord.js';
import { AdminControlUi } from '../src/discord/admin-control-ui.js';

test('/admin launches a Discord Activity through the orchestrator-only launcher', async () => {
  let launched = null;
  const ui = new AdminControlUi({
    guildId: 'guild',
    forumChannelId: 'forum',
    mode: 'activity-relay',
    activityLauncher: {
      async launch(interaction, options) { launched = { interaction, options }; },
    },
  });
  const interaction = {
    commandName: 'admin', guildId: 'guild', user: { id: 'admin' },
    memberPermissions: { has: (permission) => permission === PermissionFlagsBits.Administrator },
    guild: { ownerId: 'owner' },
    channel: { id: 'thread', parentId: 'forum', isThread: () => true },
    isChatInputCommand: () => true,
  };
  assert.equal(await ui.handle(interaction), true);
  assert.equal(launched.interaction, interaction);
  assert.equal(launched.options.threadId, 'thread');
});
