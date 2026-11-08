/**
 * 摄入管线：原始文件 → 归一化数据集（rows.json 的内容）。
 *
 * 数据流：
 *   字节 → expandFiles(ZIP 解包) → resolveAdapter(按表头认领) → parse
 *        → 记录按 (日期, 模型, Key) 合并 + 账单费用按 (日期, 模型) 合并
 *        → 汇总统计（模型/Key/日期范围/缺失账单告警）
 */
import { expandFiles, resolveAdapter } from './adapters/index.js';
import { mergeInto, totalTokens } from './record.js';
import { monthOf } from './util.js';

export const ROWS_VERSION = 1;

export function ingestFiles(files, options = {}) {
  const expanded = expandFiles(files);
  if (!expanded.length) throw new Error('没有可解析的 CSV / JSON 文件（ZIP 内也未找到）');

  const recordMap = new Map();
  const billedMap = new Map();
  const warnings = [];
  const fileReport = [];
  const currencies = [];

  for (const file of expanded) {
    const adapter = resolveAdapter(file);
    if (!adapter) {
      warnings.push(`${file.name}: 无法识别的文件格式，已跳过`);
      fileReport.push({ name: file.name, adapter: null, error: '无法识别的格式' });
      continue;
    }
    try {
      const result = adapter.parse(file.text, { fileName: file.name });
      const records = result.records || [];
      for (const rec of records) mergeInto(recordMap, rec);
      for (const entry of result.billed || []) {
        const id = `${entry.date}\u0001${entry.model || ''}`;
        const cur = billedMap.get(id) || { date: entry.date, model: entry.model || '', cost: 0, currency: '' };
        cur.cost += entry.cost || 0;
        if (!cur.currency && entry.currency) cur.currency = entry.currency;
        billedMap.set(id, cur);
      }
      if (result.currency) currencies.push(result.currency);
      for (const w of result.warnings || []) warnings.push(`${file.name}: ${w}`);
      fileReport.push({
        name: file.name,
        adapter: adapter.id,
        rows: records.length,
        billedRows: (result.billed || []).length,
      });
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      warnings.push(`${file.name}: ${message}`);
      fileReport.push({ name: file.name, adapter: adapter.id, error: message });
    }
  }

  const records = [...recordMap.values()];
  const billed = [...billedMap.values()];
  if (!records.length && !billed.length) {
    throw new Error(`没有解析出任何数据。${warnings.length ? warnings.join('；') : ''}`);
  }

  // 主币种：取出现最多的；官方 amount CSV 不带币种，默认人民币
  const currency = mostCommon(currencies) || options.currency || 'CNY';

  // 账单完整性检查：有 token 明细但缺同月费用账单时，界面需要提示“费用为推算值”
  const tokenMonths = new Set(records.map((r) => monthOf(r.date)));
  const billedMonths = new Set(billed.map((b) => monthOf(b.date)));
  const missingCostMonths = [...tokenMonths].filter((m) => !billedMonths.has(m)).sort();
  if (missingCostMonths.length) {
    warnings.push(`以下月份缺少 cost-*.csv 费用账单，费用为按单价推算：${missingCostMonths.join(', ')}`);
  }

  const dates = [...records.map((r) => r.date), ...billed.map((b) => b.date)].filter(Boolean).sort();
  const models = unique(records.map((r) => r.model).filter(Boolean));
  const keys = unique(records.map((r) => r.key).filter(Boolean));

  const totals = records.reduce(
    (acc, rec) => {
      acc.hit += rec.hit || 0;
      acc.miss += rec.miss || 0;
      acc.output += rec.output || 0;
      acc.requests += rec.requests || 0;
      acc.tokens += totalTokens(rec);
      return acc;
    },
    { hit: 0, miss: 0, output: 0, requests: 0, tokens: 0 },
  );

  return {
    version: ROWS_VERSION,
    currency,
    builtAt: new Date().toISOString(),
    records,
    billed,
    warnings,
    files: fileReport,
    stats: {
      rowCount: records.length,
      billedRowCount: billed.length,
      models,
      keys,
      from: dates[0] || '',
      to: dates[dates.length - 1] || '',
      totals,
    },
  };
}

function unique(list) {
  return [...new Set(list)].sort();
}

function mostCommon(list) {
  const counts = new Map();
  for (const v of list) if (v) counts.set(v, (counts.get(v) || 0) + 1);
  let best = '';
  let bestN = 0;
  for (const [k, n] of counts) if (n > bestN) { best = k; bestN = n; }
  return best;
}
