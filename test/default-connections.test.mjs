import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { normalizeDefaultConnections, planDefaultConnections, defaultConnectionKey, primaryCredentialValue } from '../lib/default-connections.js';
import { Config, apply } from '../lib/index.js';

const catalog = [
  { id: 'local-tools', name: 'Local', auth: { mode: 'none' }, servers: [
    { serverKey: 'main', serverName: 'local-tools', transport: 'stdio', command: 'node', args: ['server.js'] },
    { serverKey: 'extra', serverName: 'local-extra', transport: 'stdio', command: 'node', args: ['extra.js'] },
  ] },
  { id: 'vendor-key', name: 'Vendor', auth: { mode: 'api-key' }, servers: [{ serverKey: 'main', serverName: 'vendor', transport: 'streamable-http', url: 'https://example.invalid/mcp' }] },
];

test('defaultConnections 归一化：字符串、对象、去重与空值', () => {
  assert.deepEqual(normalizeDefaultConnections(['a', { connectorId: 'b', serverKey: 'x' }, 'a', { connectorId: ' b ', serverKey: 'x' }]), [
    { connectorId: 'a' },
    { connectorId: 'b', serverKey: 'x' },
  ]);
  assert.deepEqual(normalizeDefaultConnections(undefined), []);
  assert.throws(() => normalizeDefaultConnections([{ serverKey: 'x' }]), /connectorId/);
  assert.deepEqual(normalizeDefaultConnections([{ connectorId: 'c', credentialService: ' platformKey ' }, { connectorId: 'd', credentialService: '' }]), [
    { connectorId: 'c', credentialService: 'platformKey' },
    { connectorId: 'd' },
  ]);
  assert.deepEqual(Config({}).defaultConnections, []);
});

test('规划：只连 auth=none 且未连接、未预置过的卡片', () => {
  const plan = planDefaultConnections({
    defaults: normalizeDefaultConnections(['local-tools', { connectorId: 'local-tools', serverKey: 'extra' }, 'vendor-key', 'missing', { connectorId: 'local-tools', serverKey: 'nope' }]),
    catalog,
    connectionKeys: [],
    seededKeys: ['local-tools-extra'],
  });
  assert.deepEqual(plan.connect, [{ connectorId: 'local-tools', key: 'local-tools-main' }]);
  assert.deepEqual(plan.skipped.map((item) => item.reason), ['already-seeded', 'requires-credentials', 'missing-connector', 'missing-server']);
  assert.equal(defaultConnectionKey(catalog[0], undefined), 'local-tools-main');
  assert.deepEqual(planDefaultConnections({ defaults: [{ connectorId: 'local-tools' }], catalog, connectionKeys: ['local-tools-main'], seededKeys: [] }).connect, []);
});

test('规划：凭据型卡片经 credentialService 预置，凭据变化时原地刷新', () => {
  const defaults = normalizeDefaultConnections([{ connectorId: 'vendor-key', credentialService: 'platformKey' }]);
  const credential = { apiKeyValue: 'k1' };
  // 服务还没给出凭据：等，不告警为"需要凭据"。
  let plan = planDefaultConnections({ defaults, catalog, connectionKeys: [], seededKeys: [] });
  assert.deepEqual(plan.skipped.map((item) => item.reason), ['credential-unavailable']);
  plan = planDefaultConnections({ defaults, catalog, connectionKeys: [], seededKeys: [], credentials: new Map([['vendor-key', undefined]]) });
  assert.deepEqual(plan.skipped.map((item) => item.reason), ['credential-unavailable']);
  // 给出凭据：连，凭据随行。
  plan = planDefaultConnections({ defaults, catalog, connectionKeys: [], seededKeys: [], credentials: new Map([['vendor-key', credential]]) });
  assert.deepEqual(plan.connect, [{ connectorId: 'vendor-key', credentialService: 'platformKey', key: 'vendor-key-main', credential }]);
  assert.deepEqual(plan.refresh, []);
  // 已连接且凭据相同：不动；不同：刷新；看不到现值：不动。
  const connected = { defaults, catalog, connectionKeys: ['vendor-key-main'], seededKeys: ['vendor-key-main'], credentials: new Map([['vendor-key', credential]]) };
  assert.deepEqual(planDefaultConnections({ ...connected, connectionCredentials: new Map([['vendor-key-main', 'k1']]) }).skipped.map((item) => item.reason), ['already-connected']);
  plan = planDefaultConnections({ ...connected, connectionCredentials: new Map([['vendor-key-main', 'old']]) });
  assert.deepEqual(plan.refresh, [{ connectorId: 'vendor-key', key: 'vendor-key-main', credential }]);
  assert.deepEqual(plan.connect, []);
  assert.deepEqual(planDefaultConnections(connected).skipped.map((item) => item.reason), ['already-connected']);
  // 用户断开过：不塞回，哪怕凭据在手。
  assert.deepEqual(planDefaultConnections({ defaults, catalog, connectionKeys: [], seededKeys: ['vendor-key-main'], credentials: new Map([['vendor-key', credential]]) }).skipped.map((item) => item.reason), ['already-seeded']);
  assert.equal(primaryCredentialValue({ bearerToken: 'b' }), 'b');
  assert.equal(primaryCredentialValue({ credentialValues: { token: 't' } }), 't');
  assert.equal(primaryCredentialValue({ bearerToken: '' }), undefined);
  assert.equal(primaryCredentialValue(undefined), undefined);
});

/* ───────────── 启动集成：用 plugin-flow 同款的假 Host ───────────── */

function makeTable() {
  const map = new Map();
  return { async get(key) { return map.get(key); }, async put(key, value) { map.set(key, value); }, async delete(key) { return map.delete(key); }, entries() { return [...map.entries()][Symbol.iterator](); } };
}
function makeLoader() {
  const entries = new Map();
  return {
    entries,
    async create({ id, name, config, disabled }) { entries.set(id, { id, name, options: { config }, disabled }); },
    async update(id, patch) { const e = entries.get(id); if (!e) throw new Error(`entry ${id} not found`); if ('config' in patch) e.options.config = patch.config; if ('disabled' in patch) e.disabled = patch.disabled; },
    async remove(id) { entries.delete(id); },
    resolve(id) { const e = entries.get(id); if (!e) throw new Error(`entry ${id} not found`); return e; },
  };
}
function makeHost(tables) {
  const logs = [];
  const loader = makeLoader();
  const defs = new Map();
  const tools = { register(def) { defs.set(def.name, def); return () => defs.delete(def.name); }, schemas() { return []; }, guard() { return () => {}; } };
  const disposers = [];
  const ctx = {
    loader, tools,
    storageDomain: { open: async () => ({ tables, close: async () => {} }) },
    workspaceRegistry: { list: () => [], get: () => undefined },
    logger: () => ({ info: (m) => logs.push(`[info] ${m}`), warn: (m) => logs.push(`[warn] ${m}`), error: (m) => logs.push(`[error] ${m}`) }),
    effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d); },
  };
  return { ctx, loader, defs, logs, dispose: () => { for (const d of disposers.splice(0)) d(); } };
}
const tableNames = ['connections', 'grants', 'catalog', 'snapshots', 'governance', 'connection_scopes', 'tool_catalog'];
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
const config = (overrides = {}) => Config({ catalogUrl: '', connectors: catalog, persistSecrets: true, openBrowser: false, requestTimeoutMs: 1000, defaultConnections: ['local-tools'], ...overrides });

test('includeBundledCatalog=false 时市场只有部署方的卡片', async () => {
  const tables = new Map(tableNames.map((name) => [name, makeTable()]));
  const host = makeHost(tables);
  await apply(host.ctx, config({ defaultConnections: [], includeBundledCatalog: false }));
  const listed = await host.defs.get('mcp_connector_catalog').execute({});
  const ids = (listed.detail?.items ?? listed.detail?.connectors ?? []).map((item) => item.id).sort();
  assert.deepEqual(ids, ['local-tools', 'vendor-key'], JSON.stringify(listed).slice(0, 400));
  assert.equal(Config({}).includeBundledCatalog, true);
  host.dispose();
});

test('首次启动自动连接预置卡片，并记入台账', async () => {
  const tables = new Map(tableNames.map((name) => [name, makeTable()]));
  const host = makeHost(tables);
  await apply(host.ctx, config());
  await settle();
  const entry = host.loader.entries.get('mcp-local-tools-main');
  assert.ok(entry, host.logs.join('\n'));
  assert.equal(entry.name, '@deepseek-ai/dsh-mcp-client');
  assert.equal(entry.options.config.serverName, 'local-tools');
  assert.deepEqual((await tables.get('catalog').get('defaults')).connectors, ['local-tools-main']);
  assert.ok(await tables.get('connections').get('local-tools-main'));
  host.dispose();
});

test('用户断开预置连接后，下次启动不再塞回', async () => {
  const tables = new Map(tableNames.map((name) => [name, makeTable()]));
  let host = makeHost(tables);
  await apply(host.ctx, config());
  await settle();
  const disconnected = await host.defs.get('mcp_connector_disconnect').execute({ key: 'local-tools-main' }, { signal: new AbortController().signal });
  assert.equal(disconnected.ok, true);
  host.dispose();

  host = makeHost(tables);
  await apply(host.ctx, config());
  await settle();
  assert.equal(host.loader.entries.has('mcp-local-tools-main'), false);
  assert.equal(await tables.get('connections').get('local-tools-main'), undefined);
  host.dispose();
});

test('已由用户手动连接的卡片不重复连接，凭据型卡片只告警', async () => {
  const tables = new Map(tableNames.map((name) => [name, makeTable()]));
  let host = makeHost(tables);
  await apply(host.ctx, config({ defaultConnections: [] }));
  const connected = await host.defs.get('mcp_connector_connect').execute({ connectorId: 'local-tools' }, { signal: new AbortController().signal });
  assert.equal(connected.ok, true, connected.message);
  host.dispose();

  host = makeHost(tables);
  await apply(host.ctx, config({ defaultConnections: ['local-tools', 'vendor-key'] }));
  await settle();
  assert.equal(host.loader.entries.size, 1);
  assert.ok(host.logs.some((line) => line.includes('"vendor-key" skipped: requires-credentials')), host.logs.join('\n'));
  // 手动连接的也进台账：之后断开同样不会被塞回。
  assert.deepEqual((await tables.get('catalog').get('defaults')).connectors, ['local-tools-main']);
  host.dispose();
});

/* ───────────── 凭据型预置：宿主上的凭据服务 ───────────── */

async function startBearerMcpServer(accepted) {
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) {}
    if (req.headers.authorization !== `Bearer ${accepted.value}`) { res.writeHead(401); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'platform', version: '1' } } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}/mcp`, close: () => new Promise((resolve) => server.close(resolve)) };
}
const platformCard = (url) => ({
  id: 'platform-tool', name: '平台工具', auth: { mode: 'bearer', credentialName: '平台令牌' },
  servers: [{ serverKey: 'main', serverName: 'platform-tool', transport: 'streamable-http', url }],
});
const withService = (host, service) => { host.ctx.platformKey = service; return host; };

test('凭据型预置：宿主凭据服务给出令牌时自动连接，并记入台账', async () => {
  const accepted = { value: 'ak-1' };
  const mcp = await startBearerMcpServer(accepted);
  const tables = new Map(tableNames.map((name) => [name, makeTable()]));
  const asked = [];
  const host = withService(makeHost(tables), { async credential(request) { asked.push(request.connectorId); return { bearerToken: 'ak-1' }; } });
  try {
    await apply(host.ctx, config({ connectors: [...catalog, platformCard(mcp.url)], defaultConnections: [{ connectorId: 'platform-tool', credentialService: 'platformKey' }] }));
    await settle();
    const entry = host.loader.entries.get('mcp-platform-tool-main');
    assert.ok(entry, host.logs.join('\n'));
    assert.equal(entry.options.config.headers.Authorization, 'Bearer ak-1');
    assert.deepEqual(asked, ['platform-tool']);
    assert.deepEqual((await tables.get('catalog').get('defaults')).connectors, ['platform-tool-main']);
    assert.ok(host.logs.some((line) => line.includes('"platform-tool-main" connected')), host.logs.join('\n'));
  } finally {
    host.dispose();
    await mcp.close();
  }
});

test('凭据型预置：服务暂时给不出凭据则等待，服务通知后再连', async () => {
  const accepted = { value: 'ak-1' };
  const mcp = await startBearerMcpServer(accepted);
  const tables = new Map(tableNames.map((name) => [name, makeTable()]));
  let token;
  const listeners = new Set();
  const service = {
    async credential() { return token === undefined ? undefined : { bearerToken: token }; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
  const host = withService(makeHost(tables), service);
  // 这个假 Host 有 inject：服务已在 ctx 上，回调立即执行。
  host.ctx.inject = (names, callback) => { if (names.every((name) => host.ctx[name] !== undefined)) callback(host.ctx); };
  try {
    await apply(host.ctx, config({ connectors: [...catalog, platformCard(mcp.url)], defaultConnections: [{ connectorId: 'platform-tool', credentialService: 'platformKey' }] }));
    await settle();
    assert.equal(host.loader.entries.has('mcp-platform-tool-main'), false);
    assert.ok(host.logs.some((line) => line.includes('[info] default connection "platform-tool" waiting for its credential')), host.logs.join('\n'));
    assert.equal(host.logs.some((line) => line.includes('[warn]') && line.includes('platform-tool')), false, host.logs.join('\n'));
    assert.equal(listeners.size, 1, '必须订阅服务的变化');
    token = 'ak-1';
    for (const listener of listeners) listener();
    await settle();
    assert.equal(host.loader.entries.get('mcp-platform-tool-main')?.options.config.headers.Authorization, 'Bearer ak-1', host.logs.join('\n'));
    host.dispose();
    assert.equal(listeners.size, 0, '卸载时退订');
  } finally {
    await mcp.close();
  }
});

test('凭据型预置：令牌轮换后下次启动原地刷新，用户断开过的不塞回', async () => {
  const accepted = { value: 'ak-1' };
  const mcp = await startBearerMcpServer(accepted);
  const tables = new Map(tableNames.map((name) => [name, makeTable()]));
  const service = { token: 'ak-1', async credential() { return { bearerToken: this.token }; } };
  const cfg = () => config({ connectors: [...catalog, platformCard(mcp.url)], defaultConnections: [{ connectorId: 'platform-tool', credentialService: 'platformKey' }] });
  let host = withService(makeHost(tables), service);
  try {
    await apply(host.ctx, cfg());
    await settle();
    assert.equal(host.loader.entries.get('mcp-platform-tool-main').options.config.headers.Authorization, 'Bearer ak-1');
    host.dispose();

    // The platform re-issued the key: the stored connection is refreshed in place.
    accepted.value = 'ak-2';
    service.token = 'ak-2';
    host = withService(makeHost(tables), service);
    await apply(host.ctx, cfg());
    await settle();
    assert.equal(host.loader.entries.get('mcp-platform-tool-main').options.config.headers.Authorization, 'Bearer ak-2', host.logs.join('\n'));
    assert.ok(host.logs.some((line) => line.includes('"platform-tool-main" credential refreshed')), host.logs.join('\n'));
    assert.equal((await tables.get('connections').get('platform-tool-main')).auth.bearerToken, 'ak-2');

    // The user disconnected it: not re-seeded even though the service still has a key.
    const disconnected = await host.defs.get('mcp_connector_disconnect').execute({ key: 'platform-tool-main' }, { signal: new AbortController().signal });
    assert.equal(disconnected.ok, true, disconnected.message);
    host.dispose();
    host = withService(makeHost(tables), service);
    await apply(host.ctx, cfg());
    await settle();
    assert.equal(host.loader.entries.has('mcp-platform-tool-main'), false);
  } finally {
    host.dispose();
    await mcp.close();
  }
});
