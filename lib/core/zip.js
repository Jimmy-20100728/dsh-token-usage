/**
 * 最小可用 ZIP 读取器：只做“解包出文件列表”，不写盘、不依赖第三方库。
 *
 * 支持：store(0) / deflate(8) 两种压缩方式（DeepSeek 官方导出 ZIP 用 deflate）。
 * 不支持：加密 ZIP、ZIP64（>4GB / >65535 条），遇到时抛中文错误提示。
 */
import { inflateRawSync } from 'node:zlib';

const SIG_EOCD = 0x06054b50; // End of central directory
const SIG_CD = 0x02014b50; // Central directory file header
const SIG_LFH = 0x04034b50; // Local file header

function findEocd(buf) {
  const min = Math.max(0, buf.length - 0xffff - 22);
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}

/**
 * @param {Buffer} buf 完整 ZIP 字节
 * @returns {{ name: string, data: Buffer, size: number }[]}
 */
export function readZip(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error('不是有效的 ZIP：文件太小');
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('不是有效的 ZIP：找不到中央目录结尾（EOCD）');

  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff) throw new Error('暂不支持 ZIP64 格式');

  const out = [];
  let p = cdOffset;
  for (let i = 0; i < count; i += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CD) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    // 目录名优先用 UTF-8（DeepSeek 导出都是 ASCII 文件名）
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (compSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error('暂不支持 ZIP64 格式');
    }
    if (name.endsWith('/')) continue; // 目录项
    if (/^__MACOSX\//.test(name) || /(^|\/)\._/.test(name)) continue; // macOS 元数据

    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== SIG_LFH) {
      throw new Error(`ZIP 条目损坏：${name}`);
    }
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);

    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = inflateRawSync(raw);
    else throw new Error(`不支持的 ZIP 压缩方式 ${method}（文件：${name}）`);

    out.push({ name, data, size: uncompSize || data.length });
  }
  if (!out.length) throw new Error('ZIP 内没有可读取的文件');
  return out;
}

/** 判断字节流是否 ZIP（PK\x03\x04）。 */
export function looksLikeZip(buf) {
  return Buffer.isBuffer(buf) && buf.length > 4 && buf.readUInt32LE(0) === SIG_LFH;
}
