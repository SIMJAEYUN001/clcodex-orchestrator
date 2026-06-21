import assert from 'node:assert/strict';
import test from 'node:test';
import { PermissionFlagsBits } from 'discord.js';
import { isServerAdministrator } from '../src/discord/common.js';
import { ProviderAdminUi } from '../src/discord/provider-ui.js';
import { RoleModelAdminUi } from '../src/discord/role-model-ui.js';

const service = { list: () => [] };
const store = { listAudit: () => [] };

test('both server commands declare Administrator as their default member permission and disable DMs', () => {
  const providerCommand = new ProviderAdminUi({ guildId: 'guild', service, store }).commandJson();
  const roleCommand = new RoleModelAdminUi({ guildId: 'guild', forumChannelId: 'forum', service, store }).commandJson();
  for (const command of [providerCommand, roleCommand]) {
    assert.equal(command.default_member_permissions, PermissionFlagsBits.Administrator.toString());
    assert.equal(command.dm_permission, false);
  }
});

test('runtime authorization accepts only guild owner or Administrator, not ManageGuild alone', () => {
  const base = {
    guildId: 'guild',
    user: { id: 'user' },
    guild: { ownerId: 'owner' },
  };
  assert.equal(isServerAdministrator({ ...base, user: { id: 'owner' } }, 'guild'), true);
  assert.equal(isServerAdministrator({ ...base, memberPermissions: { has: (flag) => flag === PermissionFlagsBits.Administrator } }, 'guild'), true);
  assert.equal(isServerAdministrator({ ...base, memberPermissions: { has: () => false } }, 'guild'), false);
  assert.equal(isServerAdministrator({ ...base, guildId: 'other', memberPermissions: { has: () => true } }, 'guild'), false);
});
