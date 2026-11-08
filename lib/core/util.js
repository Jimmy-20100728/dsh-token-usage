/**
 * 通用小工具：日期归一、字符串/数字清洗、四舍五入。
 * 所有适配器共享这里的日期语义，避免各写一套。
 */

/** 取字符串并 trim；null/undefined → ''。 */
export function str(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

/**
 * 把各种日期写法归一成 `YYYY-MM-DD`。
 *
 * 关键约定（对账正确性依赖它）：
 * DeepSeek 导出的 `start_time_iso` 是**北京时间当天零点**（如 `2026-08-02T00:00:00+08:00`），
 * 账单日必须直接取前 10 位字符。绝不能 `new Date(...)` 再转 UTC —— 那会把 8/2 的
 * 账记到 8/1，整月数据全部错位一天。
 */
export function toDay(value) {
  if (value === null || value === undefined || value === '') return '';
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const s = String(value).trim();
  // 已经是 ISO 日期/时间：直接截取日期部分（保留原时区的“当天”语义）
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  // 2026/8/2 或 2026.8.2
  const loose = /^(\d{4})[/.](\d{1,2})[/.](\d{1,2})/.exec(s);
  if (loose) return `${loose[1]}-${pad2(loose[2])}-${pad2(loose[3])}`;
  // 纯数字时间戳（秒 / 毫秒）
  if (/^\d{10}$/.test(s) || /^\d{13}$/.test(s)) {
    const ms = s.length === 10 ? Number(s) * 1000 : Number(s);
    const dt = new Date(ms);
    if (!Number.isNaN(dt.getTime())) {
      return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
    }
  }
  // 其它可被 Date 解析的写法（如 `Aug 2, 2026`）
  const dt = new Date(s);
  if (!Number.isNaN(dt.getTime())) {
    return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
  }
  return '';
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 2026-08-02 → 该周周一的日期（ISO 周，周一为首日）。 */
export function weekStart(day) {
  const [y, m, d] = day.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const wd = (dt.getUTCDay() + 6) % 7; // 周一=0
  dt.setUTCDate(dt.getUTCDate() - wd);
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

/** 2026-08-02 → `2026-08`。 */
export function monthOf(day) {
  return day.slice(0, 7);
}

/** 两个日期相差天数（b - a）。 */
export function diffDays(a, b) {
  const toUtc = (s) => {
    const [y, m, d] = s.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((toUtc(b) - toUtc(a)) / 86400000);
}

/** 加减天数，返回 `YYYY-MM-DD`。 */
export function addDays(day, delta) {
  const [y, m, d] = day.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

/** 今天的本地日期 `YYYY-MM-DD`。 */
export function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 去掉浮点尾差（费用求和后常见 0.30000000000000004）。 */
export function round(n, digits = 6) {
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/** 安全除。 */
export function safeDiv(a, b) {
  return b ? a / b : 0;
}

/** 取若干对象里出现次数最多的键（用于推断数据集主币种）。 */
export function modeOf(values) {
  const counts = new Map();
  for (const v of values) {
    if (!v) continue;
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  let best = '';
  let bestN = 0;
  for (const [k, n] of counts) if (n > bestN) { best = k; bestN = n; }
  return best;
}
