/**
 * 适配器注册表 + 文件展开。
 *
 * 新增数据源格式 = 在这里注册一个 { id, label, match, parse } 对象：
 *   match(headers)  : 仅对 CSV 调用，用于“抢在通用适配器之前”认领；返回 false 表示不认领
 *   parse(text,meta): 返回 { records, billed, currency, warnings }
 * 通用 CSV / JSON 适配器永远排最后，作为兜底。
 */
import { readZip, looksLikeZip } from '../zip.js';
import { detectDelimiter, stripBom } from '../csv.js';
import { deepseekAmountAdapter, deepseekCostAdapter } from './deepseek.js';
import { genericCsvAdapter } from './generic-csv.js';
import { genericJsonAdapter } from './generic-json.js';

export const ADAPTERS = [
  deepseekAmountAdapter,
  deepseekCostAdapter,
  genericCsvAdapter,
  genericJsonAdapter,
];

export const DATA_EXTENSIONS = ['.csv', '.json', '.txt', '.tsv'];

function extOf(name) {
  const m = /(\.[a-z0-9]+)$/i.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
}

/** 只解析表头（避免为了 sniff 把大文件全量解析一遍）。 */
export function sniffCsvHeaders(text) {
  const src = stripBom(String(text || ''));
  const nl = src.search(/\r?\n/);
  const line = nl < 0 ? src : src.slice(0, nl);
  const delimiter = detectDelimiter(line);
  return line.split(delimiter).map((h) => h.replace(/^"|"$/g, '').trim());
}

/** 按内容挑选适配器。返回 null 表示不支持。 */
export function resolveAdapter({ name, text }) {
  const ext = extOf(name);
  const trimmed = String(text || '').trimStart();

  if (ext === '.json' || trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return genericJsonAdapter;
  }

  const headers = sniffCsvHeaders(text);
  for (const adapter of ADAPTERS) {
    if (adapter.id === 'generic-csv' || adapter.id === 'generic-json') continue;
    if (adapter.match(headers)) return adapter;
  }
  if (ext === '.csv' || ext === '.tsv' || ext === '.txt' || headers.length > 1) {
    return genericCsvAdapter;
  }
  return null;
}

/**
 * 把上传的文件展开成可解析的文本条目：
 *  - ZIP → 内部所有 .csv/.json
 *  - 单个 CSV/JSON → 自身
 * @param {{ name: string, buffer: Buffer }[]} files
 * @returns {{ name: string, text: string, bytes: number }[]}
 */
export function expandFiles(files) {
  const out = [];
  for (const file of files) {
    const name = String(file.name || 'unnamed');
    if (looksLikeZip(file.buffer)) {
      const entries = readZip(file.buffer);
      for (const entry of entries) {
        if (!DATA_EXTENSIONS.includes(extOf(entry.name))) continue;
        out.push({ name: entry.name, text: entry.data.toString('utf8'), bytes: entry.data.length, from: name });
      }
      continue;
    }
    const ext = extOf(name);
    if (ext && !DATA_EXTENSIONS.includes(ext)) {
      // 未知扩展名也尝试按文本解析（很多导出工具用 .txt）
      if (ext !== '') continue;
    }
    out.push({ name, text: file.buffer.toString('utf8'), bytes: file.buffer.length });
  }
  return out;
}
