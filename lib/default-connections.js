/**
 * 预置连接：由部署方在 config.defaultConnections 里声明的目录卡片，首次启动时
 * 自动连接，之后交给用户管理。
 *
 * 规则：
 *   - auth.mode === 'none' 的卡片直接连；凭据型卡片只有在预置项声明了
 *     `credentialService`（宿主上提供凭据的服务名）且该服务此刻给得出凭据时才连，
 *     否则跳过等下次（服务出现或凭据变化时 index.js 会重新规划）；
 *   - 凭据型预置项已连接但凭据与服务当前给出的不同时列入 refresh（凭据轮换）；
 *   - 同一 key 只预置一次：已连接、或曾经预置过（含用户随后主动断开）的都跳过，
 *     所以断开一条预置连接不会在下次启动时被重新塞回来；
 *   - 连接失败不记账，下次启动重试。
 *
 * 本模块只做纯函数的归一与规划；真正的 connect 由 index.js 用现有 api.connect 完成，
 * 预置连接因此与用户在市场里点"连接"得到的记录完全一致（同 key、同作用域、同快照）。
 */

/** 归一化 config.defaultConnections：字符串视为 connectorId，对象可带 serverKey。 */
export function normalizeDefaultConnections(raw) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(raw) ? raw : []) {
    let connectorId;
    let serverKey;
    let credentialService;
    if (typeof item === 'string') {
      connectorId = item;
    } else if (item && typeof item === 'object') {
      connectorId = item.connectorId;
      serverKey = item.serverKey;
      credentialService = item.credentialService;
    }
    connectorId = typeof connectorId === 'string' ? connectorId.trim() : '';
    if (!connectorId) throw new Error('defaultConnections: 每一项必须给出 connectorId');
    serverKey = typeof serverKey === 'string' && serverKey.trim() ? serverKey.trim() : undefined;
    credentialService = typeof credentialService === 'string' && credentialService.trim() ? credentialService.trim() : undefined;
    const id = `${connectorId}\u0000${serverKey ?? ''}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const normalized = { connectorId };
    if (serverKey) normalized.serverKey = serverKey;
    if (credentialService) normalized.credentialService = credentialService;
    out.push(normalized);
  }
  return out;
}

/** 预置项对应的连接 key，与 index.js 里 auth=none 的 connect 路径一致。 */
export function defaultConnectionKey(connector, serverKey) {
  const server = connector.servers.find((item) => item.serverKey === serverKey) ?? connector.servers[0];
  return `${connector.id}-${server.serverKey}`;
}

/** 凭据对象里代表"主凭据"的值：与 index.js 的 connect/configure 入参一致。 */
export function primaryCredentialValue(credential) {
  if (!credential || typeof credential !== 'object') return undefined;
  if (typeof credential.bearerToken === 'string' && credential.bearerToken !== '') return credential.bearerToken;
  if (typeof credential.apiKeyValue === 'string' && credential.apiKeyValue !== '') return credential.apiKeyValue;
  const values = credential.credentialValues;
  if (values && typeof values === 'object') {
    const first = Object.values(values).find((value) => typeof value === 'string' && value !== '');
    if (first !== undefined) return first;
  }
  return undefined;
}

/**
 * 规划本次启动要连接哪些预置项。
 * @param {object} input
 * @param {Array<{connectorId: string, serverKey?: string, credentialService?: string}>} input.defaults 归一化后的预置列表
 * @param {Array<object>} input.catalog 当前合并目录
 * @param {Iterable<string>} input.connectionKeys 已有连接的 key
 * @param {Iterable<string>} input.seededKeys 曾预置过的 key
 * @param {Map<string, object|undefined>} [input.credentials] 按 connectorId 给出的凭据（来自 credentialService）
 * @param {Map<string, string|undefined>} [input.connectionCredentials] 已有连接的主凭据值，按 key
 * @returns {{ connect: Array<{connectorId: string, serverKey?: string, key: string, credential?: object}>, refresh: Array<{connectorId: string, key: string, credential: object}>, skipped: Array<{connectorId: string, reason: string}> }}
 */
export function planDefaultConnections({ defaults, catalog, connectionKeys, seededKeys, credentials = new Map(), connectionCredentials = new Map() }) {
  const existing = new Set(connectionKeys);
  const seeded = new Set(seededKeys);
  const connect = [];
  const refresh = [];
  const skipped = [];
  for (const item of defaults) {
    const connector = catalog.find((candidate) => candidate.id === item.connectorId);
    if (!connector) {
      skipped.push({ connectorId: item.connectorId, reason: 'missing-connector' });
      continue;
    }
    const credentialed = connector.auth?.mode !== 'none';
    if (credentialed && !item.credentialService) {
      skipped.push({ connectorId: item.connectorId, reason: 'requires-credentials' });
      continue;
    }
    if (item.serverKey && !connector.servers.some((server) => server.serverKey === item.serverKey)) {
      skipped.push({ connectorId: item.connectorId, reason: 'missing-server' });
      continue;
    }
    const key = defaultConnectionKey(connector, item.serverKey);
    const credential = credentialed ? credentials.get(item.connectorId) : undefined;
    if (credentialed && primaryCredentialValue(credential) === undefined) {
      skipped.push({ connectorId: item.connectorId, reason: 'credential-unavailable' });
      continue;
    }
    if (existing.has(key)) {
      // A connection seeded from a service whose credential has since changed
      // (a rotated or re-issued key) is re-configured in place rather than left
      // to fail with 401 until the user notices. Only when the current value is
      // known: a connection whose credential this process cannot see is left alone.
      const current = connectionCredentials.get(key);
      if (credentialed && current !== undefined && current !== primaryCredentialValue(credential)) {
        refresh.push({ connectorId: item.connectorId, key, credential });
        continue;
      }
      skipped.push({ connectorId: item.connectorId, reason: 'already-connected' });
      continue;
    }
    if (seeded.has(key)) {
      skipped.push({ connectorId: item.connectorId, reason: 'already-seeded' });
      continue;
    }
    connect.push(credentialed ? { ...item, key, credential } : { ...item, key });
  }
  return { connect, refresh, skipped };
}
