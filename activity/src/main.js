import { apiRouteToMethod } from '../../shared/admin-protocol.js';
import { HTML, CSS } from '../../src/admin/control-center-assets.js';
import { connectActivityTransport } from './secure-transport.js';

const nativeFetch = globalThis.fetch.bind(globalThis);
const bootStatus = document.getElementById('activity-status');
const setStatus = (message) => { if (bootStatus) bootStatus.textContent = message; };

function mountShell() {
  const parsed = new DOMParser().parseFromString(HTML, 'text/html');
  document.title = parsed.title;
  document.body.innerHTML = parsed.body.innerHTML;
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.append(style);
  const notice = document.getElementById('notice');
  if (notice) {
    notice.innerHTML = '<strong>Discord Activity · E2EE relay</strong>로 연결되었습니다. API 키를 포함한 RPC payload는 로컬 오케스트레이터만 복호화합니다. 실행 중 세션에는 변경사항을 적용하지 않습니다.';
  }
}

function installFetchAdapter(transport) {
  globalThis.fetch = async (input, init = {}) => {
    const raw = typeof input === 'string' ? input : input.url;
    const url = new URL(raw, location.origin);
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) {
      return nativeFetch(input, init);
    }
    const method = String(init.method || 'GET').toUpperCase();
    const rpcMethod = apiRouteToMethod(url.pathname, method);
    if (!rpcMethod) return new Response(JSON.stringify({ ok: false, error: 'API route not found' }), { status: 404 });
    let params = {};
    if (init.body) params = JSON.parse(String(init.body));
    try {
      const result = await transport.request(rpcMethod, params);
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    } catch (error) {
      return new Response(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }
  };
}

async function boot() {
  const connected = await connectActivityTransport({ onStatus: setStatus });
  installFetchAdapter(connected.transport);
  history.replaceState(null, '', `${location.pathname}${location.search}#token=discord-activity`);
  mountShell();
  const script = document.createElement('script');
  script.src = '/control-center-app.js';
  script.defer = true;
  document.body.append(script);
}

boot().catch((error) => {
  console.error(error);
  setStatus(error instanceof Error ? error.message : String(error));
});
