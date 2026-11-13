/**
 * 生成“重叠账期”测试用 ZIP：test/overlap.zip
 *   amount-2026-08.csv（全量）
 *   amount-overlap-08.csv（只含 8/1、8/2 两天，模拟时间范围相交的第二次导出）
 *   cost-2026-08.csv（全量账单）
 * 以及对照用的 test/baseline.zip（amount + cost）。
 *
 * 只用于验证“拖入重叠文件自动去重”，ZIP 采用 store(0) 方式，无压缩。
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, '.tmp', 'fixtures');

/** 极简 ZIP 写入（deflate，method 8）。 */
function makeZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    const crc = crc32(raw);
    const comp = deflateRawSync(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, comp);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt16LE(0, 12);
    dir.writeUInt16LE(0, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(comp.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt16LE(0, 30);
    dir.writeUInt16LE(0, 32);
    dir.writeUInt16LE(0, 34);
    dir.writeUInt16LE(0, 36);
    dir.writeUInt32LE(0, 38);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBuf);

    offset += local.length + nameBuf.length + comp.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, centralBuf, eocd]);
}

let table = null;
function crc32(buf) {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const amount = await readFile(path.join(fixtures, 'amount-2026-08.csv'), 'utf8');
const cost = await readFile(path.join(fixtures, 'cost-2026-08.csv'), 'utf8');
const lines = amount.split('\n');
const overlap = lines.filter((line, i) => i === 0 || /2026-08-0[12]T/.test(line)).join('\n');

await writeFile(path.join(here, 'baseline.zip'), makeZip([
  { name: 'amount-2026-08.csv', data: amount },
  { name: 'cost-2026-08.csv', data: cost },
]));
await writeFile(path.join(here, 'overlap.zip'), makeZip([
  { name: 'amount-2026-08.csv', data: amount },
  { name: 'amount-overlap-08.csv', data: overlap },
  { name: 'cost-2026-08.csv', data: cost },
]));
console.log('wrote test/baseline.zip 与 test/overlap.zip（重叠文件行数：', overlap.split('\n').length - 1, '）');
