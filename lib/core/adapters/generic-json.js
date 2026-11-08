/**
 * 通用 JSON 适配器：接受
 *   [ {...}, {...} ]                     直接数组
 *   { data: [...] } / { records } / { rows } / { items } / { usage: [...] }
 *   { "2026-08-02": {...} }               以日期为键的对象映射（值补上 date 字段）
 */
import { toDay } from '../util.js';
import { recordsFromObjects } from './generic.js';

const LIST_KEYS = ['data', 'records', 'rows', 'items', 'usage', 'list', 'result', 'results'];

export const genericJsonAdapter = {
  id: 'generic-json',
  label: '通用 JSON',
  match() {
    return false;
  },
  parse(text, meta = {}) {
    let doc;
    try {
      doc = JSON.parse(text);
    } catch (err) {
      throw new Error(`JSON 解析失败：${err.message}`);
    }

    let rows = [];
    if (Array.isArray(doc)) {
      rows = doc;
    } else if (doc && typeof doc === 'object') {
      for (const key of LIST_KEYS) {
        if (Array.isArray(doc[key])) { rows = doc[key]; break; }
      }
      if (!rows.length) {
        // 以日期为键：{ "2026-08-02": { input_tokens: ... } }
        const mapped = [];
        for (const [key, value] of Object.entries(doc)) {
          if (!toDay(key)) continue;
          if (!value || typeof value !== 'object') continue;
          mapped.push({ date: key, ...value });
        }
        rows = mapped;
      }
    }

    if (!rows.length) throw new Error('JSON 里没有找到可识别的数据数组（期望数组或 { data: [...] }）');
    return recordsFromObjects(rows, { sourceName: meta.fileName || '通用 JSON' });
  },
};
