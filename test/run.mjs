/**
 * 自测脚本（纯 Node，无测试框架）：
 *   node test/run.mjs
 *
 * 覆盖：官方 amount/cost CSV 解析 → 归一化 → 费用分摊 → 趋势/聚合/异常检测
 *       通用 CSV / 通用 JSON → 适配器兜底
 *       ZIP 解包（若 test/.tmp/export.zip 存在）
 *       数据集仓库（store）读写
 */
import { mkdir, writeFile, rm, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ingestFiles } from '../lib/core/ingest.js';
import { analyze } from '../lib/core/analyze.js';
import { expandFiles, resolveAdapter } from '../lib/core/adapters/index.js';
import { readZip, looksLikeZip } from '../lib/core/zip.js';
import { parseCsv } from '../lib/core/csv.js';
import { createStore } from '../lib/core/store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = path.join(here, '.tmp');
const fixtures = path.join(tmp, 'fixtures');

let failed = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}${detail === undefined ? '' : ` → ${JSON.stringify(detail)}`}`);
  }
}
const near = (a, b, eps = 1e-6) => Math.abs(Number(a) - Number(b)) <= eps;
const buf = (text) => Buffer.from(text, 'utf8');

// ─────────────────────────── 生成官方导出 fixture ───────────────────────────
const KEYS = [
  { name: 'Key A', secret: 'sk-aaaa' },
  { name: 'Key B', secret: 'sk-bbbb' },
];
// 单价（每 token，CNY）：命中 / 未命中 / 输出
const PRICES = {
  'deepseek-v4-flash': { hit: 5e-8, miss: 5e-7, output: 2e-6 },
  'deepseek-v4-pro': { hit: 2e-7, miss: 2e-6, output: 6e-6 },
};

const amountRows = [
  ['user_id', 'start_time_iso', 'end_time_iso', 'model', 'api_key_name', 'api_key', 'type', 'price', 'amount'].join(','),
];
const billedMap = new Map(); // `${date}|${model}` → cost
const expected = { hit: 0, miss: 0, output: 0, requests: 0, byKey: new Map(), hintCost: 0 };

function pushRow(date, model, key, type, price, amount) {
  const end = `${date.slice(0, 8)}${String(Number(date.slice(8)) + 1).padStart(2, '0')}`;
  amountRows.push(
    ['u-1', `${date}T00:00:00+08:00`, `${end}T00:00:00+08:00`, model, key.name, key.secret, type, price, amount].join(','),
  );
  if (type === 'input_cache_hit_tokens') expected.hit += amount;
  if (type === 'input_cache_miss_tokens') expected.miss += amount;
  if (type === 'output_tokens') expected.output += amount;
  if (type === 'request_count') expected.requests += amount;
  if (type !== 'request_count') expected.hintCost += price * amount;
  const bucket = expected.byKey.get(key.name) || { tokens: 0 };
  if (type !== 'request_count') bucket.tokens += amount;
  expected.byKey.set(key.name, bucket);
}

for (let day = 1; day <= 10; day += 1) {
  const date = `2026-08-${String(day).padStart(2, '0')}`;
  const spike = day === 7 ? 4 : 1; // 8/7 人为突增
  for (const model of ['deepseek-v4-flash', 'deepseek-v4-pro']) {
    const p = PRICES[model];
    KEYS.forEach((key, index) => {
      const scale = index === 0 ? 1 : 0.4;
      const modelScale = model === 'deepseek-v4-pro' ? 0.6 : 1;
      const hit = Math.round(20000 * scale * modelScale * spike);
      const miss = Math.round(8000 * scale * spike);
      const output = Math.round(1500 * scale * spike);
      const requests = Math.round(12 * scale * spike);
      pushRow(date, model, key, 'input_cache_hit_tokens', p.hit, hit);
      pushRow(date, model, key, 'input_cache_miss_tokens', p.miss, miss);
      pushRow(date, model, key, 'output_tokens', p.output, output);
      pushRow(date, model, key, 'request_count', '', requests);
      const cost = hit * p.hit + miss * p.miss + output * p.output;
      const k = `${date}|${model}`;
      billedMap.set(k, (billedMap.get(k) || 0) + cost);
    });
  }
}

const costRows = [['user_id', 'start_time_iso', 'end_time_iso', 'model', 'wallet_type', 'cost', 'currency'].join(',')];
let expectedBilled = 0;
for (const [k, rawCost] of billedMap) {
  const [date, model] = k.split('|');
  const end = `${date.slice(0, 8)}${String(Number(date.slice(8)) + 1).padStart(2, '0')}`;
  const cost = Math.round(rawCost * 1e6) / 1e6;
  expectedBilled += cost;
  costRows.push(['u-1', `${date}T00:00:00+08:00`, `${end}T00:00:00+08:00`, model, 'paid', cost, 'CNY'].join(','));
}

// 通用 CSV：表头走别名表（date/model/api_key_name/input_tokens/output_tokens/cost）
const genericCsv = [
  'date,model,api_key_name,input_tokens,output_tokens,cost',
  '2026-08-01,v4-flash,Key A,1000,200,0.5',
  '2026-08-02,v4-flash,Key A,3000,600,1.5',
  '2026-08-02,v4-pro,Key B,500,100,0.9',
].join('\n');
const GENERIC_TOKENS = 1000 + 200 + 3000 + 600 + 500 + 100; // 5400

// 通用 JSON：数组包在 data 里，混合两种 Key 字段名
const genericJson = JSON.stringify(
  {
    data: [
      { date: '2026-08-01', model: 'v4-flash', key: 'Key A', cache_hit_tokens: 800, uncached_input_tokens: 200, output_tokens: 300, cost: 0.4 },
      { date: '2026-08-03', model: 'v4-pro', api_key_name: 'Key B', input_tokens: 5000, output_tokens: 900, cost: 2.2 },
    ],
  },
  null,
  2,
);
const JSON_TOKENS = 800 + 200 + 300 + 5000 + 900; // 7200

const amountText = amountRows.join('\n');
const costText = costRows.join('\n');

await rm(tmp, { recursive: true, force: true });
await mkdir(fixtures, { recursive: true });
await writeFile(path.join(fixtures, 'amount-2026-08.csv'), amountText, 'utf8');
await writeFile(path.join(fixtures, 'cost-2026-08.csv'), costText, 'utf8');
await writeFile(path.join(fixtures, 'generic.csv'), genericCsv, 'utf8');
await writeFile(path.join(fixtures, 'generic.json'), genericJson, 'utf8');

// ─────────────────────────── 1. CSV 解析器 ───────────────────────────
console.log('\n[1] CSV 解析');
{
  const parsed = parseCsv('a,b,c\n1,"x,y",3\n4,"he said ""hi""",6\n');
  check('表头解析', parsed.headers.join('|') === 'a|b|c', parsed.headers);
  check('行数', parsed.rows.length === 2, parsed.rows.length);
  check('引号内逗号', parsed.rows[0][1] === 'x,y', parsed.rows[0][1]);
  check('双引号转义', parsed.rows[1][1] === 'he said "hi"', parsed.rows[1][1]);
  const crlf = parseCsv('a,b\r\n1,2\r\n');
  check('CRLF 处理', crlf.rows.length === 1 && crlf.rows[0][1] === '2', crlf.rows);
}

// ─────────────────────────── 2. 适配器识别 ───────────────────────────
console.log('\n[2] 适配器识别');
{
  check('amount → deepseek-amount', resolveAdapter({ name: 'amount-2026-08.csv', text: amountText }).id === 'deepseek-amount');
  check('cost → deepseek-cost', resolveAdapter({ name: 'cost-2026-08.csv', text: costText }).id === 'deepseek-cost');
  check('通用 CSV → generic-csv', resolveAdapter({ name: 'generic.csv', text: genericCsv }).id === 'generic-csv');
  check('通用 JSON → generic-json', resolveAdapter({ name: 'generic.json', text: genericJson }).id === 'generic-json');
  check('无扩展名但像 JSON 也识别', resolveAdapter({ name: 'dump.txt', text: '[{"date":"2026-08-01","output_tokens":1}]' }).id === 'generic-json');
}

// ─────────────────────────── 3. 官方数据 ingest ───────────────────────────
console.log('\n[3] 官方导出 ingest');
const data = ingestFiles([
  { name: 'amount-2026-08.csv', buffer: buf(amountText) },
  { name: 'cost-2026-08.csv', buffer: buf(costText) },
]);
{
  const totals = data.stats.totals;
  check('记录条数 = 40（10 天 × 2 模型 × 2 Key）', data.records.length === 40, data.records.length);
  check('currency = CNY', data.currency === 'CNY', data.currency);
  check('hit 合计正确', totals.hit === expected.hit, [totals.hit, expected.hit]);
  check('miss 合计正确', totals.miss === expected.miss, [totals.miss, expected.miss]);
  check('output 合计正确', totals.output === expected.output, [totals.output, expected.output]);
  check('requests 合计正确', totals.requests === expected.requests, [totals.requests, expected.requests]);
  check('billed 行数 = 20（10 天 × 2 模型）', data.billed.length === 20, data.billed.length);
  check('models 两个', data.stats.models.length === 2, data.stats.models);
  check('keys 两个', data.stats.keys.length === 2, data.stats.keys);
  check('date 范围', data.stats.from === '2026-08-01' && data.stats.to === '2026-08-10', [data.stats.from, data.stats.to]);
  check('无“缺少 cost”告警', !(data.warnings || []).some((w) => w.includes('缺少')), data.warnings);
  check('price 列被记录（用于缓存节省）', data.records[0].priceHit > 0, data.records[0].priceHit);
}

// ─────────────────────────── 4. 分析 ───────────────────────────
console.log('\n[4] 分析');
const result = analyze(data, { bucket: 'day', top: 10 });
{
  const t = result.totals;
  check('range.from = 2026-08-01', result.range.from === '2026-08-01', result.range.from);
  check('range.to = 2026-08-10', result.range.to === '2026-08-10', result.range.to);
  check('range.days = 10', result.range.days === 10, result.range.days);
  check('series 补齐 10 个桶', result.series.length === 10, result.series.length);
  check('series token 合计 = totals.tokens', result.series.reduce((a, s) => a + s.tokens, 0) === t.tokens);
  check('series 费用合计 ≈ 总费用', near(result.series.reduce((a, s) => a + s.cost, 0), t.cost, 0.01));
  check('总费用 ≈ 账单合计', near(t.cost, expectedBilled, 0.02), [t.cost, expectedBilled]);
  check('费用全部来自账单（无估算）', result.quality.estimatedCostShare === 0, result.quality.estimatedCostShare);
  check('hasBilledCost', result.quality.hasBilledCost === true);
  check('缓存命中率区间合法', t.cacheHitRate > 0 && t.cacheHitRate < 1, t.cacheHitRate);
  check('缓存节省 > 0', t.cacheSavings > 0, t.cacheSavings);
  check('缓存节省来自 price 列（非估算）', t.savingsEstimated === false, t.savingsEstimated);
  check('byModel 两项', result.byModel.length === 2, result.byModel.length);
  check('byKey 两项', result.byKey.length === 2, result.byKey.map((r) => r.name));
  check('byKey token 正确', expected.byKey.get('Key A').tokens === result.byKey.find((r) => r.name === 'Key A').tokens);
  check('byKey 费用合计 ≈ 总费用', near(result.byKey.reduce((a, r) => a + r.cost, 0), t.cost, 0.05), result.byKey.map((r) => r.cost));
  check('byKey share 合计 ≈ 1', near(result.byKey.reduce((a, r) => a + r.share, 0), 1, 1e-3));
  check('composition 三项', result.composition.length === 3, result.composition.map((c) => c.key));
  check('composition 合计 = tokens', result.composition.reduce((a, c) => a + c.tokens, 0) === t.tokens);
  check('检测到 8/7 突增', result.anomalies.some((a) => a.day === '2026-08-07' && a.metric === 'tokens'), result.anomalies);
  check('有中文结论', result.insights.length > 0, result.insights);
}

console.log('\n[4b] 周/月聚合 + 区间过滤 + 分组');
{
  const weekly = analyze(data, { bucket: 'week' });
  check('周桶数量 < 日桶', weekly.series.length < result.series.length, weekly.series.length);
  check('周聚合 token 不变', weekly.totals.tokens === result.totals.tokens);
  const monthly = analyze(data, { bucket: 'month' });
  check('月桶 = 1', monthly.series.length === 1, monthly.series.length);
  const sliced = analyze(data, { from: '2026-08-05', to: '2026-08-07' });
  check('区间过滤生效', sliced.range.from === '2026-08-05' && sliced.range.to === '2026-08-07', sliced.range);
  check('区间过滤后 token 更少', sliced.totals.tokens < result.totals.tokens);
  check('区间过滤后 series 3 桶', sliced.series.length === 3, sliced.series.length);
  const grouped = analyze(data, { top: 10, groups: { keys: { 'Key A': '项目甲', 'Key B': '项目乙' } } });
  check('自定义分组 2 项', grouped.byGroup.length === 2, grouped.byGroup.map((g) => g.name));
}

// ─────────────────────────── 5. 通用格式 ───────────────────────────
console.log('\n[5] 通用 CSV / JSON');
{
  const generic = ingestFiles([{ name: 'generic.csv', buffer: buf(genericCsv) }]);
  check('通用 CSV 解析 3 行', generic.records.length === 3, generic.records.length);
  check('Key 列被识别', generic.records[0].key === 'Key A', generic.records[0].key);
  const g = analyze(generic, { bucket: 'day' });
  check(`通用 CSV 总 token = ${GENERIC_TOKENS}`, g.totals.tokens === GENERIC_TOKENS, g.totals.tokens);
  check('通用 CSV 费用来自 cost 列', near(g.totals.cost, 2.9, 1e-9), g.totals.cost);
  check('通用 CSV 无账单时费用来源 = reported', g.quality.estimatedCostShare === 0, g.quality.estimatedCostShare);

  const json = ingestFiles([{ name: 'generic.json', buffer: buf(genericJson) }]);
  check('通用 JSON 解析 2 行', json.records.length === 2, json.records.length);
  check('JSON 别名 api_key_name 生效', json.stats.keys.includes('Key B'), json.stats.keys);
  const j = analyze(json, { bucket: 'day' });
  check(`JSON 总 token = ${JSON_TOKENS}`, j.totals.tokens === JSON_TOKENS, j.totals.tokens);
}

console.log('\n[5b] 缺 cost 账单时的兜底');
{
  const onlyAmount = ingestFiles([{ name: 'amount-2026-08.csv', buffer: buf(amountText) }]);
  check('提示缺少 cost 账单', (onlyAmount.warnings || []).some((w) => w.includes('缺少 cost')), onlyAmount.warnings);
  const a = analyze(onlyAmount, { bucket: 'day' });
  check('费用回退到 price 列', near(a.totals.cost, expected.hintCost, 0.05), [a.totals.cost, expected.hintCost]);
  check('费用来源全部为 price', a.quality.estimatedCostShare === 0, a.quality.estimatedCostShare);
}

// ─────────────────────────── 6. ZIP ───────────────────────────
console.log('\n[6] ZIP 读取');
// 放在 test/ 下而不是 test/.tmp/：本脚本每轮都会清空 .tmp，ZIP 需要跨轮存活
const zipPath = path.join(here, 'export.zip');
if (await stat(zipPath).then(() => true).catch(() => false)) {
  const zipBuf = await readFile(zipPath);
  check('识别为 ZIP', looksLikeZip(zipBuf));
  const entries = readZip(zipBuf).map((e) => ({ name: path.basename(e.name), buffer: e.data }));
  // 约定的 fixture：ZIP 里只放官方导出的 amount + cost 两个 CSV
  check('ZIP 内 2 个文件', entries.length === 2, entries.map((e) => e.name));
  const expanded = expandFiles([{ name: 'export.zip', buffer: zipBuf }]);
  check('expandFiles 展开出 2 个数据文件', expanded.length === 2, expanded.map((f) => f.name));
  const zipped = ingestFiles([{ name: 'export.zip', buffer: zipBuf }]);
  const z = analyze(zipped, { bucket: 'day' });
  check('ZIP 直读的 token 与分离文件一致', z.totals.tokens === result.totals.tokens, [z.totals.tokens, result.totals.tokens]);
  check('ZIP 直读的 model/key 数一致', zipped.stats.keys.length === 2 && zipped.stats.models.length === 2);
} else {
  console.log('  · 跳过（test/export.zip 不存在；先跑一次本脚本生成 fixtures，再把 test/.tmp/fixtures 里的 amount/cost 两个 CSV 打成 test/export.zip 后重跑）');
}

// ─────────────────────────── 6b. 跨文件重叠去重 ───────────────────────────
console.log('\n[6b] 重叠账期去重');
{
  // 构造一个“时间范围相交”的导出：只含 8/1、8/2 两天的 amount 行
  const lines = amountText.split('\n');
  const overlapRows = lines.filter((line, i) => i === 0 || /2026-08-0[12]T/.test(line));
  check('重叠文件确实筛出了 2 天', overlapRows.length > 3, overlapRows.length);
  const overlapText = overlapRows.join('\n');

  const single = ingestFiles([
    { name: 'amount-2026-08.csv', buffer: buf(amountText) },
    { name: 'cost-2026-08.csv', buffer: buf(costText) },
  ]);
  const overlapped = ingestFiles([
    { name: 'amount-2026-08.csv', buffer: buf(amountText) },
    { name: 'amount-overlap-08.csv', buffer: buf(overlapText) },
    { name: 'cost-2026-08.csv', buffer: buf(costText) },
  ]);
  check('去重后 token 与单份一致', overlapped.stats.totals.tokens === single.stats.totals.tokens, [
    overlapped.stats.totals.tokens,
    single.stats.totals.tokens,
  ]);
  check('去重后请求数不翻倍', overlapped.stats.totals.requests === single.stats.totals.requests, [
    overlapped.stats.totals.requests,
    single.stats.totals.requests,
  ]);
  check('去重统计 active', overlapped.stats.dedupe.active === true, overlapped.stats.dedupe);
  check('去重计入了重复单元格', overlapped.stats.dedupe.cells > 0, overlapped.stats.dedupe.cells);
  check('重叠天数 = 2', overlapped.stats.dedupe.overlapDays === 2, overlapped.stats.dedupe.overlapDays);
  check('有去重告警', (overlapped.warnings || []).some((w) => w.includes('去重')), overlapped.warnings);
  const na = analyze(overlapped, { bucket: 'day' });
  check('去重后费用不分摊两份', na.quality.unmatchedBilledCost === 0, na.quality.unmatchedBilledCost);
  check('未发生去重时 active=false', single.stats.dedupe.active === false, single.stats.dedupe);
}

// ─────────────────────────── 7. store ───────────────────────────
console.log('\n[7] 数据集仓库');
{
  const store = createStore(path.join(tmp, 'store'));
  const meta = await store.create('测试数据集');
  const added = await store.addFiles(meta.id, [
    { name: 'amount-2026-08.csv', buffer: buf(amountText) },
    { name: 'cost-2026-08.csv', buffer: buf(costText) },
  ]);
  check('rows 落盘并解析', added.rows.records.length === 40, added.rows.records.length);
  const loaded = await store.get(meta.id);
  check('get 读回 meta + rows', loaded.meta.id === meta.id && loaded.rows.records.length === 40);
  const listed = await store.list();
  check('list 返回 1 条', listed.length === 1, listed.length);
  check('meta.rowCount 正确', listed[0].stats.totals.hit === expected.hit, listed[0].stats.totals.hit);
  await store.saveGroups({ keys: { 'Key A': '项目甲' }, models: {} });
  const groups = await store.groups();
  check('分组持久化', groups.keys['Key A'] === '项目甲', groups);
  check('find 按名称命中', (await store.find('测试'))?.id === meta.id);
  check('latest 可用', (await store.latest())?.id === meta.id);

  // 同名文件重传 → 覆盖而不是重复累加
  const again = await store.addFiles(meta.id, [{ name: 'amount-2026-08.csv', buffer: buf(amountText) }]);
  check('同名文件覆盖后 token 不变', again.rows.stats.totals.hit === expected.hit, again.rows.stats.totals.hit);
  check('files 清单仍为 2', again.meta.files.length === 2, again.meta.files.map((f) => f.name));

  await store.remove(meta.id);
  check('删除后 list 为空', (await store.list()).length === 0);
}

console.log(`\n${failed === 0 ? '全部通过 ✅' : `${failed} 项失败 ❌`}`);
process.exit(failed === 0 ? 0 : 1);
