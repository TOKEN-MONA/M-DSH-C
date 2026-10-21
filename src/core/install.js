import fs from 'node:fs';
import path from 'node:path';
import { dirs, ensureDir } from './paths.js';
import { fetchJson, download, pool } from './http.js';
import { getManifest } from './manifest.js';
import {
  resolveMerged,
  resolveLibraries,
  versionDir,
  jsonPath,
  jarPathFor,
  nativesDir,
  writeVersionJson,
  readVersionJson,
} from './version.js';
import { extractZip } from './zip.js';
import { getSettings, setVersionMeta } from './store.js';
import * as tasks from './tasks.js';

const RES = 'https://resources.download.minecraft.net';

function makeProgress(task) {
  let acc = 0;
  let cur = 0;
  return {
    done: 0,
    begin(label, weight) {
      cur = weight;
      tasks.patch(task, { stage: label, total: 100 });
    },
    frac(f) {
      tasks.patch(task, { done: Math.min(99, Math.round(acc + cur * Math.max(0, Math.min(1, f)))) });
    },
    end() {
      acc += cur;
      cur = 0;
      tasks.patch(task, { done: Math.min(99, Math.round(acc)) });
    },
    whole(p) {
      tasks.patch(task, { done: Math.min(99, Math.round(p)) });
    },
  };
}

export function featuresFor() {
  const s = getSettings();
  return {
    is_demo_user: false,
    has_custom_resolution: false,
    has_quick_plays_support: false,
    is_quick_play_singleplayer: false,
    is_quick_play_multiplayer: false,
    is_quick_play_realms: false,
    __w: s.windowWidth,
    __h: s.windowHeight,
  };
}

/** 下载一份 version json（原样）到 versions/<id>/<id>.json */
export async function fetchVersionJson(id, task) {
  const manifest = await getManifest({ task });
  const entry = manifest.versions.find((v) => v.id === id);
  if (!entry) throw new Error(`官方版本列表里没有 ${id}`);
  tasks.log(task, `获取 ${id} 的版本描述文件`);
  const json = await fetchJson(entry.url);
  json.__manifestType = entry.type;
  writeVersionJson(id, json);
  return json;
}

async function installClientJar(merged, id, p, task) {
  const jarId = merged.__jarId || id;
  const info = merged.downloads && merged.downloads.client;
  if (!info) {
    // 某些整合包版本 json 不带 downloads.client，那就借用基础版本已有的 jar
    const fallback = jarPathFor(jarId);
    if (fs.existsSync(fallback)) {
      tasks.log(task, `复用已有客户端 ${path.basename(fallback)}`);
      return fallback;
    }
    throw new Error(`${id} 缺少客户端 jar 信息，且 ${jarId}.jar 不存在`);
  }
  const dest = jarPathFor(jarId);
  tasks.log(task, `下载客户端核心 ${path.basename(dest)} (${(info.size / 1048576).toFixed(1)} MB)`);
  await download(info.url, dest, {
    sha1: info.sha1,
    size: info.size,
    onData: (n) => {
      p.done += n;
      p.frac(Math.min(1, p.done / Math.max(1, info.size)));
    },
  });
  return dest;
}

async function installLibraries(merged, p, task) {
  const { classpath } = resolveLibraries(merged, featuresFor());
  const root = dirs().libraries;
  let done = 0;
  p.begin(`下载依赖库（${classpath.length} 个）`, 30);
  const errors = await pool(classpath, getSettings().downloadThreads || 16, async (lib) => {
    const dest = path.join(root, lib.path);
    if (fs.existsSync(dest) && lib.size && fs.statSync(dest).size === lib.size) {
      done++;
      return;
    }
    await download(lib.url, dest, { sha1: lib.sha1, size: lib.size });
    done++;
    if (done % 3 === 0 || done === classpath.length) p.frac(done / classpath.length);
  });
  if (errors.length) {
    const e = errors[0];
    throw new Error(`依赖库下载失败 ${errors.length} 个，例如 ${path.basename(e.item.path)}: ${e.error.message}`);
  }
  p.end();
  return classpath;
}

export function extractNatives(versionId, merged) {
  const { natives } = resolveLibraries(merged, featuresFor());
  if (!natives.length) return null;
  const dir = nativesDir(versionId);
  ensureDir(dir);
  for (const n of natives) {
    const jar = path.join(dirs().libraries, n.path);
    if (!fs.existsSync(jar)) continue;
    try {
      extractZip(fs.readFileSync(jar), dir, (name) => !name.startsWith('META-INF/') && !name.endsWith('/'));
    } catch (e) {
      // 个别 jar 是空壳（只有 META-INF），忽略
    }
  }
  return dir;
}

async function installAssets(merged, p, task) {
  const idx = merged.assetIndex;
  if (!idx) {
    tasks.log(task, '该版本没有资源索引，跳过');
    return;
  }
  const indexFile = path.join(dirs().assets, 'indexes', `${idx.id}.json`);
  await download(idx.url, indexFile, { sha1: idx.sha1, size: idx.size });

  const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  const objects = Object.entries(index.objects || {});
  p.begin(`下载资源文件（${objects.length} 个）`, 55);

  const root = path.join(dirs().assets, 'objects');
  let done = 0;
  let bytes = 0;
  const errors = await pool(objects, getSettings().downloadThreads || 16, async ([name, o]) => {
    const sub = o.hash.slice(0, 2);
    const dest = path.join(root, sub, o.hash);
    if (!(fs.existsSync(dest) && fs.statSync(dest).size === o.size)) {
      await download(`${RES}/${sub}/${o.hash}`, dest, { size: o.size });
    }
    done++;
    bytes += o.size;
    if (done % 50 === 0 || done === objects.length) {
      p.frac(done / Math.max(1, objects.length));
      tasks.patch(task, { speed: bytes });
    }
  });
  if (errors.length) {
    throw new Error(`资源下载失败 ${errors.length} 个: ${errors[0].error.message}`);
  }
  p.end();

  // 极老版本（1.6 之前）需要把 objects 摊平到 virtual/ 或 resources/
  if (index.virtual || index.map_to_resources) {
    p.begin('整理旧版资源目录', 3);
    const flat = index.map_to_resources
      ? path.join(dirs().mc, 'resources')
      : path.join(dirs().assets, 'virtual', idx.id);
    ensureDir(flat);
    let n = 0;
    for (const [name, o] of objects) {
      const src = path.join(root, o.hash.slice(0, 2), o.hash);
      const dst = path.join(flat, name);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      if (!fs.existsSync(dst) || fs.statSync(dst).size !== o.size) fs.copyFileSync(src, dst);
      n++;
      if (n % 200 === 0) p.frac(n / objects.length);
    }
    p.end();
  }
}

async function installLogging(merged, task) {
  const lg = merged.logging && merged.logging.client;
  if (!lg || !lg.file) return null;
  const dest = path.join(dirs().assets, 'log_configs', lg.file.id);
  await download(lg.file.url, dest, { sha1: lg.file.sha1, size: lg.file.size });
  return dest;
}

/**
 * 安装一个版本（原版可用；整合包用 importVersion 直接放 json 后调用 finalize）
 */
export async function installVersion(versionId, task, opts = {}) {
  const p = makeProgress(task);
  p.begin('获取版本信息', 2);
  const raw = await fetchVersionJson(versionId, task);
  p.end();

  const merged = resolveMerged(versionId);
  const major = (merged.javaVersion && merged.javaVersion.majorVersion) || 8;
  const component = (merged.javaVersion && merged.javaVersion.component) || null;
  tasks.log(task, `Minecraft ${versionId}，需要 Java ${major}+，主类 ${merged.mainClass}`);

  p.begin('下载客户端核心', 8);
  await installClientJar(merged, versionId, p, task);
  p.end();

  await installLibraries(merged, p, task);

  p.begin('解压原生库（natives）', 2);
  const nd = extractNatives(versionId, merged);
  tasks.log(task, nd ? `natives → ${nd}` : '该版本无需解压 natives');
  p.end();

  await installAssets(merged, p, task);

  p.begin('下载日志配置', 1);
  await installLogging(merged, task);
  p.end();

  setVersionMeta(versionId, {
    type: raw.__manifestType || raw.type || 'release',
    loader: 'vanilla',
    mcVersion: versionId,
    javaMajor: major,
    javaComponent: component,
    installedAt: Date.now(),
  });

  tasks.patch(task, { done: 100 });
  return merged;
}

/** Fabric 安装：只下一个 profile json + 库，没有jar */
export async function installFabric(mcId, task, loaderVersion = null) {
  const p = makeProgress(task);
  p.begin('查询 Fabric Loader 版本', 3);
  const list = await fetchJson(`https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(mcId)}`);
  if (!Array.isArray(list) || !list.length) throw new Error(`Fabric 不支持 Minecraft ${mcId}`);
  const pick = loaderVersion || (list.find((x) => x.loader && x.loader.stable) || list[0]).loader.version;
  tasks.log(task, `Fabric Loader ${pick}`);
  const profile = await fetchJson(
    `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(mcId)}/${encodeURIComponent(pick)}/profile/json`
  );
  const id = profile.id;
  writeVersionJson(id, profile);
  p.end();

  const merged = resolveMerged(id);
  await installLibraries(merged, p, task);

  p.begin('校验基础版本', 1);
  if (!fs.existsSync(jarPathFor(mcId))) {
    tasks.log(task, `基础版本 ${mcId} 还没装，先装原版`);
    await installVersion(mcId, task);
  }
  p.end();

  setVersionMeta(id, {
    type: 'fabric',
    loader: 'fabric',
    loaderVersion: pick,
    mcVersion: mcId,
    javaMajor: (merged.javaVersion && merged.javaVersion.majorVersion) || 17,
    javaComponent: (merged.javaVersion && merged.javaVersion.component) || null,
    installedAt: Date.now(),
  });
  tasks.patch(task, { done: 100 });
  return { id, loaderVersion: pick };
}

/** 把外部整合包里的版本 json 落地（整合包安装用） */
export function importVersionJson(id, json) {
  writeVersionJson(id, json);
  return id;
}

export function readMergedOrNull(id) {
  try {
    return resolveMerged(id);
  } catch {
    return null;
  }
}
