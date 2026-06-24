import assert from 'node:assert/strict';
import test from 'node:test';
import { HelpUi } from '../src/discord/help-ui.js';

const roleBots = {
  identity(role) {
    return { ready: true, id: `${role}-id`, tag: `${role}#0001`, mention: `<@${role}-id>` };
  },
};

test('overview help clearly centralizes management commands on orchestrator', () => {
  const ui = new HelpUi({ guildId: 'guild', roleBots });
  const json = ui.view('overview', true).toJSON();
  assert.match(json.description, /관리·설정 명령은 \*\*오케스트레이터 봇\*\*에만/);
  const text = json.fields.map((field) => `${field.name}\n${field.value}`).join('\n');
  assert.match(text, /\/providers panel/);
  assert.match(text, /\/role-models panel/);
  assert.match(text, /\/role-bots status/);
  assert.match(text, /\/backend-history/);
});

test('admin help marks permission requirements and documents every management command', () => {
  const ui = new HelpUi({ guildId: 'guild', roleBots });
  const json = ui.view('admin', false).toJSON();
  assert.match(json.description, /Administrator/);
  assert.match(json.footer.text, /관리자 권한 없음/);
  assert.deepEqual(
    json.fields.map((field) => field.name),
    [
      '/admin', '/providers panel', '/providers audit', '/role-models panel scope:<범위>', '/role-models status',
      '/role-bots status', '/project create|bind|delete|status', '/goal · /spec · /resume',
    ],
  );
});

test('role help identifies the role bot and lists only role-local read commands', () => {
  const ui = new HelpUi({ guildId: 'guild', roleBots });
  const json = ui.view('backend', true).toJSON();
  assert.match(json.description, /<@backend-id>/);
  assert.match(json.fields[0].value, /\/backend-model/);
  assert.match(json.fields[0].value, /\/backend-history/);
  assert.equal(json.fields[0].value.includes('/providers'), false);
});
