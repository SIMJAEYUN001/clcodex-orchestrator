import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import {
  decryptEnvelope,
  deriveSessionKey,
  encryptEnvelope,
  exportPublicJwk,
  generateEcdhKeyPair,
  handshakeTranscript,
} from '../../shared/admin-e2ee.js';
import {
  ADMIN_PROTOCOL_VERSION,
  assertProtocolMessage,
  assertRpcMethod,
  isPlainObject,
} from '../../shared/admin-protocol.js';

function redactError(error) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [REDACTED]')
    .slice(0, 800);
}

function boundedString(value, label, max = 256) {
  const result = String(value || '').trim();
  if (!result || result.length > max) throw new Error(`${label} is invalid`);
  return result;
}

export class AdminRelayClient {
  constructor({
    url,
    installationId,
    deviceToken,
    identity,
    grantStore,
    controlPlane,
    authorizeAdministrator,
    reconnectMinMs = 1_000,
    reconnectMaxMs = 30_000,
    maxPayloadBytes = 1_000_000,
    logger = console,
  }) {
    this.url = url;
    this.installationId = installationId;
    this.deviceToken = deviceToken;
    this.identity = identity;
    this.grantStore = grantStore;
    this.controlPlane = controlPlane;
    this.authorizeAdministrator = authorizeAdministrator;
    this.reconnectMinMs = reconnectMinMs;
    this.reconnectMaxMs = reconnectMaxMs;
    this.maxPayloadBytes = maxPayloadBytes;
    this.logger = logger;
    this.socket = null;
    this.sessions = new Map();
    this.stopped = true;
    this.retryMs = reconnectMinMs;
    this.reconnectTimer = null;
    this.readyPromise = null;
    this.readyResolve = null;
    this.readyReject = null;
  }

  async start() {
    if (!this.stopped) return this.readyPromise;
    this.stopped = false;
    await this.identity.initialize();
    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this.connect();
    return this.readyPromise;
  }

  connect() {
    if (this.stopped || this.socket) return;
    const configured = new URL(this.url);
    const target = configured.pathname === '/v1/device'
      ? configured
      : new URL('/v1/device', configured);
    target.searchParams.set('installation_id', this.installationId);
    const socket = new WebSocket(target, {
      headers: { authorization: `Bearer ${this.deviceToken}` },
      maxPayload: this.maxPayloadBytes,
      handshakeTimeout: 12_000,
      perMessageDeflate: false,
    });
    this.socket = socket;
    socket.on('open', () => {
      this.retryMs = this.reconnectMinMs;
      this.send({
        version: ADMIN_PROTOCOL_VERSION,
        type: 'device.hello',
        installationId: this.installationId,
        device: this.identity.metadata(),
      });
    });
    socket.on('message', (data) => void this.onMessage(data));
    socket.on('error', (error) => {
      this.logger.error('Admin relay WebSocket error:', redactError(error));
    });
    socket.on('close', (code, reason) => {
      this.relayReady = false;
      if (this.socket === socket) this.socket = null;
      this.closeAllSessions(`relay disconnected (${code}: ${String(reason)})`);
      if (!this.stopped) this.scheduleReconnect();
    });
  }

  scheduleReconnect() {
    if (this.reconnectTimer || this.stopped) return;
    const delay = this.retryMs;
    this.retryMs = Math.min(this.reconnectMaxMs, Math.max(this.reconnectMinMs, this.retryMs * 2));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  isReady() {
    return this.socket?.readyState === WebSocket.OPEN && this.relayReady === true;
  }

  send(message) {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error('Admin relay is not connected');
    const encoded = JSON.stringify(message);
    if (Buffer.byteLength(encoded) > this.maxPayloadBytes) throw new Error('Admin relay message exceeds the payload limit');
    this.socket.send(encoded);
  }

  async onMessage(data) {
    try {
      if (Buffer.byteLength(data) > this.maxPayloadBytes) throw new Error('Relay message exceeds the payload limit');
      const message = assertProtocolMessage(JSON.parse(data.toString('utf8')));
      if (message.type === 'relay.ready') {
        this.relayReady = true;
        this.readyResolve?.(this.identity.metadata());
        this.readyResolve = null;
        this.readyReject = null;
        return;
      }
      if (message.type === 'activity.open') {
        await this.openActivity(message);
        return;
      }
      if (message.type === 'rpc.request') {
        const session = this.sessions.get(String(message.sessionId || ''));
        if (!session) throw new Error('Unknown relay session');
        session.queue = session.queue
          .then(() => this.handleRpcRequest(session, message))
          .catch((error) => {
            this.closeSession(session.id, 'invalid or unauthorized RPC');
            throw error;
          });
        await session.queue;
        return;
      }
      if (message.type === 'activity.close') {
        this.closeSession(String(message.sessionId || ''), 'activity closed');
      }
    } catch (error) {
      this.logger.error('Admin relay message rejected:', redactError(error));
    }
  }

  async openActivity(message) {
    const sessionId = boundedString(message.sessionId, 'sessionId');
    const guildId = boundedString(message.guildId, 'guildId', 32);
    const userId = boundedString(message.userId, 'userId', 32);
    const channelId = message.channelId ? boundedString(message.channelId, 'channelId', 32) : null;
    try {
      if (this.sessions.has(sessionId)) throw new Error('Relay session already exists');
      const permitted = await this.authorizeAdministrator({ guildId, userId });
      if (!permitted) throw new Error('Discord Administrator 권한이 확인되지 않았습니다.');
      const grant = this.grantStore.consume({ guildId, userId, threadId: channelId });
      const expiresAt = Math.min(
        Number(message.expiresAt) || grant.sessionExpiresAt,
        grant.sessionExpiresAt,
      );
      if (expiresAt <= Date.now()) throw new Error('Admin grant expired before the Activity connected');
      const keyPair = await generateEcdhKeyPair();
      const devicePublicKey = await exportPublicJwk(keyPair.publicKey);
      const transcript = handshakeTranscript({
        sessionId,
        guildId,
        channelId,
        userId,
        clientPublicKey: message.clientPublicKey,
        devicePublicKey,
        expiresAt,
      });
      const key = await deriveSessionKey({
        privateKey: keyPair.privateKey,
        peerPublicJwk: message.clientPublicKey,
        transcript,
      });
      const signature = await this.identity.sign(transcript);
      const metadata = this.identity.metadata();
      const controlSessionId = this.controlPlane.openSession({
        guildId,
        userId,
        threadId: grant.threadId,
        expiresAt,
        transport: 'activity-relay',
        metadata: { deviceFingerprint: metadata.fingerprint, relaySessionId: sessionId },
      });
      const session = {
        id: sessionId,
        guildId,
        channelId,
        userId,
        grantId: grant.id,
        controlSessionId,
        key,
        recvSequence: 0,
        sendSequence: 0,
        expiresAt,
        queue: Promise.resolve(),
      };
      this.sessions.set(sessionId, session);
      this.send({
        version: ADMIN_PROTOCOL_VERSION,
        type: 'activity.accept',
        sessionId,
        guildId,
        channelId,
        userId,
        expiresAt,
        devicePublicKey,
        deviceSigningPublicKey: metadata.publicKey,
        deviceFingerprint: metadata.fingerprint,
        signature,
      });
    } catch (error) {
      this.send({
        version: ADMIN_PROTOCOL_VERSION,
        type: 'activity.reject',
        sessionId,
        error: redactError(error),
      });
    }
  }

  async handleRpcRequest(session, message) {
    if (Date.now() >= session.expiresAt) {
      this.closeSession(session.id, 'session expired');
      throw new Error('Admin relay session expired');
    }
    const sequence = Number(message.sequence);
    if (!Number.isSafeInteger(sequence) || sequence !== session.recvSequence + 1) {
      throw new Error('Out-of-order or replayed admin request');
    }
    const request = await decryptEnvelope({
      key: session.key,
      sessionId: session.id,
      direction: 'activity-to-device',
      sequence,
      iv: message.iv,
      ciphertext: message.ciphertext,
    });
    session.recvSequence = sequence;
    if (!isPlainObject(request)) throw new Error('Admin request envelope is invalid');
    const requestId = boundedString(request.requestId || randomUUID(), 'requestId');
    let response;
    let closeAfterResponse = false;
    try {
      const permitted = await this.authorizeAdministrator({ guildId: session.guildId, userId: session.userId });
      if (!permitted) {
        closeAfterResponse = true;
        throw new Error('Discord Administrator 권한이 더 이상 유효하지 않습니다.');
      }
      const method = assertRpcMethod(request.method);
      const result = await this.controlPlane.invoke(session.controlSessionId, method, request.params || {});
      response = { requestId, ok: true, result };
    } catch (error) {
      response = { requestId, ok: false, error: redactError(error) };
    }
    session.sendSequence += 1;
    const encrypted = await encryptEnvelope({
      key: session.key,
      sessionId: session.id,
      direction: 'device-to-activity',
      sequence: session.sendSequence,
      value: response,
    });
    this.send({
      version: ADMIN_PROTOCOL_VERSION,
      type: 'rpc.response',
      sessionId: session.id,
      ...encrypted,
    });
    if (closeAfterResponse) this.closeSession(session.id, 'Administrator permission was revoked');
  }

  closeSession(sessionId, reason = 'closed') {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    this.controlPlane.closeSession(session.controlSessionId);
    this.grantStore.revoke(session.grantId);
    if (this.isReady()) {
      try {
        this.send({ version: ADMIN_PROTOCOL_VERSION, type: 'device.session.closed', sessionId, reason });
      } catch {
        // Relay is already unavailable.
      }
    }
  }

  closeAllSessions(reason) {
    for (const id of [...this.sessions.keys()]) this.closeSession(id, reason);
  }

  async stop() {
    this.stopped = true;
    this.relayReady = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.closeAllSessions('device stopped');
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 1_000);
      socket.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.close(1000, 'device shutdown');
    });
  }
}
