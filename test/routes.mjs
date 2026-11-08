/**
 * 路由层自测：用假的 req/res 直接调 handler，验证 HTTP 协议层（不含 DSH 鉴权）。
 *   node test/routes.mjs
 */
import { rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';

import { registerRoutes, ROUTE_PREFIX } from '../lib/routes.js';
import { createStore } from '../lib/core/store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = path.join(here, '.tmp', 'routes-store');

let failed = 0;
function check(name, condition, detail) {
  if (condition) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.log(`  ✗ ${name}${detail === undefined ? '' : ` → ${JSON.stringify(detail)}`}`);
  }
}

/** 极简响应对象，收集状态码与 body。 */
function makeRes() {
  const res = {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) { res.status = status; Object.assign(res.headers, headers || {}); },
    end(chunk) { if (chunk !== undefined) res.body += String(chunk); res.done = true; return res; },
  };
  return res;
}

/** 极简请求对象：支持 async 迭代（readBody 用 for await）。 */
function makeReq(method, urlPath, { headers = {}, body = null } = {}) {
  const stream = Readable.from(body ? [body] : []);
  return Object.assign(stream, {
    method,
    url: urlPath,
    headers: { ...headers },
    socket: { remoteAddress: '127.0.0.1' },
  });
}

let handler = null;
const ctx = {
  get: () => undefined, // 没有 connection 服务 → 走 loopback 兜底
  webServer: {
    register(route) {
      check('路由注册为 prefix', route.kind === 'prefix' && route.path === ROUTE_PREFIX, [route.kind, route.path]);
      handler = route.handler;
      return () => {};
    },
  },
};
const logger = { info() {}, warn() {}, error() {} };

await rm(tmp, { recursive: true, force: true });
await mkdir(tmp, { recursive: true });
const store = createStore(tmp);
registerRoutes(ctx, { store, logger });
check('handler 已注册', typeof handler === 'function');

async function call(method, sub, opts) {
  const res = makeRes();
  await handler(makeReq(method, `${ROUTE_PREFIX}${sub}`, opts), res);
  let json = null;
  try { json = JSON.parse(res.body); } catch { /* 非 JSON */ }
  return { status: res.status, json, body: res.body, headers: res.headers };
}

const amountCsv = [
  'user_id,start_time_iso,end_time_iso,model,api_key_name,api_key,type,price,amount',
  'u-1,2026-08-01T00:00:00+08:00,2026-08-02T00:00:00+08:00,deepseek-v4-flash,Key A,sk-a,input_cache_hit_tokens,0.00000005,1000',
  'u-1,2026-08-01T00:00:00+08:00,2026-08-02T00:00:00+08:00,deepseek-v4-flash,Key A,sk-a,input_cache_miss_tokens,0.0000005,500',
  'u-1,2026-08-01T00:00:00+08:00,2026-08-02T00:00:00+08:00,deepseek-v4-flash,Key A,sk-a,output_tokens,0.000002,300',
  'u-1,2026-08-01T00:00:00+08:00,2026-08-02T00:00:00+08:00,deepseek-v4-flash,Key A,sk-a,request_count,,2',
].join('\n');
const costCsv = [
  'user_id,start_time_iso,end_time_iso,model,wallet_type,cost,currency',
  'u-1,2026-08-01T00:00:00+08:00,2026-08-02T00:00:00+08:00,deepseek-v4-flash,paid,0.0032,CNY',
].join('\n');

console.log('\n[路由] 健康检查');
{
  const res = await call('GET', '/');
  check('GET / 200', res.status === 200, res.status);
  check('返回插件名', res.json && res.json.plugin === 'dsh-token-usage', res.json);
}

console.log('\n[路由] 空状态');
{
  const res = await call('GET', '/state');
  check('GET /state 200', res.status === 200, res.status);
  check('datasets 为空', Array.isArray(res.json.datasets) && res.json.datasets.length === 0, res.json);
  const noData = await call('GET', '/analysis?datasetId=x');
  check('无数据集时 analysis 400', noData.status === 400, noData.status);
  check('错误信息可读', /找不到数据集|还没有任何数据集/.test(noData.json.error), noData.json.error);
}

console.log('\n[路由] 导入 amount');
let datasetId = '';
{
  const res = await call('POST', '/import', {
    headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent('amount-2026-08.csv') },
    body: Buffer.from(amountCsv, 'utf8'),
  });
  check('POST /import 200', res.status === 200, [res.status, res.json]);
  datasetId = res.json && res.json.datasetId;
  check('返回 datasetId', !!datasetId, datasetId);
  check('created = true', res.json.created === true);
  check('解析出 1 行记录', res.json.parsed.records === 1, res.json.parsed);
  check('文件名已净化', (res.json.files || []).some((f) => f.name === 'amount-2026-08.csv'), res.json.files);
}

console.log('\n[路由] 同一数据集追加 cost');
{
  const res = await call('POST', '/import', {
    headers: {
      'content-type': 'application/octet-stream',
      'x-file-name': encodeURIComponent('cost-2026-08.csv'),
      'x-dataset-id': encodeURIComponent(datasetId),
    },
    body: Buffer.from(costCsv, 'utf8'),
  });
  check('追加成功', res.status === 200, [res.status, res.json]);
  check('复用同一数据集', res.json.datasetId === datasetId);
  check('created = false', res.json.created === false);
  check('共 2 个文件', res.json.files.length === 2, res.json.files.map((f) => f.name));
  check('无缺少账单告警', !(res.json.warnings || []).some((w) => w.includes('缺少')), res.json.warnings);
}

console.log('\n[路由] 状态与分析');
{
  const state = await call('GET', '/state');
  check('list 1 条', state.json.datasets.length === 1, state.json.datasets.length);
  check('rowCount = 1', state.json.datasets[0].rowCount === 1, state.json.datasets[0].rowCount);

  const res = await call('GET', `/analysis?datasetId=${encodeURIComponent(datasetId)}&bucket=day`);
  check('GET /analysis 200', res.status === 200, [res.status, res.json]);
  check('totals.tokens = 1800', res.json.totals.tokens === 1800, res.json.totals.tokens);
  check('费用取账单 0.0032', Math.abs(res.json.totals.cost - 0.0032) < 1e-9, res.json.totals.cost);
  check('series 1 桶', res.json.series.length === 1, res.json.series.length);
  check('dataset 元信息附带', res.json.dataset && res.json.dataset.id === datasetId);
  check('groups 附带', res.json.groups && typeof res.json.groups.keys === 'object');

  const bad = await call('GET', '/analysis?datasetId=不存在');
  check('未知数据集 400', bad.status === 400, bad.status);
}

console.log('\n[路由] 分组 / 重命名 / 导出');
{
  const groups = await call('POST', '/groups', {
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ groups: { keys: { 'Key A': '项目甲' }, models: {} } })),
  });
  check('保存分组 200', groups.status === 200, [groups.status, groups.json]);
  check('分组已存', groups.json.groups.keys['Key A'] === '项目甲', groups.json.groups);

  const analysis = await call('GET', `/analysis?datasetId=${encodeURIComponent(datasetId)}`);
  check('分析按分组聚合', analysis.json.byGroup[0].name === '项目甲', analysis.json.byGroup);

  const renamed = await call('POST', '/rename', {
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ datasetId, name: '十月账单' })),
  });
  check('重命名 200', renamed.status === 200, [renamed.status, renamed.json]);
  check('新名称生效', renamed.json.dataset.name === '十月账单', renamed.json.dataset);

  const exported = await call('GET', `/export?datasetId=${encodeURIComponent(datasetId)}`);
  check('导出 200', exported.status === 200, exported.status);
  check('导出带 attachment 头', /attachment/.test(exported.headers['content-disposition'] || ''), exported.headers);
  check('导出内容含 rows.version', exported.json && exported.json.rows.version === 1, exported.json && exported.json.rows.version);
}

console.log('\n[路由] 按路径导入 / 404 / 删除');
{
  const { writeFile } = await import('node:fs/promises');
  const filePath = path.join(tmp, 'generic.csv');
  await writeFile(filePath, 'date,model,output_tokens,cost\n2026-09-01,v4-flash,100,0.01\n', 'utf8');
  const res = await call('POST', '/import-path', {
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ path: filePath, name: '按路径导入' })),
  });
  check('import-path 200', res.status === 200, [res.status, res.json]);
  check('新数据集', res.json.created === true && res.json.datasetId !== datasetId);
  check('解析 1 行', res.json.parsed.records === 1, res.json.parsed);

  const missing = await call('POST', '/import-path', {
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ path: path.join(tmp, 'nope.csv') })),
  });
  check('文件不存在时报错', missing.status === 400 && /文件不存在/.test(missing.json.error), [missing.status, missing.json]);

  const unknown = await call('GET', '/nope');
  check('未知接口 404', unknown.status === 404, unknown.status);

  const list = await call('GET', '/state');
  check('两个数据集', list.json.datasets.length === 2, list.json.datasets.length);

  const del = await call('POST', '/delete', {
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ datasetId })),
  });
  check('删除 200', del.status === 200, [del.status, del.json]);
  const after = await call('GET', '/state');
  check('删除后剩 1 条', after.json.datasets.length === 1, after.json.datasets.length);

  const delAgain = await call('POST', '/delete', {
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ datasetId })),
  });
  check('重复删除报错', delAgain.status === 400, delAgain.status);
}

console.log(`\n${failed === 0 ? '全部通过 ✅' : `${failed} 项失败 ❌`}`);
process.exit(failed === 0 ? 0 : 1);
