/**
 * 通用 CSV 适配器：除 DeepSeek 官方格式外的任意 CSV。
 * 只要能对上“日期 + token 列”就可用，列名通过别名表宽松匹配。
 */
import { csvRecords } from '../csv.js';
import { buildAliasIndex, recordsFromObjects } from './generic.js';

export const genericCsvAdapter = {
  id: 'generic-csv',
  label: '通用 CSV',
  /** 通用适配器永远兜底，不做 header 匹配。 */
  match() {
    return false;
  },
  parse(text, meta = {}) {
    const { headers, records } = csvRecords(text);
    if (!headers.length) throw new Error('CSV 为空');
    const index = buildAliasIndex(headers);
    if (index.date === undefined) {
      throw new Error(`CSV 缺少日期列，现有列：${headers.join(', ')}`);
    }
    return recordsFromObjects(records, { sourceName: meta.fileName || '通用 CSV' });
  },
};
