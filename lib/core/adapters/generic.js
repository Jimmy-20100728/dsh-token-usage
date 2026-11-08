/**
 * 通用表格映射：把“任意表头”的行对象映射成归一化记录。
 * 通用 CSV 与通用 JSON 共用这套逻辑，新增数据源只需加别名。
 */
import { num } from '../csv.js';
import { str, toDay, modeOf } from '../util.js';
import { mergeInto, newRecord } from '../record.js';

/** 归一化表头：小写 + 去空格/下划线/连字符/点。 */
function normKey(s) {
  return String(s || '').toLowerCase().replace(/[\s_\-.]/g, '');
}

/** 字段别名表（值已归一化）。越靠前越优先。 */
const ALIASES = {
  date: ['starttimeiso', 'utcdate', 'date', 'day', 'starttime', 'timestamp', 'time', 'createdat', 'datetime', '日期', '时间'],
  model: ['modelname', 'model', 'modelid', '模型', '模型名称'],
  key: ['apikeyname', 'keyname', 'apikey', 'key', 'tokenname', 'credentialname', '密钥', '密钥名称'],
  hit: ['inputcachehittokens', 'cachehittokens', 'cachedtokens', 'promptcachehittokens', 'cachereadtokens', 'hittokens', 'cachehit', '缓存命中'],
  miss: ['inputcachemisstokens', 'uncachedinputtokens', 'inputtokens', 'prompttokens', 'misstokens', 'cachewrite', '输入'],
  input: ['inputtokentotal', 'totalinputtokens', 'input'],
  output: ['outputtokens', 'completiontokens', 'output', 'generatedtokens', 'completion', '输出'],
  total: ['totaltokens', 'tokens', 'token', 'usage', '总token', '总量'],
  requests: ['requestcount', 'requests', 'request', 'calls', 'count', '请求数', '次数'],
  cost: ['totalcost', 'cost', 'spend', 'fee', 'amountcost', 'pricetotal', '费用', '金额', '花费'],
  currency: ['currency', 'unit', '币种'],
  group: ['group', 'project', 'tag', 'category', '分组', '项目', '标签'],
};

/** 为一批行对象建立 “字段 → 实际表头名” 索引。 */
export function buildAliasIndex(headers) {
  const normalized = headers.map((h) => ({ raw: h, norm: normKey(h) }));
  const index = {};
  for (const [field, list] of Object.entries(ALIASES)) {
    for (const want of list) {
      const hit = normalized.find((h) => h.norm === want);
      if (hit) { index[field] = hit.raw; break; }
    }
  }
  return index;
}

function cell(row, index, field) {
  const header = index[field];
  return header === undefined ? '' : row[header];
}

/**
 * 行对象 → 归一化记录。
 * @param {object[]} rows
 * @param {{ sourceName?: string }} meta
 */
export function recordsFromObjects(rows, meta = {}) {
  const warnings = [];
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return { records: [], currency: '', warnings: ['文件内没有数据行'] };

  // 表头取所有键的并集：JSON 里不同记录可能用不同字段名（如 key / api_key_name）
  const headers = [];
  const seenHeaders = new Set();
  for (const row of list) {
    for (const name of Object.keys(row || {})) {
      if (seenHeaders.has(name)) continue;
      seenHeaders.add(name);
      headers.push(name);
    }
  }
  const unionIndex = buildAliasIndex(headers);
  if (unionIndex.date === undefined) {
    throw new Error(`无法识别日期列（现有列：${headers.join(', ')}）`);
  }

  const map = new Map();
  const currencies = [];
  let splitEstimated = 0;
  let missingModel = 0;
  let index = unionIndex;
  let indexSignature = '';

  for (const row of list) {
    // 逐行建立映射：JSON 里不同记录可能用不同字段名（如 key / api_key_name），
    // 字段名一致时复用上一个索引，避免大文件重复构建。
    const signature = Object.keys(row || {}).join('\u0001');
    if (signature !== indexSignature) {
      index = buildAliasIndex(Object.keys(row || {}));
      indexSignature = signature;
    }

    const date = toDay(cell(row, index, 'date'));
    if (!date) continue;

    const model = str(cell(row, index, 'model'));
    if (!model) missingModel += 1;
    const key = str(cell(row, index, 'key'));
    const group = str(cell(row, index, 'group'));
    const currency = str(cell(row, index, 'currency')).toUpperCase();
    if (currency) currencies.push(currency);

    let hit = num(cell(row, index, 'hit'));
    let miss = num(cell(row, index, 'miss'));
    let output = num(cell(row, index, 'output'));
    const total = num(cell(row, index, 'total'));
    const hasSplit = index.hit !== undefined || index.miss !== undefined;

    if (!hasSplit || (hit === 0 && miss === 0)) {
      // 只有 total 或只有 input：无法区分缓存命中，全部算作“未命中输入”
      const inputAll = Math.abs(total) - Math.abs(output);
      miss = Math.max(0, inputAll > 0 ? inputAll : Math.abs(num(cell(row, index, 'input'))));
      hit = 0;
      if (total > 0) splitEstimated += 1;
    }

    const rec = newRecord(date, model || '(未标注模型)', key);
    rec.hit = Math.abs(hit);
    rec.miss = Math.abs(miss);
    rec.output = Math.abs(output);
    rec.requests = Math.abs(num(cell(row, index, 'requests')));
    rec.cost = Math.abs(num(cell(row, index, 'cost')));
    rec.currency = currency;
    rec.group = group;
    rec.estimated = !hasSplit;
    mergeInto(map, rec);
  }

  if (splitEstimated) {
    warnings.push(`${splitEstimated} 行只有总 token、没有缓存命中明细，已按“全部为未命中输入”估算`);
  }
  if (missingModel) warnings.push(`${missingModel} 行缺少模型名，已归入“(未标注模型)”`);
  if (!map.size) warnings.push('没有解析出有效数据行（日期列可能格式不受支持）');

  return { records: [...map.values()], currency: modeOf(currencies), warnings, source: meta.sourceName || '' };
}
