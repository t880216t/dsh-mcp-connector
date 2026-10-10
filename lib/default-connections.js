/**
 * 预置连接：由部署方在 config.defaultConnections 里声明的目录卡片，首次启动时
 * 自动连接，之后交给用户管理。
 *
 * 规则：
 *   - 只处理 auth.mode === 'none' 的卡片（凭据型卡片必须由用户本机填写）；
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
    if (typeof item === 'string') {
      connectorId = item;
    } else if (item && typeof item === 'object') {
      connectorId = item.connectorId;
      serverKey = item.serverKey;
    }
    connectorId = typeof connectorId === 'string' ? connectorId.trim() : '';
    if (!connectorId) throw new Error('defaultConnections: 每一项必须给出 connectorId');
    serverKey = typeof serverKey === 'string' && serverKey.trim() ? serverKey.trim() : undefined;
    const id = `${connectorId}\u0000${serverKey ?? ''}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(serverKey ? { connectorId, serverKey } : { connectorId });
  }
  return out;
}

/** 预置项对应的连接 key，与 index.js 里 auth=none 的 connect 路径一致。 */
export function defaultConnectionKey(connector, serverKey) {
  const server = connector.servers.find((item) => item.serverKey === serverKey) ?? connector.servers[0];
  return `${connector.id}-${server.serverKey}`;
}

/**
 * 规划本次启动要连接哪些预置项。
 * @param {object} input
 * @param {Array<{connectorId: string, serverKey?: string}>} input.defaults 归一化后的预置列表
 * @param {Array<object>} input.catalog 当前合并目录
 * @param {Iterable<string>} input.connectionKeys 已有连接的 key
 * @param {Iterable<string>} input.seededKeys 曾预置过的 key
 * @returns {{ connect: Array<{connectorId: string, serverKey?: string, key: string}>, skipped: Array<{connectorId: string, reason: string}> }}
 */
export function planDefaultConnections({ defaults, catalog, connectionKeys, seededKeys }) {
  const existing = new Set(connectionKeys);
  const seeded = new Set(seededKeys);
  const connect = [];
  const skipped = [];
  for (const item of defaults) {
    const connector = catalog.find((candidate) => candidate.id === item.connectorId);
    if (!connector) {
      skipped.push({ connectorId: item.connectorId, reason: 'missing-connector' });
      continue;
    }
    if (connector.auth?.mode !== 'none') {
      skipped.push({ connectorId: item.connectorId, reason: 'requires-credentials' });
      continue;
    }
    if (item.serverKey && !connector.servers.some((server) => server.serverKey === item.serverKey)) {
      skipped.push({ connectorId: item.connectorId, reason: 'missing-server' });
      continue;
    }
    const key = defaultConnectionKey(connector, item.serverKey);
    if (existing.has(key)) {
      skipped.push({ connectorId: item.connectorId, reason: 'already-connected' });
      continue;
    }
    if (seeded.has(key)) {
      skipped.push({ connectorId: item.connectorId, reason: 'already-seeded' });
      continue;
    }
    connect.push({ ...item, key });
  }
  return { connect, skipped };
}
