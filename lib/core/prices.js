/**
 * 内置价目表 + 汇率换算。
 *
 * 用途：当数据源没有给出单价（通用 CSV / JSON 常只有 token 数）时，
 * 用内置价目表估算费用与“缓存命中节省了多少钱”。
 *
 * 注意：官方导出 ZIP 自带 price 列，那条路径下绝不使用本表——
 * 本表只是兜底估算，界面上会标注“估算”。
 * 单位：每 token 的美元价格（USD / token）。
 */

export const MODEL_PRICES = {
  // 2026-08 官方价（USD / 1M tokens）
  'deepseek-v4-flash': { input: 0.14e-6, cached: 0.0028e-6, output: 0.28e-6, currency: 'USD' },
  'deepseek-v4-pro': { input: 0.435e-6, cached: 0.003625e-6, output: 0.87e-6, currency: 'USD' },
  // 历史模型
  'deepseek-chat': { input: 0.27e-6, cached: 0.07e-6, output: 1.1e-6, currency: 'USD' },
  'deepseek-reasoner': { input: 0.55e-6, cached: 0.14e-6, output: 2.19e-6, currency: 'USD' },
};

/** 粗略汇率：仅用于“估算价（USD）”与“账单币种（CNY）”之间的换算。 */
export const FX_TO_USD = { USD: 1, CNY: 1 / 7.1, EUR: 1.09, JPY: 1 / 150 };

/**
 * 按模型名查价：先精确匹配，再按关键字模糊匹配（兼容带前缀/后缀的模型名）。
 * @returns {{input:number,cached:number,output:number,currency:string}|null}
 */
export function lookupModelPrice(model) {
  if (!model) return null;
  const name = String(model).toLowerCase().trim();
  if (MODEL_PRICES[name]) return MODEL_PRICES[name];
  if (name.includes('flash')) return MODEL_PRICES['deepseek-v4-flash'];
  if (name.includes('pro')) return MODEL_PRICES['deepseek-v4-pro'];
  if (name.includes('reasoner')) return MODEL_PRICES['deepseek-reasoner'];
  if (name.includes('chat')) return MODEL_PRICES['deepseek-chat'];
  return null;
}

/** 把 amount（from 币种）换算到 to 币种；未知币种按 1:1 处理。 */
export function convertCurrency(amount, from, to) {
  if (!Number.isFinite(amount) || amount === 0) return 0;
  if (!from || !to || from === to) return amount;
  const f = FX_TO_USD[String(from).toUpperCase()];
  const t = FX_TO_USD[String(to).toUpperCase()];
  if (!f || !t) return amount;
  return (amount * f) / t;
}
