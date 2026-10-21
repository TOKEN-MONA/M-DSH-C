import fs from 'node:fs';
import path from 'node:path';
import { listZip, readEntry } from './zip.js';

/** 读 jar 里的元数据，拿模组真名（拿不到就返回空） */
const metaCache = new Map();

function parseToml(txt) {
  const modId = /^\s*modId\s*=\s*["']([^"']+)["']/m.exec(txt);
  const ver = /^\s*version\s*=\s*["']([^"']+)["']/m.exec(txt);
  const disp = /^\s*displayName\s*=\s*["']([^"']+)["']/m.exec(txt);
  return { id: modId && modId[1], version: ver && ver[1], name: (disp && disp[1]) || (modId && modId[1]) };
}

export function readModMeta(jarPath) {
  let st;
  try {
    st = fs.statSync(jarPath);
  } catch {
    return {};
  }
  const key = `${jarPath}|${st.size}|${st.mtimeMs}`;
  if (metaCache.has(key)) return metaCache.get(key);

  let out = {};
  try {
    const buf = fs.readFileSync(jarPath);
    const entries = listZip(buf);
    const find = (n) => entries.find((e) => e.name === n);

    const f = find('fabric.mod.json');
    if (f) {
      const j = JSON.parse(readEntry(buf, f).toString('utf8'));
      out = { name: j.name || j.id, id: j.id, version: j.version, loader: 'fabric' };
    } else {
      for (const tn of ['META-INF/neoforge.mods.toml', 'META-INF/mods.toml']) {
        const t = find(tn);
        if (!t) continue;
        out = { ...parseToml(readEntry(buf, t).toString('utf8')), loader: tn.includes('neoforge') ? 'neoforge' : 'forge' };
        break;
      }
      if (!out.name) {
        const mf = find('META-INF/MANIFEST.MF');
        if (mf) {
          const txt = readEntry(buf, mf).toString('utf8');
          const t = /Implementation-Title:\s*(.+)/i.exec(txt);
          const v = /Implementation-Version:\s*(.+)/i.exec(txt);
          out = { name: t ? t[1].trim() : null, version: v ? v[1].trim() : null };
        }
      }
    }
  } catch {
    out = {};
  }

  if (metaCache.size > 4000) metaCache.clear();
  metaCache.set(key, out);
  return out;
}

export function modsDirOf(gameDir) {
  return path.join(gameDir, 'mods');
}

export function listMods(gameDir) {
  const dir = path.join(gameDir, 'mods');
  if (!fs.existsSync(dir)) return { dir, exists: false, mods: [] };

  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isFile()) continue;
    const name = ent.name;
    if (!/\.jar(\.disabled)?$/i.test(name)) continue;
    const full = path.join(dir, name);
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    const enabled = !/\.disabled$/i.test(name);
    const meta = readModMeta(full);
    out.push({
      file: name,
      size: st.size,
      mtime: st.mtimeMs,
      enabled,
      name: meta.name || name.replace(/\.jar(\.disabled)?$/i, ''),
      id: meta.id || '',
      version: meta.version || '',
      loader: meta.loader || '',
    });
  }
  out.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh-CN'));
  return { dir, exists: true, mods: out };
}

function safeFile(dir, file) {
  const full = path.resolve(dir, file);
  if (path.dirname(full) !== path.resolve(dir)) throw new Error('非法文件名');
  return full;
}

export function setModEnabled(gameDir, file, enabled) {
  const dir = path.join(gameDir, 'mods');
  const src = safeFile(dir, file);
  if (!fs.existsSync(src)) throw new Error('文件不存在');

  const isDisabled = /\.disabled$/i.test(file);
  let target;
  if (enabled && isDisabled) target = src.replace(/\.disabled$/i, '');
  else if (!enabled && !isDisabled) target = `${src}.disabled`;
  else return { file };

  fs.renameSync(src, target);
  return { file: path.basename(target) };
}

export function deleteMod(gameDir, file) {
  const dir = path.join(gameDir, 'mods');
  const full = safeFile(dir, file);
  if (!fs.existsSync(full)) throw new Error('文件不存在');
  fs.rmSync(full, { force: true });
  return true;
}
