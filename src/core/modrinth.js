import path from 'node:path';
import fs from 'node:fs';
import { download } from './http.js';
import { ensureDir } from './paths.js';

const BASE = 'https://api.modrinth.com/v2';
const UA = 'MCLauncher/1.0 (personal use)';

async function api(pathname) {
  const res = await fetch(BASE + pathname, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) {
    const err = new Error(`Modrinth 接口 ${res.status}：${pathname}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/**
 * @param {{query?:string,type?:'mod'|'modpack'|'resourcepack'|'shader'|'datapack',gameVersion?:string,loader?:string,limit?:number,offset?:number,index?:string}} o
 */
export async function search(o = {}) {
  const facets = [];
  if (o.type) facets.push([`project_type:${o.type}`]);
  if (o.gameVersion) facets.push([`versions:${o.gameVersion}`]);
  if (o.loader) facets.push([`categories:${o.loader}`]);

  const q = new URLSearchParams();
  q.set('query', o.query || '');
  q.set('limit', String(o.limit || 20));
  q.set('offset', String(o.offset || 0));
  q.set('index', o.index || 'relevance');
  if (facets.length) q.set('facets', JSON.stringify(facets));

  const data = await api(`/search?${q.toString()}`);
  return {
    total: data.total_hits,
    hits: (data.hits || []).map((h) => ({
      id: h.project_id,
      slug: h.slug,
      title: h.title,
      description: h.description,
      icon: h.icon_url,
      downloads: h.downloads,
      follows: h.follows,
      author: h.author,
      categories: h.display_categories || h.categories || [],
      versions: h.versions || [],
      latestVersion: h.latest_version,
    })),
  };
}

export async function versions(projectId, { gameVersion, loader } = {}) {
  const q = new URLSearchParams();
  if (gameVersion) q.set('game_versions', JSON.stringify([gameVersion]));
  if (loader) q.set('loaders', JSON.stringify([loader]));
  const list = await api(`/project/${encodeURIComponent(projectId)}/version?${q.toString()}`);
  return (list || []).map((v) => ({
    id: v.id,
    name: v.name,
    versionNumber: v.version_number,
    type: v.version_type,
    gameVersions: v.game_versions,
    loaders: v.loaders,
    datePublished: v.date_published,
    downloads: v.downloads,
    files: (v.files || []).map((f) => ({
      url: f.url,
      filename: f.filename,
      size: f.size,
      primary: f.primary,
      sha1: f.hashes && f.hashes.sha1,
    })),
    dependencies: v.dependencies || [],
  }));
}

export async function project(id) {
  return api(`/project/${encodeURIComponent(id)}`);
}

/** 批量取项目信息（用于展示前置资源） */
export async function projects(ids) {
  const uniq = [...new Set((ids || []).filter(Boolean))].slice(0, 20);
  if (!uniq.length) return [];
  return api(`/projects?ids=${encodeURIComponent(JSON.stringify(uniq))}`);
}

/**
 * 按名字猜 slug 直接取项目。
 * Modrinth 搜索按词切分，标题叫 `tinkers_ingenuity` 的项目搜 "Tinkers Ingenuity" 是 0 命中，
 * 但按 slug 打开完全正常。所以搜索没结果时用它兜底。
 */
export async function projectByGuessSlug(term) {
  const base = String(term || '')
    .toLowerCase()
    .trim();
  if (!base) return null;

  const cands = [];
  for (const s of [
    base.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''),
    base.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''),
    base.replace(/[^a-z0-9]+/g, ''),
    base.replace(/\s+/g, '_'),
  ]) {
    if (s && !cands.includes(s)) cands.push(s);
  }

  for (const s of cands) {
    try {
      return await project(s);
    } catch (e) {
      if (e.status !== 404) return null;
    }
  }
  return null;
}

export function primaryFile(version) {
  if (!version || !version.files || !version.files.length) return null;
  return version.files.find((f) => f.primary) || version.files[0];
}

/** 把一个模组/资源包/光影的某个版本装进 gameDir/<subdir>/ */
export async function installModFile(file, gameDir, task, log, subdir) {
  const dirName = subdir || 'mods';
  const modsDir = ensureDir(path.join(gameDir, dirName));
  const dest = path.join(modsDir, file.filename);
  if (fs.existsSync(dest) && fs.statSync(dest).size === file.size) {
    log(`已存在，跳过：${file.filename}`);
    return dest;
  }
  log(`下载 ${file.filename} (${(file.size / 1048576).toFixed(1)} MB)`);
  await download(file.url, dest, { sha1: file.sha1, size: file.size, timeout: 120000 });
  return dest;
}

export async function latestFor(projectId, gameVersion, loader) {
  const list = await versions(projectId, { gameVersion, loader });
  const stable = list.find((v) => v.type === 'release') || list[0];
  return stable || null;
}
