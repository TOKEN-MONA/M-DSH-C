import fs from 'node:fs';
import path from 'node:path';
import { dirs, ensureDir } from './paths.js';
import { download, pool } from './http.js';
import { listZip, readEntry } from './zip.js';
import { readVersionJson, writeVersionJson, versionDir, jsonPath } from './version.js';
import { installVersion, installFabric } from './install.js';
import { installLoader } from './forge.js';
import { setVersionMeta, getSettings } from './store.js';
import { versions as mrVersions, primaryFile } from './modrinth.js';
import { fileInfo as cfFileInfo } from './curseforge.js';
import * as tasks from './tasks.js';

function safeName(name) {
  return (
    String(name)
      .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60) || '整合包'
  );
}

function uniqueId(base) {
  const root = dirs().versions;
  let id = base;
  let n = 2;
  while (fs.existsSync(path.join(root, id))) id = `${base} (${n++})`;
  return id;
}

function extractPrefix(buf, prefix, destDir) {
  const entries = listZip(buf);
  const p = prefix.endsWith('/') ? prefix : `${prefix}/`;
  const rootAbs = path.resolve(destDir);
  let n = 0;
  for (const e of entries) {
    if (e.isDir || !e.name.startsWith(p)) continue;
    const rel = e.name.slice(p.length);
    if (!rel || rel.startsWith('..')) continue;
    const out = path.resolve(destDir, rel);
    if (!out.startsWith(rootAbs + path.sep)) continue;
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, readEntry(buf, e));
    n++;
  }
  return n;
}

export function readIndexFromMrpack(buf) {
  const entries = listZip(buf);
  const entry = entries.find((e) => e.name === 'modrinth.index.json');
  if (!entry) throw new Error('这个文件里没有 modrinth.index.json，不是 Modrinth 整合包（.mrpack）');
  return JSON.parse(readEntry(buf, entry).toString('utf8'));
}

/**
 * 核心流程：从内存里的 .mrpack 内容装成一个独立实例。
 * 下载得到的和本地导入的走同一条路。
 */
async function installFromBuffer(buf, meta, task) {
  const log = (l) => tasks.log(task, l);
  const index = readIndexFromMrpack(buf);
  const deps = index.dependencies || {};
  const mcVersion = deps.minecraft || (meta.gameVersions && meta.gameVersions[0]);
  if (!mcVersion) throw new Error('整合包里没写 Minecraft 版本');
  log(`Minecraft ${mcVersion}，依赖：${JSON.stringify(deps)}`);

  // 1. 基础版本
  tasks.patch(task, { stage: `准备基础版本 ${mcVersion}` });
  if (!fs.existsSync(jsonPath(mcVersion))) {
    log(`先安装原版 ${mcVersion}`);
    await installVersion(mcVersion, task);
  }

  // 2. 加载器
  let baseId = mcVersion;
  if (deps['fabric-loader']) {
    const loaderId = `fabric-loader-${deps['fabric-loader']}-${mcVersion}`;
    tasks.patch(task, { stage: `准备 Fabric ${deps['fabric-loader']}` });
    if (!fs.existsSync(jsonPath(loaderId))) {
      const r = await installFabric(mcVersion, task, deps['fabric-loader']);
      baseId = r.id;
    } else {
      baseId = loaderId;
    }
  } else if (deps.neoforge) {
    tasks.patch(task, { stage: `准备 NeoForge ${deps.neoforge}` });
    baseId = await installLoader(mcVersion, 'neoforge', deps.neoforge, task);
  } else if (deps.forge) {
    tasks.patch(task, { stage: `准备 Forge ${deps.forge}` });
    baseId = await installLoader(mcVersion, 'forge', deps.forge, task);
  } else if (deps['quilt-loader']) {
    throw new Error('Quilt 整合包暂不支持');
  }

  // 3. 建独立实例
  const name = uniqueId(safeName(meta.title || index.name || '整合包'));
  // 实例 json 保持最小：只继承加载器版本，不复制它的 libraries/arguments。
  // 复制会导致父子参数被拼两遍（launchTarget 重复 → joptsimple 直接报错），
  // 而且会带上 jar 字段引发 "Modules minecraft and _1._21._1" 冲突。
  const instJson = { id: name, inheritsFrom: baseId, type: 'release' };
  writeVersionJson(name, instJson);
  const gameDir = versionDir(name);
  ensureDir(gameDir);
  log(`创建实例：${name} → ${gameDir}`);

  // 4. 覆盖文件
  tasks.patch(task, { stage: '解压覆盖文件（overrides）' });
  let ov = 0;
  for (const prefix of ['overrides', 'client-overrides']) ov += extractPrefix(buf, prefix, gameDir);
  log(`覆盖文件 ${ov} 个`);

  // 5. 文件清单
  const files = (index.files || []).filter((f) => !(f.env && f.env.client === 'unsupported'));
  tasks.patch(task, { stage: `下载整合包文件（${files.length} 个）`, total: files.length, done: 0 });
  let done = 0;
  let bytes = 0;
  // 并发跟随设置（默认 16，最多 32）：原来写死 8，装大包比 PCL 慢一截
  const threads = Math.min(32, Math.max(8, Number(getSettings().downloadThreads) || 16));
  const errors = await pool(files, threads, async (f) => {
    const url = (f.downloads && f.downloads[0]) || null;
    if (!url) {
      // 作者没给直链（常见于 CurseForge 禁止第三方分发），跳过但计入进度
      done++;
      tasks.patch(task, { done });
      return;
    }
    const dest = path.join(gameDir, f.path);
    await download(url, dest, { sha1: f.hashes && f.hashes.sha1, size: f.fileSize, timeout: 300000 });
    done++;
    bytes += f.fileSize || 0;
    tasks.patch(task, { done, speed: bytes });
  });
  if (errors.length) {
    log(`有 ${errors.length} 个文件下载失败，例如 ${errors[0].item.path}：${errors[0].error.message}`);
    log('（CurseForge 直链在国内经常 403，可以挂代理后重装）');
  }

  const loaderKind = deps['fabric-loader']
    ? 'fabric'
    : deps.neoforge
      ? 'neoforge'
      : deps.forge
        ? 'forge'
        : 'vanilla';

  setVersionMeta(name, {
    type: 'modpack',
    loader: loaderKind,
    loaderVersion: deps['fabric-loader'] || deps.neoforge || deps.forge || '',
    mcVersion,
    isolated: true,
    packProjectId: meta.projectId || null,
    packVersionId: meta.packVersionId || null,
    description: meta.description || index.summary || '',
    installedAt: Date.now(),
    baseVersion: baseId,
  });

  tasks.patch(task, { done: 100 });
  return { id: name, gameDir, failed: errors.length };
}

/** 从 Modrinth 在线安装 */
export async function installMrpack(pack, task) {
  const log = (l) => tasks.log(task, l);

  tasks.patch(task, { stage: '获取整合包信息', total: 100, done: 1 });
  const list = await mrVersions(pack.projectId);
  const ver = pack.versionId ? list.find((v) => v.id === pack.versionId) : list.find((v) => v.type === 'release') || list[0];
  if (!ver) throw new Error('找不到这个整合包的版本');
  const file = primaryFile(ver);
  if (!file) throw new Error('该版本没有可下载文件');

  const cacheDir = ensureDir(path.join(dirs().cache, 'packs'));
  const mrpackPath = path.join(cacheDir, file.filename);
  tasks.patch(task, { stage: `下载整合包 ${file.filename}` });
  log(`下载 ${file.filename}（${(file.size / 1048576).toFixed(1)} MB）`);
  await download(file.url, mrpackPath, { sha1: file.sha1, size: file.size, timeout: 600000 });

  const buf = fs.readFileSync(mrpackPath);
  fs.rmSync(mrpackPath, { force: true });

  return installFromBuffer(
    buf,
    {
      title: pack.title,
      description: pack.description,
      projectId: pack.projectId,
      packVersionId: ver.id,
      gameVersions: ver.gameVersions,
    },
    task
  );
}

/** 从本地 .mrpack 文件安装 */
export async function installMrpackFromFile(filePath, task, titleHint) {
  const buf = fs.readFileSync(filePath);
  const index = readIndexFromMrpack(buf);
  return installFromBuffer(
    buf,
    {
      title: titleHint || index.name || path.basename(filePath).replace(/\.mrpack$/i, ''),
      description: index.summary || '',
      gameVersions: index.dependencies ? [index.dependencies.minecraft] : [],
    },
    task
  );
}

/* ================= CurseForge .zip 整合包 ================= */

/** CurseForge 的 manifest.json：minecraft.version + modLoaders + files[] */
export function readCfManifest(buf) {
  const entries = listZip(buf);
  const entry = entries.find((e) => e.name === 'manifest.json');
  if (!entry) throw new Error('这个压缩包里没有 manifest.json，不是 CurseForge 整合包');
  const man = JSON.parse(readEntry(buf, entry).toString('utf8'));
  if (!man.minecraft || !man.minecraft.version) throw new Error('manifest.json 里没写 Minecraft 版本');
  return man;
}

/** 按扩展名决定放进哪个子目录 */
function dirForFile(filename) {
  const f = String(filename || '').toLowerCase();
  if (f.endsWith('.jar')) return 'mods';
  if (f.endsWith('.zip')) return 'resourcepacks';
  return 'mods';
}

export async function installCurseZipFromFile(filePath, task, titleHint) {
  const log = (l) => tasks.log(task, l);
  const buf = fs.readFileSync(filePath);
  const man = readCfManifest(buf);
  const mcVersion = man.minecraft.version;

  const loaders = man.minecraft.modLoaders || [];
  const primary = ((loaders.find((l) => l.primary) || loaders[0] || {}).id) || '';
  const mm = /^(forge|neoforge|fabric|quilt)-(.+)$/i.exec(primary);
  const kind = mm ? mm[1].toLowerCase() : 'vanilla';
  const lver = mm ? mm[2] : '';

  log(`CurseForge 整合包：${man.name || '(未命名)'} · ${mcVersion} · ${kind}${lver ? ' ' + lver : ''}`);

  tasks.patch(task, { stage: `准备基础版本 ${mcVersion}` });
  if (!fs.existsSync(jsonPath(mcVersion))) {
    log(`先安装原版 ${mcVersion}`);
    await installVersion(mcVersion, task);
  }

  let baseId = mcVersion;
  if (kind === 'fabric') {
    tasks.patch(task, { stage: `准备 Fabric ${lver}` });
    const loaderId = `fabric-loader-${lver}-${mcVersion}`;
    baseId = fs.existsSync(jsonPath(loaderId)) ? loaderId : (await installFabric(mcVersion, task, lver)).id;
  } else if (kind === 'forge') {
    tasks.patch(task, { stage: `准备 Forge ${lver}` });
    baseId = await installLoader(mcVersion, 'forge', lver, task);
  } else if (kind === 'neoforge') {
    tasks.patch(task, { stage: `准备 NeoForge ${lver}` });
    baseId = await installLoader(mcVersion, 'neoforge', lver, task);
  } else if (kind === 'quilt') {
    throw new Error('Quilt 整合包暂不支持');
  }

  const name = uniqueId(safeName(titleHint || man.name || '整合包'));
  // 实例 json 保持最小：只继承加载器版本，不复制它的 libraries/arguments。
  // 复制会导致父子参数被拼两遍（launchTarget 重复 → joptsimple 直接报错），
  // 而且会带上 jar 字段引发 "Modules minecraft and _1._21._1" 冲突。
  const instJson = { id: name, inheritsFrom: baseId, type: 'release' };
  writeVersionJson(name, instJson);
  const gameDir = versionDir(name);
  ensureDir(gameDir);
  log(`创建实例：${name} → ${gameDir}`);

  tasks.patch(task, { stage: '解压覆盖文件（overrides）' });
  const ovDir = man.overrides || 'overrides';
  let ov = extractPrefix(buf, ovDir, gameDir);
  ov += extractPrefix(buf, 'client-overrides', gameDir);
  log(`覆盖文件 ${ov} 个`);

  const files = (man.files || []).filter((f) => f.required !== false);
  tasks.patch(task, { stage: `下载整合包文件（${files.length} 个）`, total: files.length, done: 0 });
  let done = 0;
  const threads = Math.min(32, Math.max(8, Number(getSettings().downloadThreads) || 16));
  const errors = await pool(files, threads, async (f) => {
    const info = await cfFileInfo(f.projectID, f.fileID);
    if (!info.url) throw new Error(`${info.filename} 没有可下载地址`);
    const dest = path.join(gameDir, dirForFile(info.filename), info.filename);
    await download(info.url, dest, { size: info.size, timeout: 300000 });
    done++;
    tasks.patch(task, { done });
  });
  if (errors.length) {
    log(`有 ${errors.length} 个文件没下下来，例如 ${errors[0].item.projectID}/${errors[0].item.fileID}：${errors[0].error.message}`);
    log('（CurseForge 需要 API Key，且直链在国内经常 403；先到「设置」里填 Key，必要时挂代理）');
  }

  setVersionMeta(name, {
    type: 'modpack',
    loader: kind,
    loaderVersion: lver,
    mcVersion,
    isolated: true,
    description: man.summary || '',
    installedAt: Date.now(),
    baseVersion: baseId,
  });

  tasks.patch(task, { done: 100 });
  return { id: name, gameDir, failed: errors.length };
}

/** 认格式：Modrinth 的 .mrpack 还是 CurseForge 的 .zip */
export function detectPackType(buf) {
  const names = listZip(buf).map((e) => e.name);
  if (names.includes('modrinth.index.json')) return 'mrpack';
  if (names.includes('manifest.json')) return 'curseforge';
  return 'unknown';
}

/** 本地文件导入统一入口 */
export async function installPackFromFile(filePath, task, titleHint) {
  const buf = fs.readFileSync(filePath);
  const t = detectPackType(buf);
  if (t === 'mrpack') return installMrpackFromFile(filePath, task, titleHint);
  if (t === 'curseforge') return installCurseZipFromFile(filePath, task, titleHint);
  throw new Error('认不出这个整合包：既没有 modrinth.index.json，也没有 manifest.json');
}