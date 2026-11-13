/**
 * 摄入管线：原始文件 → 归一化数据集（rows.json 的内容）。
 *
 * 数据流：
 *   字节 → expandFiles(ZIP 解包) → resolveAdapter(按表头认领) → parse
 *        → 记录按 (日期, 模型, Key) 合并 + 账单费用按 (日期, 模型) 合并
 *        → 汇总统计（模型/Key/日期范围/缺失账单告警）
 */
import { expandFiles, resolveAdapter } from './adapters/index.js';
import { mergeInto, mergeMaxInto, recordId, totalTokens } from './record.js';
import { monthOf } from './util.js';

export const ROWS_VERSION = 1;

export function ingestFiles(files, options = {}) {
  const expanded = expandFiles(files);
  if (!expanded.length) throw new Error('没有可解析的 CSV / JSON 文件（ZIP 内也未找到）');

  const recordMap = new Map();
  const billedMap = new Map();
  /** 每个 (日期,模型,Key) / (日期,模型) 单元格第一次出现的文件下标，用于识别跨文件重复。 */
  const recordOrigin = new Map();
  const billedOrigin = new Map();
  /** 日期 → 出现过该 token 明细的文件下标集合（用于“重叠账期”提示）。 */
  const tokenDayFiles = new Map();
  /** 同上，但只统计账单（cost）文件——amount 与 cost 覆盖同一天是正常配对，不算重叠。 */
  const billedDayFiles = new Map();
  let dedupedCells = 0;
  let dedupedBilledCells = 0;
  const warnings = [];
  const fileReport = [];
  const currencies = [];

  for (let fi = 0; fi < expanded.length; fi += 1) {
    const file = expanded[fi];
    const adapter = resolveAdapter(file);
    if (!adapter) {
      warnings.push(`${file.name}: 无法识别的文件格式，已跳过`);
      fileReport.push({ name: file.name, adapter: null, error: '无法识别的格式' });
      continue;
    }
    try {
      const result = adapter.parse(file.text, { fileName: file.name });
      const records = result.records || [];

      for (const rec of records) {
        const id = recordId(rec.date, rec.model, rec.key);
        const seenIn = recordOrigin.get(id);
        if (seenIn !== undefined && seenIn !== fi) {
          // 同一账期在别的文件里已经出现过：文件名不同 = 重叠导出，取较大值而不是相加
          mergeMaxInto(recordMap, rec);
          dedupedCells += 1;
        } else {
          // 同一文件内的多行是真实的拆分（例如按批次/按 Key），必须累加
          mergeInto(recordMap, rec);
        }
        recordOrigin.set(id, fi);
        markDay(tokenDayFiles, rec.date, fi);
      }

      for (const entry of result.billed || []) {
        const id = `${entry.date}\u0001${entry.model || ''}`;
        const seenIn = billedOrigin.get(id);
        const cur = billedMap.get(id) || { date: entry.date, model: entry.model || '', cost: 0, currency: '' };
        if (seenIn !== undefined && seenIn !== fi) {
          cur.cost = Math.max(Math.abs(cur.cost), Math.abs(entry.cost || 0));
          dedupedBilledCells += 1;
        } else {
          cur.cost += entry.cost || 0;
        }
        if (!cur.currency && entry.currency) cur.currency = entry.currency;
        billedMap.set(id, cur);
        billedOrigin.set(id, fi);
        markDay(billedDayFiles, entry.date, fi);
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

  // 重叠账期：同一天被两个及以上同类文件覆盖，说明用户拖入了时间范围相交的导出
  const overlapDays = new Set([
    ...[...tokenDayFiles.entries()].filter(([, idxs]) => idxs.size > 1).map(([day]) => day),
    ...[...billedDayFiles.entries()].filter(([, idxs]) => idxs.size > 1).map(([day]) => day),
  ]);
  const overlapList = [...overlapDays].sort();
  if (dedupedCells || dedupedBilledCells || overlapList.length) {
    const head = overlapList.slice(0, 5).join('、');
    const tail = overlapList.length > 5 ? ` 等 ${overlapList.length} 天` : '';
    warnings.push(
      `检测到时间范围重叠的导出文件${overlapList.length ? `（${head}${tail}）` : ''}，` +
        `已按「日期 × 模型 × Key」去重：合并 ${dedupedCells} 条 token 记录、${dedupedBilledCells} 条费用记录，重复部分只计一次`,
    );
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
      // 去重结果：cells = 因跨文件重复而没有被重复计入的 token 记录数
      dedupe: {
        cells: dedupedCells,
        billedCells: dedupedBilledCells,
        overlapDays: overlapList.length,
        overlapDayList: overlapList.slice(0, 60),
        active: Boolean(dedupedCells || dedupedBilledCells),
      },
    },
  };
}

/** 记录某个账期日被哪个文件覆盖过。 */
function markDay(dayFiles, day, fileIndex) {
  if (!day) return;
  const set = dayFiles.get(day);
  if (set) set.add(fileIndex);
  else dayFiles.set(day, new Set([fileIndex]));
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
