/**
 * DeepSeek 官方账单导出适配器。
 *
 * 官方导出的 ZIP 里是两类 CSV（每月一对）：
 *   amount-2026-8.csv  / amount-2026-08-01_2026-08-17.csv
 *     user_id,start_time_iso,end_time_iso,model,api_key_name,api_key,type,price,amount
 *     type ∈ request_count | output_tokens | input_cache_hit_tokens |
 *            input_cache_miss_tokens | (2026-11 起) function_call
 *     price = 每 token 的本地货币单价（request_count 行为空），amount = 数量
 *   cost-2026-8.csv / cost-2026-08-01_2026-08-17.csv
 *     user_id,start_time_iso,end_time_iso,model,wallet_type,cost,currency
 *     （旧版首列是 utc_date，且没有 end_time_iso）
 *
 * 两者缺一不可：只有 amount 时费用按 price×amount 推算，只有 cost 时只有总额没有 token。
 */
import { csvRecords, num } from '../csv.js';
import { str, toDay } from '../util.js';
import { mergeInto, newRecord } from '../record.js';

const AMOUNT_TYPES = {
  request_count: 'requests',
  output_tokens: 'output',
  input_cache_hit_tokens: 'hit',
  input_cache_miss_tokens: 'miss',
};

function headersMatch(headers) {
  return new Set(headers.map((h) => String(h).toLowerCase().trim()));
}

export const deepseekAmountAdapter = {
  id: 'deepseek-amount',
  label: 'DeepSeek 用量明细 (amount-*.csv)',
  match(headers) {
    const h = headersMatch(headers);
    const hasTime = h.has('start_time_iso') || h.has('utc_date') || h.has('end_time_iso');
    return h.has('type') && h.has('amount') && hasTime;
  },
  parse(text) {
    const { headers, records } = csvRecords(text);
    const h = headersMatch(headers);
    const hasKey = h.has('api_key_name') || h.has('api_key');
    const warnings = [];
    const map = new Map();
    let unknownType = 0;
    let skipped = 0;

    for (const row of records) {
      const date = toDay(row.start_time_iso || row.utc_date || row.end_time_iso);
      if (!date) { skipped += 1; continue; }
      const model = str(row.model);
      const key = hasKey ? str(row.api_key_name) || str(row.api_key) : '';
      const type = str(row.type).toLowerCase();
      const amount = Math.abs(num(row.amount));
      const priceRaw = str(row.price);
      const price = priceRaw === '' ? null : num(row.price);

      const rec = newRecord(date, model, key);
      rec.currency = '';

      if (type === 'function_call') {
        // 工具调用计费：amount 为调用次数，price 为每次单价（部分版本按 1000 次计价）
        rec.requests += amount;
        rec.fnCost = (price || 0) * amount;
      } else {
        const field = AMOUNT_TYPES[type];
        if (!field) { unknownType += 1; continue; }
        rec[field] = amount;
        if (price !== null && price > 0) {
          rec.hintCost = price * amount;
          if (type === 'input_cache_hit_tokens') rec.priceHit = price;
          else if (type === 'input_cache_miss_tokens') rec.priceMiss = price;
          else if (type === 'output_tokens') rec.priceOutput = price;
        }
      }
      mergeInto(map, rec);
    }

    if (skipped) warnings.push(`${skipped} 行缺少可识别的日期，已跳过`);
    if (unknownType) warnings.push(`${unknownType} 行的 type 不在已知范围内，已跳过`);

    return { records: [...map.values()], billed: [], warnings };
  },
};

export const deepseekCostAdapter = {
  id: 'deepseek-cost',
  label: 'DeepSeek 费用账单 (cost-*.csv)',
  match(headers) {
    const h = headersMatch(headers);
    const hasTime = h.has('start_time_iso') || h.has('utc_date') || h.has('end_time_iso');
    return hasTime && h.has('cost') && (h.has('currency') || h.has('wallet_type'));
  },
  parse(text) {
    const { headers, records } = csvRecords(text);
    const h = headersMatch(headers);
    const warnings = [];
    const map = new Map();
    let skipped = 0;

    for (const row of records) {
      const date = toDay(row.start_time_iso || row.utc_date || row.end_time_iso);
      if (!date) { skipped += 1; continue; }
      const model = str(row.model);
      const cost = Math.abs(num(row.cost)); // 退款/冲正会带负号，统计口径取绝对值
      const currency = h.has('currency') ? str(row.currency) : '';
      const id = `${date}\u0001${model}`;
      const cur = map.get(id) || { date, model, cost: 0, currency: '' };
      cur.cost += cost;
      if (!cur.currency && currency) cur.currency = currency;
      map.set(id, cur);
    }

    if (skipped) warnings.push(`费用账单有 ${skipped} 行缺少日期，已跳过`);
    return { records: [], billed: [...map.values()], warnings };
  },
};
