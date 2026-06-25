export const ADMIN_PROTOCOL_VERSION = 1;

export const ADMIN_RPC_METHODS = Object.freeze([
  'admin.bootstrap',
  'providers.discover',
  'providers.create',
  'providers.test',
  'providers.sync',
  'providers.toggle',
  'providers.delete',
  'bindings.save',
  'policy.save',
]);

export const ADMIN_RPC_METHOD_SET = new Set(ADMIN_RPC_METHODS);

const ROUTES = new Map([
  ['GET /api/bootstrap', 'admin.bootstrap'],
  ['POST /api/providers/discover', 'providers.discover'],
  ['POST /api/discover', 'providers.discover'],
  ['POST /api/providers/create', 'providers.create'],
  ['POST /api/save', 'providers.create'],
  ['POST /api/providers/test', 'providers.test'],
  ['POST /api/providers/sync', 'providers.sync'],
  ['POST /api/providers/toggle', 'providers.toggle'],
  ['POST /api/providers/delete', 'providers.delete'],
  ['POST /api/bindings/save', 'bindings.save'],
  ['POST /api/policy/save', 'policy.save'],
]);

export function apiRouteToMethod(pathname, method = 'POST') {
  return ROUTES.get(`${String(method).toUpperCase()} ${pathname}`) || null;
}

export function assertRpcMethod(method) {
  const value = String(method || '');
  if (!ADMIN_RPC_METHOD_SET.has(value)) throw new Error(`Unsupported admin RPC method: ${value || '(empty)'}`);
  return value;
}

export function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function assertProtocolMessage(value) {
  if (!isPlainObject(value)) throw new Error('Protocol message must be an object');
  if (value.version !== ADMIN_PROTOCOL_VERSION) throw new Error('Unsupported admin relay protocol version');
  if (typeof value.type !== 'string' || !value.type) throw new Error('Protocol message type is required');
  return value;
}
