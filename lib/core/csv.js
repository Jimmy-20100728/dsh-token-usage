/**
 * 轻量 CSV 解析器（RFC 4180 子集，无第三方依赖）。
 *
 * 为什么自己写：插件要求“零依赖、纯 JS、可离线”，而 CSV 只需正确处理
 * 引号包裹、引号转义（""）、字段内换行、CRLF，就不需要 Papa Parse 这种库。
 *
 * 导出：
 *   parseCsv(text)      -> { headers, rows }    rows 是 string[][]（不含表头）
 *   csvRecords(text)    -> { headers, records } records 是 { 表头: 值 }[]
 *   detectDelimiter(line)
 */

/** 猜测分隔符：逗号 / 分号 / 制表符中，首个非空行里出现次数最多的那个。 */
export function detectDelimiter(line) {
  const counts = { ',': 0, ';': 0, '\t': 0 };
  for (const ch of line) if (ch in counts) counts[ch] += 1;
  let best = ',';
  for (const k of Object.keys(counts)) if (counts[k] > counts[best]) best = k;
  return best;
}

/** 去 BOM（Excel / Windows 导出的常见前缀）。 */
export function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * 核心分词：状态机扫描，一次遍历切出所有记录。
 * 支持字段内换行与 "" 转义；末尾空行自动丢弃。
 */
export function parseCsv(input, options = {}) {
  const text = stripBom(String(input ?? ''));
  if (!text.trim()) return { headers: [], rows: [] };

  const firstLineEnd = text.search(/\r?\n/);
  const delimiter = options.delimiter || detectDelimiter(text.slice(0, firstLineEnd < 0 ? text.length : firstLineEnd));

  const records = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    // 丢弃完全空白的行（常见的尾随换行）
    if (row.length > 1 || row[0] !== '') records.push(row);
    row = [];
  };

  while (i < text.length) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === delimiter) {
      pushField();
      i += 1;
      continue;
    }
    if (ch === '\r') {
      i += 1;
      continue;
    }
    if (ch === '\n') {
      pushRow();
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (field !== '' || row.length > 0) pushRow();

  if (!records.length) return { headers: [], rows: [] };
  const headers = records[0].map((h) => String(h).trim());
  const rows = records.slice(1);
  return { headers, rows };
}

/** 解析成对象数组；列数不足的行以空字符串补齐。 */
export function csvRecords(input, options = {}) {
  const { headers, rows } = parseCsv(input, options);
  const records = rows.map((cells) => {
    const obj = {};
    for (let i = 0; i < headers.length; i += 1) obj[headers[i]] = cells[i] === undefined ? '' : cells[i];
    return obj;
  });
  return { headers, records };
}

/** 数字列解析：容忍千分位、货币符号、空值、括号负数。 */
export function num(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  let s = String(value).trim();
  if (!s) return 0;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/[,\s¥$€£]/g, '');
  const n = Number(s);
  if (!Number.isFinite(n)) return 0;
  return neg ? -n : n;
}
