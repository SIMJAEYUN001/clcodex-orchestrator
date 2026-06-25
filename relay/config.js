function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function integer(name, fallback, minimum = 0) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < minimum) throw new Error(`${name} must be an integer >= ${minimum}`);
  return value;
}

function list(name) {
  return (process.env[name] || '').split(',').map((item) => item.trim()).filter(Boolean);
}


function exactHttpsOrigins(name) {
  const values = list(name);
  const origins = values.map((value) => {
    let url;
    try { url = new URL(value); } catch { throw new Error(`${name} contains an invalid URL`); }
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error(`${name} entries must be exact HTTPS origins without credentials, path, query, or fragment`);
    }
    return url.origin;
  });
  return [...new Set(origins)];
}

function discordApplicationId(name) {
  const value = required(name);
  if (!/^\d{15,25}$/.test(value)) throw new Error(`${name} must be a Discord application snowflake`);
  return value;
}

function devices() {
  let parsed;
  try {
    parsed = JSON.parse(required('RELAY_DEVICES_JSON'));
  } catch (error) {
    throw new Error(`RELAY_DEVICES_JSON must be a JSON object: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('RELAY_DEVICES_JSON must be a JSON object');
  const entries = Object.entries(parsed);
  if (!entries.length) throw new Error('RELAY_DEVICES_JSON must contain at least one installation');
  for (const [installationId, token] of entries) {
    if (!installationId || typeof token !== 'string' || token.length < 32) {
      throw new Error('Each relay device entry requires an installation ID and a token of at least 32 characters');
    }
  }
  return new Map(entries);
}

export function loadRelayConfig() {
  const activityOrigins = exactHttpsOrigins('RELAY_ACTIVITY_ORIGINS');
  if (!activityOrigins.length) throw new Error('RELAY_ACTIVITY_ORIGINS is required');
  return {
    host: process.env.RELAY_HOST?.trim() || '127.0.0.1',
    port: integer('RELAY_PORT', 8790),
    activityOrigins,
    devices: devices(),
    discordClientId: discordApplicationId('RELAY_DISCORD_CLIENT_ID'),
    discordClientSecret: required('RELAY_DISCORD_CLIENT_SECRET'),
    oauthRedirectUri: process.env.RELAY_OAUTH_REDIRECT_URI?.trim() || null,
    oauthSessionTtlMs: integer('RELAY_OAUTH_SESSION_TTL_MS', 120_000, 10_000),
    activitySessionTtlMs: integer('RELAY_ACTIVITY_SESSION_TTL_MS', 300_000, 30_000),
    maxPayloadBytes: integer('RELAY_MAX_PAYLOAD_BYTES', 1_000_000, 16_384),
    maxMessagesPerMinute: integer('RELAY_MAX_MESSAGES_PER_MINUTE', 180, 10),
  };
}
