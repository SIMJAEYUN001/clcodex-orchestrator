import dns from 'node:dns/promises';
import net from 'node:net';

const BLOCKED_NAMES = new Set(['metadata.google.internal', 'instance-data.ec2.internal']);

function ipv4Int(value) {
  return value.split('.').reduce((result, part) => ((result << 8) | Number(part)) >>> 0, 0);
}

function inRange(value, base, prefix) {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipv4Int(value) & mask) === (ipv4Int(base) & mask);
}

function classify(address) {
  const value = String(address).toLowerCase().split('%')[0];
  if (net.isIPv4(value)) {
    if (value === '169.254.169.254' || value === '100.100.100.200') return 'metadata';
    if (inRange(value, '127.0.0.0', 8)) return 'loopback';
    if (inRange(value, '10.0.0.0', 8) || inRange(value, '172.16.0.0', 12) || inRange(value, '192.168.0.0', 16)) return 'private';
    if (inRange(value, '100.64.0.0', 10)) return 'cgnat';
    if (inRange(value, '169.254.0.0', 16)) return 'link-local';
    if (inRange(value, '224.0.0.0', 4)) return 'multicast';
    if (inRange(value, '0.0.0.0', 8)) return 'unspecified';
    return 'public';
  }
  if (net.isIPv6(value)) {
    if (value === '::1') return 'loopback';
    if (value === '::') return 'unspecified';
    if (/^fe[89ab]/.test(value)) return 'link-local';
    if (/^f[cd]/.test(value)) return 'private';
    if (value.startsWith('ff')) return 'multicast';
    if (value.startsWith('::ffff:')) return classify(value.slice(7));
    return 'public';
  }
  return 'unknown';
}

function hostMatches(hostname, pattern) {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  const rule = String(pattern).toLowerCase().trim().replace(/\.$/, '');
  if (rule.startsWith('*.')) {
    const suffix = rule.slice(1);
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  return host === rule;
}

export class ProxyNetworkPolicy {
  constructor({ allowedHosts = [], allowLoopback = true, allowInsecureLoopback = true } = {}) {
    this.allowedHosts = allowedHosts;
    this.allowLoopback = allowLoopback;
    this.allowInsecureLoopback = allowInsecureLoopback;
  }

  parseBaseUrl(raw) {
    let url;
    try {
      url = new URL(String(raw || '').trim());
    } catch {
      throw new Error('Base URL is invalid');
    }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Base URL must use HTTP or HTTPS');
    if (url.username || url.password) throw new Error('Base URL must not contain credentials');
    if (url.search || url.hash) throw new Error('Base URL must not contain query or fragment data');
    if (BLOCKED_NAMES.has(url.hostname.toLowerCase().replace(/\.$/, ''))) throw new Error('Metadata endpoints are blocked');
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url;
  }

  modelsPath(raw) {
    const value = String(raw || '/v1/models').trim();
    if (!value.startsWith('/')) throw new Error('Models path must start with /');
    const parsed = new URL(value, 'https://validation.invalid');
    if (parsed.origin !== 'https://validation.invalid' || parsed.search || parsed.hash) {
      throw new Error('Models path must be a path without query or fragment data');
    }
    return parsed.pathname;
  }

  explicitlyAllowed(hostname) {
    return this.allowedHosts.some((rule) => hostMatches(hostname, rule));
  }

  async assertAllowed(raw) {
    const url = this.parseBaseUrl(raw);
    const explicit = this.explicitlyAllowed(url.hostname);
    let addresses;
    try {
      addresses = await dns.lookup(url.hostname, { all: true, verbatim: true });
    } catch (error) {
      throw new Error(`Unable to resolve provider hostname: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!addresses.length) throw new Error('Provider hostname resolved to no addresses');
    for (const item of addresses) {
      const kind = classify(item.address);
      if (['metadata', 'link-local', 'multicast', 'unspecified'].includes(kind)) throw new Error(`Blocked provider address class: ${kind}`);
      if (kind === 'loopback' && !this.allowLoopback) throw new Error('Loopback providers are disabled');
      if (['private', 'cgnat'].includes(kind) && !explicit) throw new Error('Private provider host must be listed in PROXY_ALLOWED_HOSTS');
    }
    const loopbackOnly = addresses.every((item) => classify(item.address) === 'loopback');
    if (url.protocol === 'http:' && !(loopbackOnly && this.allowInsecureLoopback)) {
      throw new Error('Plain HTTP is allowed only for an enabled loopback provider');
    }
    return url;
  }
}

export const __test = { classify, hostMatches };
