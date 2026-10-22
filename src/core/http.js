import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const UA = 'MCLauncher/1.0 (personal launcher)';

/**
 * BMCLAPI 镜像。中国网络下官方源经常拿不到，镜像能救急；
 * 失败会自动回落到官方源（见 candidates()）。
 */
const MIRROR_RULES = [
  [/^https:\/\/piston-meta\.mojang\.com/i, 'https://bmclapi2.bangbang93.com'],
  [/^https:\/\/launchermeta\.mojang\.com/i, 'https://bmclapi2.bangbang93.com'],
  [/^https:\/\/launcher\.mojang\.com/i, 'https://bmclapi2.bangbang93.com'],
  [/^https:\/\/resources\.download\.minecraft\.net/i, 'https://bmclapi2.bangbang93.com/assets'],
  [/^https:\/\/libraries\.minecraft\.net/i, 'https://bmclapi2.bangbang93.com/maven'],
  [/^https:\/\/files\.minecraftforge\.net/i, 'https://bmclapi2.bangbang93.com/maven'],
  [/^https:\/\/maven\.minecraftforge\.net/i, 'https://bmclapi2.bangbang93.com/maven'],
  [/^https:\/\/maven\.fabricmc\.net/i, 'https://bmclapi2.bangbang93.com/maven'],
  [/^https:\/\/maven\.neoforged\.net\/releases/i, 'https://bmclapi2.bangbang93.com/maven'],
  [/^https:\/\/maven\.neoforged\.net/i, 'https://bmclapi2.bangbang93.com/maven'],
  [/^https:\/\/meta\.fabricmc\.net/i, 'https://bmclapi2.bangbang93.com/fabric-meta'],
  [/^https:\/\/maven\.quiltmc\.org/i, 'https://bmclapi2.bangbang93.com/maven'],
];

let source = 'auto';
let mirrorBroken = false;

export function setSource(s) {
  source = s || 'auto';
  mirrorBroken = false;
}

export function mirrorOf(url) {
  for (const [re, base] of MIRROR_RULES) {
    if (re.test(url)) return url.replace(re, base);
  }
  return null;
}

export function candidates(url) {
  const m = mirrorOf(url);
  if (!m) return [url];
  if (source === 'official') return [url];
  if (source === 'mirror') return mirrorBroken ? [m, url] : [m, url];
  // auto：官方先试一次，失败后本进程内永久切镜像
  return mirrorBroken ? [m, url] : [url, m];
}

export function markBroken(useMirror) {
  if (useMirror) mirrorBroken = true;
}

function isMirror(url) {
  return url.includes('bmclapi');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function fetchRaw(url, { timeout = 30000, headers = {}, retries = 2 } = {}) {
  const list = candidates(url);
  let lastErr;
  for (const target of list) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeout);
      try {
        const res = await fetch(target, {
          signal: ac.signal,
          headers: { 'User-Agent': UA, ...headers },
        });
        clearTimeout(timer);
        if (!res.ok) {
          const err = new Error(`HTTP ${res.status} ${res.statusText} (${target})`);
          err.status = res.status;
          if (res.status >= 400 && res.status < 500 && res.status !== 429) throw err; // 不重试
          lastErr = err;
          continue;
        }
        return { res, url: target };
      } catch (e) {
        clearTimeout(timer);
        lastErr = e;
        if (isMirror(target) && (e.name === 'AbortError' || /fetch failed|HTTP 5/i.test(e.message))) {
          markBroken(true);
        }
        if (attempt < retries) await sleep(300 * (attempt + 1));
      }
    }
  }
  throw lastErr || new Error(`请求失败: ${url}`);
}

export async function fetchJson(url, opts = {}) {
  const { res } = await fetchRaw(url, opts);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`返回的不是 JSON: ${url}`);
  }
}

export async function fetchText(url, opts = {}) {
  const { res } = await fetchRaw(url, opts);
  return res.text();
}

function sha1File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha1');
    const s = fs.createReadStream(file);
    s.on('data', (d) => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

/** 给 Promise 加超时；超时后清理计时器（避免长期挂死） */
function raceTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * 下载并校验。已存在且校验通过则直接跳过（这是秒装/续传的关键）。
 * stall：多久收不到数据就判定连接假死（不是总时长，大文件慢速下载不受影响）
 */
export async function download(url, dest, { sha1, size, timeout = 60000, stall = 45000, retries = 2, onData } = {}) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  try {
    const st = fs.statSync(dest);
    if (size && st.size === size) {
      if (!sha1) return { skipped: true };
      if ((await sha1File(dest)) === sha1.toLowerCase()) return { skipped: true };
    }
  } catch {
    /* 不存在 */
  }

  const list = candidates(url);
  let lastErr;

  for (const target of list) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      const tmp = `${dest}.part`;
      const hasher = sha1 ? crypto.createHash('sha1') : null;
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeout);
      try {
        const res = await fetch(target, { signal: ac.signal, headers: { 'User-Agent': UA } });
        if (!res.ok) throw new Error(`HTTP ${res.status} (${target})`);
        await new Promise(async (resolve, reject) => {
          const ws = fs.createWriteStream(tmp);
          let settled = false;
          const fail = (e) => {
            if (settled) return;
            settled = true;
            try {
              ws.destroy();
            } catch {
              /* ignore */
            }
            reject(e);
          };
          ws.on('error', fail);
          ws.on('finish', () => {
            if (settled) return;
            settled = true;
            resolve();
          });
          try {
            const reader = res.body.getReader();
            for (;;) {
              let chunk;
              try {
                // 每次等数据都有独立超时：连接假死时不会永远挂在这里
                chunk = await raceTimeout(reader.read(), stall, `超过 ${Math.round(stall / 1000)} 秒没有收到数据`);
              } catch (e) {
                try {
                  ac.abort();
                } catch {
                  /* ignore */
                }
                throw e;
              }
              if (chunk.done) break;
              if (hasher) hasher.update(Buffer.from(chunk.value));
              if (onData) onData(chunk.value.length);
              if (!ws.write(Buffer.from(chunk.value))) {
                await new Promise((r) => ws.once('drain', r));
              }
            }
            ws.end();
          } catch (e) {
            fail(e);
          }
        });
        clearTimeout(timer);

        if (sha1) {
          const got = hasher.digest('hex');
          if (got !== sha1.toLowerCase()) throw new Error(`SHA1 校验失败 (${target})`);
        } else if (size) {
          const st = fs.statSync(tmp);
          if (st.size !== size) throw new Error(`文件大小不符 ${st.size}/${size}`);
        }
        fs.rmSync(dest, { force: true });
        fs.renameSync(tmp, dest);
        return { ok: true };
      } catch (e) {
        clearTimeout(timer);
        fs.rmSync(`${dest}.part`, { force: true });
        lastErr = e;
        if (isMirror(target) && (e.name === 'AbortError' || /fetch failed|HTTP 5/i.test(e.message))) {
          markBroken(true);
        }
        if (attempt < retries) await sleep(400 * (attempt + 1));
      }
    }
  }
  throw lastErr || new Error(`下载失败: ${url}`);
}

/** 简单并发池：失败项收集起来，最后允许重试一轮 */
export async function pool(items, limit, worker) {
  const queue = items.slice();
  const errors = [];
  let active = 0;
  let index = 0;

  return new Promise((resolve) => {
    const next = () => {
      if (index >= queue.length && active === 0) return resolve(errors);
      while (active < limit && index < queue.length) {
        const item = queue[index++];
        active++;
        Promise.resolve()
          .then(() => worker(item))
          .catch((e) => errors.push({ item, error: e }))
          .finally(() => {
            active--;
            next();
          });
      }
    };
    if (!queue.length) resolve(errors);
    else next();
  });
}
