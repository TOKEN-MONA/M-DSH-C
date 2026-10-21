import fs from 'node:fs';
import path from 'node:path';
import { dirs, APP_ROOT } from './paths.js';

/**
 * 中文名 → 英文名 对照表。
 * 分两层：
 *   seed   随程序分发的内置表（src/data/cn-en.seed.json）
 *   user   运行时自动长出来的（.data/cn-en.json），每次中文搜索命中 MC百科 就补进去
 * 合并后按 cn 精确 / 包含 匹配。
 */

const SEED_FILE = path.join(APP_ROOT, 'src', 'data', 'cn-en.seed.json');

let seed = null;
let user = null;
let dirty = false;
let flushTimer = null;
let version = 0;
let revCache = null;
let revVersion = -1;

function userFile() {
  return path.join(dirs().data, 'cn-en.json');
}

function loadSeed() {
  if (seed) return seed;
  try {
    seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
  } catch {
    seed = {};
  }
  if (typeof seed !== 'object' || Array.isArray(seed)) seed = {};
  return seed;
}

function loadUser() {
  if (user) return user;
  try {
    user = JSON.parse(fs.readFileSync(userFile(), 'utf8'));
  } catch {
    user = {};
  }
  if (typeof user !== 'object' || Array.isArray(user)) user = {};
  return user;
}

function flush() {
  if (!dirty) return;
  dirty = false;
  try {
    fs.mkdirSync(dirs().data, { recursive: true });
    fs.writeFileSync(userFile(), JSON.stringify(user || {}), 'utf8');
  } catch {
    /* 写不进去就算了，下次再试 */
  }
}

export function hasCJK(text) {
  return /[\u3400-\u4dbf\u4e00-\u9fff]/.test(String(text || ''));
}

export function add(cn, en) {
  const key = String(cn || '').trim();
  const val = String(en || '').trim();
  if (!key || !val) return false;
  if (!hasCJK(key)) return false;
  const u = loadUser();
  if (u[key] === val) return false;
  // 内置表里已经有的不改，免得越用越乱
  if (loadSeed()[key] === val) return false;
  u[key] = val;
  version++;
  dirty = true;
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, 1500);
  if (flushTimer.unref) flushTimer.unref();
  return true;
}

export function stats() {
  return { seed: Object.keys(loadSeed()).length, user: Object.keys(loadUser()).length };
}

/**
 * 反向查：给一个英文标题，找出对应的中文名。
 * 只做「完全相同」匹配（忽略大小写），避免把 Create 的附属模组全标成「机械动力」。
 */
export function revLookup(title) {
  const key = String(title || '')
    .trim()
    .toLowerCase();
  if (!key) return '';

  if (!revCache || revVersion !== version) {
    const table = { ...loadSeed(), ...loadUser() };
    revCache = new Map();
    for (const cn of Object.keys(table)) {
      const en = String(table[cn] || '')
        .trim()
        .toLowerCase();
      if (!en) continue;
      // 同一个英文名有多个中文名时，取最短的那个（一般是主名称）
      const old = revCache.get(en);
      if (!old || cn.length < old.length) revCache.set(en, cn);
    }
    revVersion = version;
  }

  return revCache.get(key) || '';
}

export function isExact(query) {
  const k = String(query || '').trim();
  if (!k) return false;
  return Boolean(loadSeed()[k] || loadUser()[k]);
}

/** 返回 [{cn, en, score}]，最多 5 条 */
export function lookup(query) {
  const key = String(query || '').trim();
  if (!key) return [];

  const table = { ...loadSeed(), ...loadUser() };
  const out = [];
  const seen = new Set();

  if (table[key]) {
    out.push({ cn: key, en: table[key], score: 100 });
    seen.add(key);
  }

  for (const cn of Object.keys(table)) {
    if (seen.has(cn)) continue;
    if (!cn.includes(key) && !key.includes(cn)) continue;
    const score = (Math.min(cn.length, key.length) / Math.max(cn.length, key.length)) * 60;
    out.push({ cn, en: table[cn], score });
  }

  out.sort((a, b) => b.score - a.score || a.cn.length - b.cn.length);
  return out.slice(0, 5);
}
