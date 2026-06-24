#!/usr/bin/env node
const [command, rawPayload = '{}'] = process.argv.slice(2);
if (!command) {
  console.error('Usage: clcodex-tool <command> <json-payload>');
  process.exit(2);
}
const url = process.env.CLCODEX_TOOL_URL;
const token = process.env.CLCODEX_TOOL_TOKEN;
if (!url || !token) {
  console.error('CLCODEX_TOOL_URL and CLCODEX_TOOL_TOKEN are required');
  process.exit(2);
}
let payload;
try {
  payload = JSON.parse(rawPayload);
} catch (error) {
  console.error(`Invalid JSON payload: ${error.message}`);
  process.exit(2);
}
const response = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify({ command, payload }),
  redirect: 'error',
  signal: AbortSignal.timeout(30_000),
});
const result = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }));
if (!response.ok || !result.ok) {
  console.error(result.error || `HTTP ${response.status}`);
  process.exit(1);
}
process.stdout.write(`${JSON.stringify(result.result)}\n`);
