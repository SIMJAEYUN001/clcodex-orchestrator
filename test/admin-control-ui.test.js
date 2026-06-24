import assert from 'node:assert/strict';
import test from 'node:test';
import { PermissionFlagsBits } from 'discord.js';
import { AdminControlUi } from '../src/discord/admin-control-ui.js';

test('/admin is an Administrator-only guild command owned by the orchestrator application', () => {
  const command = new AdminControlUi({
    guildId: 'guild',
    adminSetupServer: { issueSession: () => ({ url: 'https://example.invalid', expiresAt: new Date().toISOString() }) },
  }).commandJson();
  assert.equal(command.name, 'admin');
  assert.equal(command.default_member_permissions, PermissionFlagsBits.Administrator.toString());
  assert.equal(command.dm_permission, false);
});
