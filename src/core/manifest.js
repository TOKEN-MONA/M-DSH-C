import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fetchJson } from './http.js';
import { dirs, ensureDir } from './paths.js';

const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const TTL = 20 * 60 * 1000;

let memo = null;

function cacheFile() {
  return path.join(dirs().cache, 'version_manifest_v2.json');
}

export async function getManifest({ force = false, task } = {}) {
  if (memo && !force && Date.now() - memo.at < TTL) return memo.data;

  const file = cacheFile();
  if (!force) {
    try {
      const st = fs.statSync(file);
      if (Date.now() - st.mtimeMs < TTL) {
        memo = { at: Date.now(), data: JSON.parse(fs.readFileSync(file, 'utf8')) };
        return memo.data;
      }
    } catch {
      /* 无缓存 */
    }
  }

  // 注意：task.stage 是字符串字段，不是方法。这里只更新它，真正的进度广播由调用方负责。
  if (task) task.stage = '获取版本列表';
  try {
    const data = await fetchJson(MANIFEST_URL);
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify(data), 'utf8');
    memo = { at: Date.now(), data };
    return data;
  } catch (e) {
    // 网络挂了就用旧缓存硬顶
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      memo = { at: Date.now(), data };
      return data;
    } catch {
      throw e;
    }
  }
}

export function platform() {
  const arch = os.arch(); // x64 | arm64 | ia32
  return { name: os.platform() === 'win32' ? 'windows' : os.platform(), arch, version: os.release() };
}
