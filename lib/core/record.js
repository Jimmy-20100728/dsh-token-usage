/**
 * 归一化记录的工厂与合并逻辑。
 *
 * 一条记录 = 一个 (账期日 × 模型 × API Key) 的聚合行：
 *   date        账单日 YYYY-MM-DD（DeepSeek 语义：start_time_iso 的前 10 位）
 *   model       模型名
 *   key         API Key 名称（无则 ''）
 *   hit         输入 token（缓存命中）
 *   miss        输入 token（未命中）
 *   output      输出 token
 *   requests    请求数
 *   hintCost    由单价×数量算出的费用（官方 amount CSV 的 price 列，或内置价目估算）
 *   cost        数据源直接给出的确定费用（通用 CSV 的 cost 列）
 *   billedCost  账单文件（cost-*.csv）给出的当日该模型总费用，分析阶段再按权重分摊到 Key
 *   priceHit/priceMiss/priceOutput  每 token 单价（用于“缓存节省”的精确计算）
 *   group       用户在界面里指定的自定义分组（导入时为空，分析时按 groups.json 填充）
 */

export function newRecord(date, model, key) {
  return {
    date,
    model: model || '(未标注模型)',
    key: key || '',
    hit: 0,
    miss: 0,
    output: 0,
    requests: 0,
    hintCost: 0,
    cost: 0,
    fnCost: 0,
    currency: '',
    priceHit: null,
    priceMiss: null,
    priceOutput: null,
    group: '',
    estimated: false,
  };
}

/** 记录 id：同一天同一模型同一 Key 的行一定会被合并。 */
export function recordId(date, model, key) {
  return `${date}\u0001${model || ''}\u0001${key || ''}`;
}

/** 把一条（可能不完整的）记录并入 Map。 */
export function mergeInto(map, rec) {
  const id = recordId(rec.date, rec.model, rec.key);
  const cur = map.get(id);
  if (!cur) {
    map.set(id, { ...newRecord(rec.date, rec.model, rec.key), ...rec });
    return;
  }
  cur.hit += rec.hit || 0;
  cur.miss += rec.miss || 0;
  cur.output += rec.output || 0;
  cur.requests += rec.requests || 0;
  cur.hintCost += rec.hintCost || 0;
  cur.cost += rec.cost || 0;
  cur.fnCost += rec.fnCost || 0;
  if (!cur.currency && rec.currency) cur.currency = rec.currency;
  if (rec.priceHit != null) cur.priceHit = rec.priceHit;
  if (rec.priceMiss != null) cur.priceMiss = rec.priceMiss;
  if (rec.priceOutput != null) cur.priceOutput = rec.priceOutput;
  if (!cur.group && rec.group) cur.group = rec.group;
  cur.estimated = cur.estimated || Boolean(rec.estimated);
}

/** 记录的总 token（输入命中 + 输入未命中 + 输出）。 */
export function totalTokens(rec) {
  return (rec.hit || 0) + (rec.miss || 0) + (rec.output || 0);
}
