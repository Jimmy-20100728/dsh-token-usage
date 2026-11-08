/**
 * 分析核心：归一化记录 + 账单 → 趋势序列 / 维度对比 / 缓存命中 / 异常检测。
 *
 * 这一层刻意不碰文件系统，纯函数式：输入 rows.json 内容 + 参数，输出可 JSON 化的结果。
 * 工具（token_analysis）和 HTTP 路由共用同一个 analyze()，保证两侧数字一致。
 *
 * 费用口径（重要）：
 *   1. billed  —— cost-*.csv 给出了 (日期, 模型) 的权威账单总额，按 token/单价权重分摊到各 Key；
 *   2. reported—— 通用 CSV/JSON 自带的 cost 列（视为确定值）；
 *   3. price   —— 官方 amount CSV 的 price 列 × 数量；
 *   4. estimated—— 以上都没有时用内置价目表估算（界面会标注）。
 */
import { lookupModelPrice, convertCurrency } from './prices.js';
import { monthOf, round, safeDiv, weekStart, addDays, diffDays } from './util.js';
import { totalTokens } from './record.js';

const BUCKETS = new Set(['day', 'week', 'month']);

export function bucketKey(day, bucket) {
  if (bucket === 'week') return weekStart(day);
  if (bucket === 'month') return monthOf(day);
  return day;
}

/** 从 from/to 里推导“起止日期”：优先显式参数，其次数据集范围。 */
export function resolveRange(data, options = {}) {
  const all = [...(data.records || []).map((r) => r.date), ...(data.billed || []).map((b) => b.date)]
    .filter(Boolean)
    .sort();
  const min = all[0] || '';
  const max = all[all.length - 1] || '';
  const from = options.from && /^\d{4}-\d{2}-\d{2}$/.test(options.from) ? options.from : min;
  const to = options.to && /^\d{4}-\d{2}-\d{2}$/.test(options.to) ? options.to : max;
  return { from, to, min, max };
}

/** 记录的费用（带来源标记）。 */
function costOf(rec, currency) {
  if (Number.isFinite(rec.allocatedCost)) return { cost: rec.allocatedCost, source: 'billed' };
  if (rec.cost > 0) return { cost: rec.cost, source: 'reported' };
  if (rec.hintCost > 0) return { cost: rec.hintCost + (rec.fnCost || 0), source: 'price' };

  const price = lookupModelPrice(rec.model);
  if (!price) return { cost: rec.fnCost || 0, source: 'unknown' };
  const raw =
    rec.miss * price.input + rec.hit * price.cached + rec.output * price.output;
  return { cost: convertCurrency(raw, price.currency, currency), source: 'estimated' };
}

/**
 * @param {object} data rows.json 内容
 * @param {{bucket?:string,from?:string,to?:string,groupBy?:string,top?:number,groups?:object}} options
 */
export function analyze(data, options = {}) {
  const bucket = BUCKETS.has(options.bucket) ? options.bucket : 'day';
  const top = Math.max(1, Math.min(200, Number(options.top) || 10));
  const currency = data.currency || 'CNY';
  const groups = options.groups || {};
  const groupOfKey = groups.keys || {};
  const groupOfModel = groups.models || {};
  const range = resolveRange(data, options);

  const records = (data.records || []).filter(
    (r) => r.date >= range.from && r.date <= range.to,
  );

  // ── 1. 账单分摊：同一 (日期, 模型) 的账单总额按权重分摊到各 Key ──────────────
  const billedIndex = new Map();
  for (const entry of data.billed || []) {
    if (entry.date < range.from || entry.date > range.to) continue;
    const id = `${entry.date}\u0001${entry.model || ''}`;
    const cur = billedIndex.get(id) || { cost: 0, currency: entry.currency || '' };
    cur.cost += entry.cost || 0;
    billedIndex.set(id, cur);
  }

  const byModelDay = new Map();
  for (const rec of records) {
    const id = `${rec.date}\u0001${rec.model || ''}`;
    const list = byModelDay.get(id) || [];
    list.push(rec);
    byModelDay.set(id, list);
  }

  let allocatedTotal = 0;
  const consumedBilled = new Set();
  for (const [id, list] of byModelDay) {
    const billed = billedIndex.get(id);
    if (!billed) continue;
    const weights = list.map((rec) => {
      if (rec.hintCost > 0) return rec.hintCost;
      const tokens = totalTokens(rec);
      // 输出 token 单价通常是输入的数倍，加权时略微放大，避免 Key 间分摊失真
      return tokens > 0 ? rec.miss + rec.hit * 0.1 + rec.output * 2 : 1;
    });
    const weightSum = weights.reduce((a, b) => a + b, 0) || list.length;
    list.forEach((rec, i) => {
      rec.allocatedCost = (billed.cost * weights[i]) / weightSum;
      allocatedTotal += rec.allocatedCost;
    });
    consumedBilled.add(id);
  }

  // 有账单、但没有任何 token 明细的 (日期, 模型)：只能计入总额，无法拆分到 Key
  let unmatchedBilled = 0;
  for (const [id, billed] of billedIndex) {
    if (!consumedBilled.has(id)) unmatchedBilled += billed.cost;
  }

  // ── 2. 逐条计算费用 / 缓存节省 / 分组 ──────────────────────────────────────
  let costSum = 0;
  let costEstimated = 0;
  let cacheSavings = 0;
  let savingsEstimated = false;

  const enriched = records.map((rec) => {
    const { cost, source } = costOf(rec, currency);
    costSum += cost;
    if (source === 'estimated') costEstimated += cost;

    let saving = 0;
    if (rec.priceHit != null && rec.priceMiss != null && rec.priceMiss > rec.priceHit) {
      saving = rec.hit * (rec.priceMiss - rec.priceHit);
    } else {
      const price = lookupModelPrice(rec.model);
      if (price) {
        saving = convertCurrency(rec.hit * (price.input - price.cached), price.currency, currency);
        if (saving > 0) savingsEstimated = true;
      }
    }
    cacheSavings += Math.max(0, saving);

    return {
      ...rec,
      group: groupOfModel[rec.model] || groupOfKey[rec.key] || rec.group || '未分组',
      cost: round(cost, 8),
      costSource: source,
      cacheSaving: round(Math.max(0, saving), 8),
      tokens: totalTokens(rec),
    };
  });

  if (unmatchedBilled > 0) costSum += unmatchedBilled;

  // ── 3. 趋势序列（自动补齐空缺桶，避免折线断档）─────────────────────────────
  const seriesMap = new Map();
  for (const rec of enriched) {
    const key = bucketKey(rec.date, bucket);
    const cell = seriesMap.get(key) || emptyCell();
    cell.hit += rec.hit;
    cell.miss += rec.miss;
    cell.output += rec.output;
    cell.requests += rec.requests;
    cell.tokens += rec.tokens;
    cell.cost += rec.cost;
    seriesMap.set(key, cell);
  }
  if (unmatchedBilled > 0) {
    // 未匹配的账单按日期落到序列里，保证“费用曲线”与总额一致
    for (const [id, billed] of billedIndex) {
      if (consumedBilled.has(id)) continue;
      const date = id.split('\u0001')[0];
      const cell = seriesMap.get(bucketKey(date, bucket)) || emptyCell();
      cell.cost += billed.cost;
      seriesMap.set(bucketKey(date, bucket), cell);
    }
  }

  const series = fillBuckets(seriesMap, range, bucket).map(([key, cell]) => ({
    bucket: key,
    hit: Math.round(cell.hit),
    miss: Math.round(cell.miss),
    output: Math.round(cell.output),
    tokens: Math.round(cell.tokens),
    requests: Math.round(cell.requests),
    cost: round(cell.cost, 6),
  }));

  // ── 4. 维度对比 ────────────────────────────────────────────────────────────
  const byModel = aggregate(enriched, (r) => r.model, top);
  const byKey = aggregate(enriched, (r) => r.key || '(未标注 Key)', top);
  const byGroup = aggregate(enriched, (r) => r.group || '未分组', top);

  // ── 5. 缓存 / 构成 ─────────────────────────────────────────────────────────
  const totals = enriched.reduce(
    (acc, rec) => {
      acc.hit += rec.hit;
      acc.miss += rec.miss;
      acc.output += rec.output;
      acc.requests += rec.requests;
      acc.tokens += rec.tokens;
      return acc;
    },
    { hit: 0, miss: 0, output: 0, requests: 0, tokens: 0 },
  );

  const inputTotal = totals.hit + totals.miss;
  const days = series.filter((s) => s.tokens > 0 || s.cost > 0).length || 0;

  // ── 6. 异常检测：按“日”粒度，与自身历史比较（不跨模型）───────────────────
  const anomalies = detectAnomalies(dailySeries(enriched, range), options.anomalyThreshold);

  const result = {
    datasetId: options.datasetId || '',
    currency,
    range: { from: range.from, to: range.to, days, spanDays: range.from && range.to ? diffDays(range.from, range.to) + 1 : 0 },
    bucket,
    totals: {
      tokens: Math.round(totals.tokens),
      hit: Math.round(totals.hit),
      miss: Math.round(totals.miss),
      output: Math.round(totals.output),
      input: Math.round(inputTotal),
      requests: Math.round(totals.requests),
      cost: round(costSum, 6),
      cacheHitRate: inputTotal ? round(totals.hit / inputTotal, 6) : 0,
      cacheSavings: round(cacheSavings, 6),
      savingsEstimated,
      avgCostPerDay: days ? round(costSum / days, 6) : 0,
      avgTokensPerDay: days ? Math.round(totals.tokens / days) : 0,
      avgCostPerRequest: totals.requests ? round(costSum / totals.requests, 8) : 0,
    },
    series,
    byModel,
    byKey,
    byGroup,
    anomalies,
    composition: [
      { key: 'hit', label: '输入·缓存命中', tokens: Math.round(totals.hit) },
      { key: 'miss', label: '输入·未命中', tokens: Math.round(totals.miss) },
      { key: 'output', label: '输出', tokens: Math.round(totals.output) },
    ],
    quality: {
      recordCount: enriched.length,
      estimatedCostShare: costSum ? round(costEstimated / costSum, 4) : 0,
      unmatchedBilledCost: round(unmatchedBilled, 6),
      hasBilledCost: consumedBilled.size > 0,
      warnings: (data.warnings || []).slice(0, 20),
    },
    insights: buildInsights({ totals, costSum, cacheSavings, byModel, byKey, anomalies, currency }),
  };

  return result;
}

function emptyCell() {
  return { hit: 0, miss: 0, output: 0, tokens: 0, cost: 0, requests: 0 };
}

/** 补齐空缺桶（只补 day/week/month 的连续区间）。 */
function fillBuckets(map, range, bucket) {
  const keys = [...map.keys()].sort();
  if (!keys.length) return [];
  if (!range.from || !range.to) return keys.map((k) => [k, map.get(k)]);

  const out = [];
  if (bucket === 'day') {
    const end = range.to;
    for (let day = range.from; day <= end; day = addDays(day, 1)) {
      out.push([day, map.get(day) || emptyCell()]);
    }
    return out;
  }
  if (bucket === 'month') {
    let [y, m] = range.from.slice(0, 7).split('-').map(Number);
    const endKey = range.to.slice(0, 7);
    for (;;) {
      const key = `${y}-${String(m).padStart(2, '0')}`;
      out.push([key, map.get(key) || emptyCell()]);
      if (key >= endKey) break;
      m += 1;
      if (m > 12) { m = 1; y += 1; }
    }
    return out;
  }
  // week
  let cursor = weekStart(range.from);
  const last = weekStart(range.to);
  for (;;) {
    out.push([cursor, map.get(cursor) || emptyCell()]);
    if (cursor >= last) break;
    cursor = addDays(cursor, 7);
  }
  return out;
}

/** 维度聚合：按 name 汇总，取前 top 个，其余合并为「其它」。 */
function aggregate(rows, keyFn, top) {
  const map = new Map();
  for (const rec of rows) {
    const name = keyFn(rec) || '(未知)';
    const cell = map.get(name) || { name, tokens: 0, hit: 0, miss: 0, output: 0, cost: 0, requests: 0 };
    cell.tokens += rec.tokens;
    cell.hit += rec.hit;
    cell.miss += rec.miss;
    cell.output += rec.output;
    cell.cost += rec.cost;
    cell.requests += rec.requests;
    map.set(name, cell);
  }
  const list = [...map.values()].sort((a, b) => b.tokens - a.tokens || b.cost - a.cost);
  const totalTokensAll = list.reduce((a, b) => a + b.tokens, 0) || 1;
  const head = list.slice(0, top).map((cell) => ({
    name: cell.name,
    tokens: Math.round(cell.tokens),
    hit: Math.round(cell.hit),
    miss: Math.round(cell.miss),
    output: Math.round(cell.output),
    requests: Math.round(cell.requests),
    cost: round(cell.cost, 6),
    share: round(cell.tokens / totalTokensAll, 6),
    cacheHitRate: cell.hit + cell.miss ? round(cell.hit / (cell.hit + cell.miss), 6) : 0,
  }));
  if (list.length > top) {
    const rest = list.slice(top);
    const sum = rest.reduce(
      (acc, c) => ({
        tokens: acc.tokens + c.tokens,
        hit: acc.hit + c.hit,
        miss: acc.miss + c.miss,
        output: acc.output + c.output,
        cost: acc.cost + c.cost,
        requests: acc.requests + c.requests,
      }),
      { tokens: 0, hit: 0, miss: 0, output: 0, cost: 0, requests: 0 },
    );
    head.push({
      name: `其它 ${rest.length} 项`,
      tokens: Math.round(sum.tokens),
      hit: Math.round(sum.hit),
      miss: Math.round(sum.miss),
      output: Math.round(sum.output),
      requests: Math.round(sum.requests),
      cost: round(sum.cost, 6),
      share: round(sum.tokens / totalTokensAll, 6),
      cacheHitRate: sum.hit + sum.miss ? round(sum.hit / (sum.hit + sum.miss), 6) : 0,
      aggregated: true,
    });
  }
  return head;
}

/** 按日汇总（异常检测专用，与展示粒度无关）。 */
function dailySeries(rows, range) {
  const map = new Map();
  for (const rec of rows) {
    const cell = map.get(rec.date) || { day: rec.date, tokens: 0, cost: 0, requests: 0 };
    cell.tokens += rec.tokens;
    cell.cost += rec.cost;
    cell.requests += rec.requests;
    map.set(rec.date, cell);
  }
  const out = [];
  if (range.from && range.to) {
    for (let day = range.from; day <= range.to; day = addDays(day, 1)) {
      out.push(map.get(day) || { day, tokens: 0, cost: 0, requests: 0 });
    }
  } else {
    out.push(...map.values());
  }
  return out;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * 异常检测：中位数 + MAD（比均值/标准差更抗离群点），
 * 同时要求绝对值至少是日常的 1.5 倍，避免把“平时几乎为 0”的噪声日误报。
 */
function detectAnomalies(daily, customThreshold) {
  const threshold = Number(customThreshold) > 0 ? Number(customThreshold) : 3.5;
  const list = daily.filter((d) => d.tokens > 0);
  if (list.length < 4) return [];

  const results = [];
  for (const metric of ['tokens', 'cost']) {
    const values = list.map((d) => d[metric]);
    const med = median(values);
    if (med <= 0) continue;
    const deviations = values.map((v) => Math.abs(v - med));
    const mad = median(deviations);
    const scale = mad * 1.4826 || 0;

    for (const d of list) {
      const value = d[metric];
      if (value <= med * 1.5) continue;
      const z = scale > 0 ? (value - med) / scale : value / med;
      if (z >= threshold) {
        results.push({
          day: d.day,
          metric,
          value: metric === 'tokens' ? Math.round(value) : round(value, 6),
          median: metric === 'tokens' ? Math.round(med) : round(med, 6),
          ratio: round(value / med, 2),
          z: round(z, 2),
        });
      }
    }
  }
  return results.sort((a, b) => b.z - a.z).slice(0, 10);
}

/** 生成中文结论（工具输出与界面共用）。 */
function buildInsights({ totals, costSum, cacheSavings, byModel, byKey, anomalies, currency }) {
  const out = [];
  if (totals.cacheHitRate > 0) {
    const payFull = totals.miss + totals.hit;
    const savedRatio = costSum + cacheSavings > 0 ? cacheSavings / (costSum + cacheSavings) : 0;
    out.push(
      `缓存命中率 ${(totals.cacheHitRate * 100).toFixed(1)}%，累计节省约 ${cacheSavings.toFixed(4)} ${currency}` +
        `（相当于未命中全部输入时的 ${(savedRatio * 100).toFixed(1)}%）。`,
    );
    out.push(`实际计费输入 ${payFull.toLocaleString('zh-CN')} token，输出 ${totals.output.toLocaleString('zh-CN')} token。`);
  }
  if (byModel.length) {
    const m = byModel[0];
    out.push(`用量最大的模型是 ${m.name}，占 ${(m.share * 100).toFixed(1)}%，费用 ${m.cost.toFixed(4)} ${currency}。`);
  }
  if (byKey.length > 1) {
    const k = byKey[0];
    out.push(`最活跃的 Key 是 ${k.name}，占 ${(k.share * 100).toFixed(1)}%。`);
  }
  for (const a of anomalies.slice(0, 3)) {
    out.push(
      `${a.day} 的${a.metric === 'tokens' ? ' token 用量' : '费用'}为日常的 ${a.ratio} 倍（${a.metric === 'tokens' ? a.value.toLocaleString('zh-CN') : a.value}），建议核查。`,
    );
  }
  return out;
}

export { safeDiv };
