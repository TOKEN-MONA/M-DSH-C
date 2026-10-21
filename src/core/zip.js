import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/** 找 EOCD（中央目录结束记录） */
function findEocd(buf) {
  const min = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) return i;
  }
  return -1;
}

/**
 * 解析 zip 中央目录。只读需要的字段，够用即可。
 * @returns {{name:string,method:number,crc:number,csize:number,usize:number,dataStart:number,isDir:boolean}[]}
 */
export function listZip(buf) {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('不是有效的 zip 文件（找不到 EOCD）');
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const entries = [];
  let p = cdOffset;

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`zip 中央目录损坏（第 ${i} 项）`);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);

    const rawName = buf.subarray(p + 46, p + 46 + nameLen);
    // 有些打包工具（比如 PowerShell 的 Compress-Archive）写的是反斜杠，
    // 统一成正斜杠，否则做前缀匹配时会对不上
    const name = rawName.toString('utf8').replace(/\\/g, '/');

    const lnameLen = buf.readUInt16LE(localOffset + 26);
    const lextraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lnameLen + lextraLen;

    entries.push({ name, method, crc, csize, usize, dataStart, isDir: name.endsWith('/') });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export function readEntry(buf, e) {
  const raw = buf.subarray(e.dataStart, e.dataStart + e.csize);
  if (e.method === 0) return raw;
  if (e.method === 8) return zlib.inflateRawSync(raw, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
  throw new Error(`不支持的压缩方式 ${e.method}: ${e.name}`);
}

function safeJoin(root, name) {
  const target = path.resolve(root, name);
  if (!target.startsWith(path.resolve(root) + path.sep) && target !== path.resolve(root)) {
    throw new Error(`zip 内路径越界: ${name}`);
  }
  return target;
}

/**
 * 解压到目录。filter(name) 返回 false 则跳过。
 */
export function extractZip(buf, destDir, filter) {
  const entries = listZip(buf);
  let n = 0;
  for (const e of entries) {
    if (e.isDir) continue;
    if (filter && !filter(e.name)) continue;
    const out = safeJoin(destDir, e.name);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, readEntry(buf, e));
    n++;
  }
  return n;
}

export function extractZipFile(zipPath, destDir, filter) {
  const buf = fs.readFileSync(zipPath);
  return extractZip(buf, destDir, filter);
}
