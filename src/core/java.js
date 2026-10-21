import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { dirs, ensureDir } from './paths.js';
import { fetchJson, download, pool } from './http.js';
import * as tasks from './tasks.js';
import { extractZip } from './zip.js';

const RUNTIME_MANIFEST =
  'https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json';

const COMPONENT_BY_MAJOR = {
  8: 'jre-legacy',
  16: 'java-runtime-alpha',
  17: 'java-runtime-gamma',
  21: 'java-runtime-delta',
};

function runJava(exe, args = ['-version'], timeout = 8000) {
  return new Promise((resolve) => {
    execFile(exe, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
      if (err && !stderr && !stdout) return resolve(null);
      resolve(`${stdout || ''}${stderr || ''}`);
    });
  });
}

export function parseMajor(text) {
  const m = /version "([^"]+)"/.exec(text || '');
  if (!m) return 0;
  const v = m[1];
  if (v.startsWith('1.')) return parseInt(v.split('.')[1], 10) || 0;
  return parseInt(v.split('.')[0], 10) || 0;
}

export function javaExeInDir(dir) {
  const p = path.join(dir, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
  return fs.existsSync(p) ? p : null;
}

const javaExeIn = javaExeInDir;

function childrenOf(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(dir, d.name));
  } catch {
    return [];
  }
}

function collectCandidates() {
  const out = new Set();
  const env = process.env;
  const push = (p) => {
    if (p && fs.existsSync(p)) out.add(p);
  };

  // 我们自己下载的
  const jroot = dirs().java;
  for (const a of childrenOf(jroot)) {
    push(javaExeIn(a));
    for (const b of childrenOf(a)) push(javaExeIn(b));
  }

  if (env.JAVA_HOME) push(javaExeIn(env.JAVA_HOME));

  const roots = [
    'C:\\Program Files\\Java',
    'C:\\Program Files (x86)\\Java',
    'C:\\Program Files\\Eclipse Adoptium',
    'C:\\Program Files\\Microsoft',
    'C:\\Program Files\\Zulu',
    'C:\\Program Files\\BellSoft',
    'C:\\Program Files\\Amazon Corretto',
    path.join(env.LOCALAPPDATA || '', 'Programs', 'Eclipse Adoptium'),
    path.join(env.USERPROFILE || '', '.jdks'),
  ];
  for (const r of roots) {
    for (const d of childrenOf(r)) push(javaExeIn(d));
  }

  // 现成 .minecraft 里官方启动器带的
  for (const d of childrenOf(path.join(dirs().mc, 'runtime'))) {
    for (const e of childrenOf(d)) {
      for (const f of childrenOf(e)) push(javaExeIn(f));
    }
  }

  return [...out];
}

let cache = null;

export async function detectJava({ refresh = false } = {}) {
  if (cache && !refresh) return cache;
  const found = [];
  const seen = new Set();

  const check = async (exe) => {
    if (!exe || seen.has(exe)) return;
    seen.add(exe);
    const text = await runJava(exe);
    if (!text) return;
    const major = parseMajor(text);
    if (!major) return;
    const bits = /64-Bit/.test(text) ? 64 : 32;
    const vendor = /(Temurin|Adoptium)/.test(text)
      ? 'Temurin'
      : /Microsoft/.test(text)
        ? 'Microsoft'
        : /Zulu/.test(text)
          ? 'Zulu'
          : /Corretto/.test(text)
            ? 'Corretto'
            : /Oracle/.test(text)
              ? 'Oracle'
              : 'OpenJDK';
    found.push({ path: exe, major, bits, vendor, raw: text.split('\n')[0].trim() });
  };

  for (const c of collectCandidates()) await check(c);

  // PATH 里的
  let where = '';
  try {
    where = await new Promise((resolve) => {
      try {
        execFile('where', ['java'], { windowsHide: true }, (e, so) => resolve(e ? '' : so || ''));
      } catch {
        resolve('');
      }
    });
  } catch {
    where = '';
  }
  for (const line of where.split(/\r?\n/)) if (line.trim()) await check(line.trim());

  found.sort((a, b) => b.major - a.major);
  cache = found;
  return found;
}

export async function pickJava(major, customPath) {
  if (customPath && fs.existsSync(customPath)) {
    const text = await runJava(customPath);
    return { path: customPath, major: parseMajor(text), custom: true };
  }
  const list = await detectJava();
  if (!list.length) return null;
  const need = major || 21;
  const exact = list.filter((j) => j.major >= need).sort((a, b) => a.major - b.major);
  return exact[0] || list[0];
}

/** 从 Mojang 官方运行时清单安装（和官方启动器同一来源，兼容性最好） */
async function installFromMojang(major, component, task) {
  const plat = 'windows-x64';
  const manifest = await fetchJson(RUNTIME_MANIFEST);
  const table = manifest[plat] || {};
  const name = component || COMPONENT_BY_MAJOR[major];
  const entries = table[name];
  if (!entries || !entries.length) throw new Error(`Mojang 运行时里没有 ${name}`);

  const info = entries[0];
  const meta = await fetchJson(info.manifest.url);
  const target = path.join(dirs().java, `${name}-${info.version.name}`);
  if (javaExeIn(target)) {
    tasks.log(task, `已存在 ${name}，跳过下载`);
    return target;
  }

  const files = [];
  for (const [rel, f] of Object.entries(meta.files || {})) {
    if (f.type !== 'file') continue;
    const raw = f.downloads && f.downloads.raw;
    if (!raw) continue;
    files.push({ rel, url: raw.url, sha1: raw.sha1, size: raw.size });
  }

  tasks.log(task, `下载 Java ${info.version.name}（${files.length} 个文件）`);
  let done = 0;
  tasks.patch(task, { total: files.length, done: 0 });
  ensureDir(target);

  const errors = await pool(files, 12, async (f) => {
    await download(f.url, path.join(target, f.rel), { sha1: f.sha1, size: f.size });
    done++;
    tasks.patch(task, { done });
  });
  if (errors.length) throw new Error(`Java 文件下载失败 ${errors.length} 个：${errors[0].error.message}`);

  if (!javaExeIn(target)) throw new Error('Java 解压后找不到 bin/java.exe');
  return target;
}

/** 备用：Adoptium 的 JRE zip */
async function installFromAdoptium(major, task) {
  const url = `https://api.adoptium.net/v3/binary/latest/${major}/ga/windows/x64/jre/hotspot/normal/eclipse`;
  tasks.log(task, `改从 Adoptium 下载 JRE ${major}`);
  ensureDir(dirs().java);
  const zipPath = path.join(dirs().java, `adoptium-${major}.zip`);
  await download(url, zipPath, {
    timeout: 300000,
    onData: (n) => {
      task.done = (task.done || 0) + n;
      tasks.patch(task, { done: task.done });
    },
  });
  const dest = path.join(dirs().java, `adoptium-${major}`);
  ensureDir(dest);
  extractZip(fs.readFileSync(zipPath), dest);
  fs.rmSync(zipPath, { force: true });
  for (const a of childrenOf(dest)) {
    if (javaExeIn(a)) return a;
  }
  throw new Error('Adoptium 解压后找不到 bin/java.exe');
}

export async function installJava(major, component, task) {
  const problems = [];
  try {
    const dir = await installFromMojang(major, component, task);
    cache = null;
    return dir;
  } catch (e) {
    problems.push(e.message);
    tasks.log(task, `Mojang 运行时失败：${e.message}`);
  }
  try {
    const dir = await installFromAdoptium(major, task);
    cache = null;
    return dir;
  } catch (e) {
    problems.push(e.message);
  }
  throw new Error(`Java ${major} 自动安装失败：${problems.join(' / ')}`);
}

export function javaMajorFor(versionJson) {
  return (versionJson.javaVersion && versionJson.javaVersion.majorVersion) || 8;
}

export function javaComponentFor(versionJson) {
  return (versionJson.javaVersion && versionJson.javaVersion.component) || null;
}
