import { loadRelayConfig } from './config.js';
import { AdminRelayServer } from './server.js';

const relay = new AdminRelayServer(loadRelayConfig());
let closing = false;

async function shutdown(signal, code = 0) {
  if (closing) return;
  closing = true;
  console.log(`Received ${signal}; shutting down admin relay`);
  await relay.close();
  process.exit(code);
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await relay.start();
  const address = relay.address();
  console.log(`Admin relay listening on ${typeof address === 'string' ? address : `${address.address}:${address.port}`}`);
} catch (error) {
  console.error('Admin relay startup failed:', error instanceof Error ? error.message : String(error));
  await shutdown('startup-error', 1);
}
