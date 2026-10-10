import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDefaultConnections, planDefaultConnections, defaultConnectionKey } from '../lib/default-connections.js';
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
