import { getSettings } from './store.js';

/**
 * CurseForge 官方 API。
 * 需要 key（x-api-key），在 https://console.curseforge.com/ 申请。
 * 注意：新 key 的 /mods/search 可能延迟生效，其余端点通常立刻可用。
 */

const BASE = 'https://api.curseforge.com/v1';
const GAME_ID = 432; // Minecraft

// classId
export const CLASS = { mod: 6, modpack: 4471, resourcepack: 12, shader: 6552 };

// modLoaderType
const LOADER_ID = { forge: 1, fabric: 4, quilt: 5, neoforge: 6 };
const LOADER_NAME = { 1: 'forge', 4: 'fabric', 5: 'quilt', 6: 'neoforge' };

// releaseType
const RELEASE_NAME = { 1: 'release', 2: 'beta', 3: 'alpha' };

let searchBlockedUntil = 0;

export function key() {
  const s = getSettings();
  return (s.curseforgeKey || '').trim();
}

export function hasKey() {
  return key().length > 0;
}

async function api(path, { timeout = 20000, retry = 0 } = {}) {
  const k = key();
  if (!k) throw new Error('没有配置 CurseForge API Key');
  let lastErr;
  for (let attempt = 0; attempt <= retry; attempt++) {
    try {
      const res = await fetch(BASE + path, {
        headers: { 'x-api-key': k, Accept: 'application/json', 'User-Agent': 'M-DSH-C/1.0' },
        signal: AbortSignal.timeout(timeout),
      });
      const text = await res.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        /* 非 JSON */
      }
      if (!res.ok) {
        const err = new Error(`CurseForge ${res.status}: ${(data && data.error) || text.slice(0, 120)}`);
        err.status = res.status;
        throw err;
      }
      return data;
    } catch (e) {
      lastErr = e;
      // CF 对刚激活的 key / 高频请求会返回 403，等一下就恢复，重试一次
      if (attempt < retry && (e.status === 403 || e.status === 429 || e.status === 0)) {
        await new Promise((r) => setTimeout(r, 900));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

/** 探测 key 各端点的可用性 */
export async function probe() {
  const out = { hasKey: hasKey(), endpoints: [] };
  if (!out.hasKey) return out;
  const checks = [
    ['游戏信息', '/games/432'],
    ['分类', '/categories?gameId=432'],
    ['Mod 详情', '/mods/372330'],
    ['Mod 文件', '/mods/372330/files?pageSize=1'],
    ['搜索', '/mods/search?gameId=432&classId=6&pageSize=1'],
  ];
  for (const [name, path] of checks) {
    try {
      await api(path, { timeout: 12000, retry: 1 });
      out.endpoints.push({ name, ok: true });
    } catch (e) {
      out.endpoints.push({ name, ok: false, status: e.status || 0, message: e.message });
    }
  }
  out.searchUsable = out.endpoints.find((e) => e.name === '搜索').ok;
  return out;
}

function loaderNames(file) {
  const set = new Set();
  for (const g of file.gameVersions || []) {
    const low = String(g).toLowerCase();
    if (['forge', 'fabric', 'quilt', 'neoforge'].includes(low)) set.add(low);
    else {
      const n = LOADER_NAME[g];
      if (n) set.add(n);
    }
  }
  return [...set];
}

function mcVersionsOf(file) {
  return (file.gameVersions || []).filter((g) => /^\d/.test(g));
}

/** 文件直链：优先 downloadUrl，没有就按 CF 的 CDN 规则拼 */
export function fileUrl(mod, file) {
  if (file.downloadUrl) return file.downloadUrl;
  if (mod && mod.allowModDistribution === false) return null;
  const id = Number(file.id);
  return `https://edge.forgecdn.net/files/${Math.floor(id / 1000)}/${id % 1000}/${encodeURIComponent(file.fileName)}`;
}

export async function searchMods({ query = '', type = 'mod', gameVersion, loader, limit = 20, offset = 0 }) {
  if (!hasKey()) return { total: 0, hits: [] };
  if (Date.now() < searchBlockedUntil) return { total: 0, hits: [], blocked: true };

  const q = new URLSearchParams({
    gameId: String(GAME_ID),
    classId: String(CLASS[type] || CLASS.mod),
    index: String(offset),
    pageSize: String(Math.min(limit, 50)),
    sortField: '2',
    sortOrder: 'desc',
  });
  if (query) q.set('searchFilter', query);
  if (gameVersion && /^\d/.test(gameVersion)) q.set('gameVersion', gameVersion);
  const lt = LOADER_ID[loader];
  if (lt && type === 'mod') q.set('modLoaderType', String(lt));

  try {
    const d = await api(`/mods/search?${q.toString()}`, { retry: 1 });
    return {
      total: (d.pagination && d.pagination.totalCount) || 0,
      hits: (d.data || []).map((m) => ({
        id: String(m.id),
        source: 'curseforge',
        slug: m.slug,
        title: m.name,
        description: m.summary || '',
        icon: (m.logo && m.logo.thumbnailUrl) || '',
        downloads: m.downloadCount || 0,
        follows: 0,
        author: (m.authors && m.authors[0] && m.authors[0].name) || '',
        categories: (m.categories || []).map((c) => c.name),
        distributable: m.allowModDistribution !== false,
      })),
    };
  } catch (e) {
    if (e.status === 403 || e.status === 401) searchBlockedUntil = Date.now() + 2 * 60 * 1000;
    throw e;
  }
}

/** 项目详情，映射成和 Modrinth 一样的结构，前端不用改 */
export async function project(id) {
  const [m, f] = await Promise.all([
    api(`/mods/${encodeURIComponent(id)}`),
    api(`/mods/${encodeURIComponent(id)}/files?pageSize=200`),
  ]);
  const mod = m.data;
  const files = (f.data || []).sort((a, b) => String(b.fileDate).localeCompare(String(a.fileDate)));

  const versions = files.map((file) => ({
    id: String(file.id),
    versionNumber: file.displayName || file.fileName,
    type: RELEASE_NAME[file.releaseType] || 'release',
    gameVersions: mcVersionsOf(file),
    loaders: loaderNames(file),
    datePublished: file.fileDate,
    downloads: file.downloadCount || 0,
    files: [
      {
        url: fileUrl(mod, file),
        filename: file.fileName,
        size: file.fileLength,
        sha1: null,
      },
    ],
    dependencies: [],
    source: 'curseforge',
  }));

  const mcSet = new Set();
  for (const v of versions) for (const g of v.gameVersions) mcSet.add(g);

  const loaders = new Set();
  for (const v of versions) for (const l of v.loaders) loaders.add(l);

  return {
    project: {
      id: String(mod.id),
      source: 'curseforge',
      slug: mod.slug,
      title: mod.name,
      description: mod.summary || '',
      icon: (mod.logo && mod.logo.thumbnailUrl) || '',
      downloads: mod.downloadCount || 0,
      follows: 0,
      categories: (mod.categories || []).map((c) => c.name),
      loaders: [...loaders],
      updated: mod.dateModified,
      sourceUrl: mod.links && mod.links.websiteUrl,
      projectType: 'mod',
    },
    versions,
    mcVersions: [...mcSet].sort((a, b) => {
      const pa = a.split('.').map(Number);
      const pb = b.split('.').map(Number);
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const x = pa[i] || 0;
        const y = pb[i] || 0;
        if (x !== y) return y - x;
      }
      return 0;
    }),
  };
}

/** 取单个文件（安装时用），同时返回所属 mod 以便判断能否分发 */
export async function fileInfo(modId, fileId) {
  const [m, f] = await Promise.all([
    api(`/mods/${encodeURIComponent(modId)}`),
    api(`/mods/${encodeURIComponent(modId)}/files/${encodeURIComponent(fileId)}`),
  ]);
  const file = f.data;
  return {
    mod: m.data,
    file,
    url: fileUrl(m.data, file),
    filename: file.fileName,
    size: file.fileLength,
  };
}

export function searchStatus() {
  if (!hasKey()) return 'no-key';
  if (Date.now() < searchBlockedUntil) return 'search-forbidden';
  return 'ok';
}
