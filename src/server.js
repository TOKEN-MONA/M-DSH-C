import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { dirs, setMcDir, getMcDir, ensureAll, ensureDir, UI_ROOT, DATA_ROOT } from './core/paths.js';
import * as store from './core/store.js';
import * as tasks from './core/tasks.js';
import { bus } from './core/tasks.js';
import { setSource } from './core/http.js';
import { getManifest } from './core/manifest.js';
import { resolveMerged, readVersionJson, jsonPath, jarPathFor } from './core/version.js';
import { installVersion, installFabric, featuresFor } from './core/install.js';
import { detectJava, installJava } from './core/java.js';
import * as auth from './core/auth.js';
import * as launcher from './core/launch.js';
import * as modrinth from './core/modrinth.js';
import { installMrpack, installMrpackFromFile } from './core/modpack.js';
import * as mods from './core/mods.js';
import * as cn from './core/cn.js';
import { searchMcmod } from './core/mcmod.js';
import * as cf from './core/curseforge.js';
import { download } from './core/http.js';
import { listForge, listNeoForge, installLoader } from './core/forge.js';

/* ---------------- 启动时初始化 ---------------- */

store.loadAll();
const settings = store.getSettings();

// 首次运行：自动认领已有的游戏目录（PCL2 装过的那份）
function adoptGameDir() {
  if (settings.gameDir && fs.existsSync(settings.gameDir)) {
    setMcDir(settings.gameDir);
    return settings.gameDir;
  }
  const probes = [
    'I:\\MC',
    'I:\\PCL2\\.minecraft',
    'I:\\HMCL\\.minecraft',
    'D:\\MC',
    'D:\\.minecraft',
    path.join(process.env.APPDATA || '', '.minecraft'),
    path.join(path.dirname(process.env.USERPROFILE || ''), 'Desktop', '.minecraft'),
  ];
  for (const p of probes) {
    try {
      const vdir = path.join(p, 'versions');
      if (!fs.existsSync(vdir)) continue;
      const n = fs.readdirSync(vdir).length;
      if (n > 0) {
        store.saveSettings({ gameDir: p });
        setMcDir(p);
        return p;
      }
    } catch {
      /* 继续找 */
    }
  }
  setMcDir('');
  return getMcDir();
}
adoptGameDir();
ensureAll();
setSource(settings.downloadSource);

/* ---------------- 工具 ---------------- */

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 5e6) reject(new Error('请求体过大'));
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('请求 JSON 解析失败'));
      }
    });
    req.on('error', reject);
  });
}

function readRawBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let len = 0;
    req.on('data', (c) => {
      len += c.length;
      if (len > maxBytes) {
        reject(new Error('文件太大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * 中文搜索：本地表优先，没命中就查 MC百科 并补进表里，
 * 再用英文名去 Modrinth 搜，结果排在前面。
 */
async function searchWithChinese(o) {
  const base = await modrinth.search(o);
  if (o.type !== 'mod' || !cn.hasCJK(o.query)) return { ...base, cnTerms: [] };

  let terms = cn.lookup(o.query);
  let source = 'local';

  // 精确命中就够用；只是部分匹配（比如「农夫」匹配到「农夫乐事」）时
  // 再去 MC百科 找同族的关键词，才能像 PCL 那样一次列出好几个相关模组
  const needExpand = !terms.length || (!cn.isExact(o.query) && terms.length < 2);
  if (needExpand) {
    try {
      const hits = await searchMcmod(o.query, 6);
      const add = hits.filter((h) => h.en).map((h) => ({ cn: h.cn, en: h.en }));
      for (const t of add) {
        cn.add(t.cn, t.en);
        if (!terms.some((x) => x.en.toLowerCase() === t.en.toLowerCase())) terms.push(t);
      }
      if (add.length) source = 'mcmod';
    } catch {
      /* MC百科挂了就用现有词表 */
    }
  }

  if (!terms.length) return { ...base, cnTerms: [], cnSource: 'none' };
  const picked = terms.slice(0, 4);
  let relaxed = false;
  const extra = await Promise.all(
    picked.map(async (t) => {
      let hits = [];
      try {
        let r = await modrinth.search({ ...o, query: t.en, limit: 4, offset: 0 });
        // 带版本/加载器过滤后一条都没有，就放开限制再找一次：
        // 让用户知道「这个模组存在，但不支持你选的版本」，比直接说没有有用
        if (!r.hits.length && (o.gameVersion || o.loader)) {
          const loose = await modrinth.search({ ...o, query: t.en, limit: 4, offset: 0, gameVersion: undefined, loader: undefined });
          if (loose.hits.length) {
            relaxed = true;
            r = loose;
          }
        }
        // 只给「标题就是这个英文名」的那条贴中文，别把同族附属模组都标成主模组
        const tn = normTitle(t.en);
        hits = r.hits.map((h) => ({ ...h, cnName: normTitle(h.title) === tn ? t.cn : '', __term: t.en }));
      } catch {
        hits = [];
      }

      // 搜索为空时按 slug 再猜一次（标题里带下划线/连字符的项目搜索匹配不到）
      if (!hits.length) {
        const p = await modrinth.projectByGuessSlug(t.en);
        if (p) hits = [projectToHit(p, t.cn)];
      }
      return hits;
    })
  );

  // 重排：标题正好等于映射出来的英文名（主模组）优先，其次按下载量
  const flat = extra.flat();
  flat.sort((a, b) => {
    const ea = String(a.title).toLowerCase() === String(a.__term).toLowerCase() ? 1 : 0;
    const eb = String(b.title).toLowerCase() === String(b.__term).toLowerCase() ? 1 : 0;
    if (ea !== eb) return eb - ea;
    return (b.downloads || 0) - (a.downloads || 0);
  });

  const seen = new Set();
  const hits = [];
  if (!o.offset) {
    for (const h of flat) {
      if (seen.has(h.id)) continue;
      seen.add(h.id);
      delete h.__term;
      hits.push(h);
    }
  }
  for (const h of base.hits) {
    if (seen.has(h.id)) continue;
    seen.add(h.id);
    hits.push(h);
  }

  return {
    ...base,
    hits,
    cnTerms: terms.map((t) => ({ cn: t.cn, en: t.en })),
    cnSource: source,
    relaxed,
  };
}

function normTitle(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/** 把一个 Modrinth 项目对象变成搜索结果行 */
function projectToHit(p, cnName) {
  return {
    id: p.id,
    source: 'modrinth',
    slug: p.slug,
    title: p.title,
    description: p.description || '',
    icon: p.icon_url || '',
    downloads: p.downloads || 0,
    follows: p.followers || 0,
    author: '',
    categories: p.display_categories || p.categories || [],
    cnName: cnName || '',
  };
}

/** 给每条结果补中文名：中文搜索时本来就有，英文搜索时靠反查表补上 */
function withChineseNames(r, query) {
  r.hits = (r.hits || []).map((h) => ({ ...h, cnName: h.cnName || cn.revLookup(h.title) }));

  // 名字和搜索词完全一致的（真正的那个模组）提到最前面
  const qn = normTitle(query);
  if (qn) {
    const exact = r.hits.filter((h) => normTitle(h.title) === qn);
    if (exact.length) r.hits = [...exact, ...r.hits.filter((h) => normTitle(h.title) !== qn)];
  }
  return r;
}

/** 在 Modrinth 结果之上补 CurseForge；CF 搜索没生效时静默跳过 */
async function searchAll(o) {
  const r = await searchWithChinese(o);
  r.hits = (r.hits || []).map((h) => ({ ...h, source: h.source || 'modrinth' }));

  if (cf.hasKey()) {
    try {
      const gv = o.gameVersion && /^\d+\.\d+\.\d+$/.test(o.gameVersion) ? o.gameVersion : undefined;
      const q = (r.cnTerms && r.cnTerms[0] && r.cnTerms[0].en) || o.query;
      let c = await cf.searchMods({
        query: q,
        type: o.type,
        gameVersion: gv,
        loader: o.loader,
        limit: 20,
        offset: o.offset,
      });
      // 同 Modrinth：带版本过滤后没结果就放开重搜
      if (!c.hits.length && (gv || o.loader)) {
        const loose = await cf.searchMods({ query: q, type: o.type, gameVersion: undefined, loader: undefined, limit: 20, offset: o.offset });
        if (loose.hits.length) {
          c = loose;
          r.relaxed = true;
        }
      }      const have = new Set(r.hits.map((h) => `${h.source}:${h.id}`));
      const cfOnly = c.hits.filter((h) => !have.has(`curseforge:${h.id}`));

      // 交替插入，免得 CF 结果全被压在 Modrinth 下面（每两条 Modrinth 插一条 CF）
      const mr = r.hits;
      const merged = [];
      let i = 0;
      let j = 0;
      while (i < mr.length || j < cfOnly.length) {
        if (i < mr.length) merged.push(mr[i++]);
        if (i < mr.length) merged.push(mr[i++]);
        if (j < cfOnly.length) merged.push(cfOnly[j++]);
      }
      r.hits = merged;
      r.cfStatus = c.blocked ? 'search-forbidden' : 'ok';
      r.cfTotal = c.total;
    } catch (e) {
      r.cfStatus = e.status === 403 || e.status === 401 ? 'search-forbidden' : 'error';
    }
  }

  // 英文查询也可能因为分词差异搜不到，按 slug 再猜一次
  if (!r.hits.length && o.query && !cn.hasCJK(o.query)) {
    const p = await modrinth.projectByGuessSlug(o.query);
    if (p) r.hits = [projectToHit(p, cn.revLookup(p.title))];
  }

  // MC百科本身也当成一个搜索来源：只在百科上有的模组，至少能列出来让人去百科看
  if (cn.hasCJK(o.query)) {
    try {
      const hits = await searchMcmod(o.query, 8);
      const shown = new Set((r.hits || []).map((h) => normTitle(h.title)));
      r.mcmod = hits.filter((h) => !h.en || !shown.has(normTitle(h.en))).map((h) => ({ cn: h.cn, en: h.en, url: h.url }));
    } catch {
      r.mcmod = [];
    }
  }

  return withChineseNames(r, o.query);
}

function detectLoader(name, json) {
  const n = String(name).toLowerCase();
  if (/quilt/.test(n)) return 'quilt';
  if (/neoforge/.test(n)) return 'neoforge';
  if (/fabric/.test(n)) return 'fabric';
  if (/forge/.test(n)) return 'forge';

  // cpw.mods.bootstraplauncher 被 Forge 1.17+ 和 NeoForge 共用，只能看依赖库
  const libs = (json.libraries || []).map((l) => l.name || '').join(' ');
  if (/net\.neoforged/.test(libs)) return 'neoforge';
  if (/net\.minecraftforge/.test(libs)) return 'forge';

  const main = String(json.mainClass || '');
  if (/knotclient/i.test(main)) return 'fabric';
  if (/quilt/i.test(main)) return 'quilt';
  return 'vanilla';
}

const MODDED = new Set(['fabric', 'forge', 'neoforge', 'quilt', 'modpack']);

function scanInstalled() {
  const root = dirs().versions;
  const out = [];
  let dirsList = [];
  try {
    dirsList = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return out;
  }
  for (const d of dirsList) {
    const jf = path.join(root, d.name, `${d.name}.json`);
    if (!fs.existsSync(jf)) continue;
    let json;
    try {
      json = JSON.parse(fs.readFileSync(jf, 'utf8'));
    } catch {
      continue;
    }
    const meta = store.getVersionMeta(d.name) || {};
    const loader = meta.loader || detectLoader(d.name, json);
    const mcVersion = meta.mcVersion || json.inheritsFrom || json.clientVersion || json.id || d.name;
    out.push({
      id: d.name,
      loader,
      mcVersion,
      loaderVersion: meta.loaderVersion || '',
      type: meta.type || json.type || 'release',
      // 默认全部隔离：和 PCL2 装出来的目录结构一致，存档/mod 才不会“消失”
      isolated: meta.isolated !== undefined ? meta.isolated : true,
      hasJar: fs.existsSync(jarPathFor(json.jar || json.inheritsFrom || d.name)),
      javaMajor: (json.javaVersion && json.javaVersion.majorVersion) || meta.javaMajor || 8,
      lastPlayed: meta.lastPlayed || 0,
      playTimeSec: meta.playTimeSec || 0,
      installedAt: meta.installedAt || 0,
      description: meta.description || '',
      packProjectId: meta.packProjectId || null,
      running: launcher.running.has(d.name),
    });
  }
  out.sort((a, b) => (b.lastPlayed || b.installedAt) - (a.lastPlayed || a.installedAt));
  return out;
}

function statePayload() {
  const acc = store.getAccounts();
  const s = store.getSettings();
  return {
    settings: { ...s, gameDir: getMcDir() },
    account: acc.current ? { type: acc.current.type, name: acc.current.name, uuid: acc.current.uuid } : null,
    accounts: (acc.list || []).map((a) => ({ type: a.type, name: a.name, uuid: a.uuid })),
    versions: scanInstalled(),
    platform: process.platform,
    node: process.version,
    dataRoot: DATA_ROOT,
  };
}

function broadcast(event, data) {
  for (const c of sseClients) {
    try {
      c.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      /* ignore */
    }
  }
}
const sseClients = new Set();

// 由 MCLauncher.exe 宿主启动时置 1：界面关掉、游戏也不在跑，就自己退出，避免留孤儿进程
const IDLE_EXIT = process.env.MCL_IDLE_EXIT === '1';
const serverStartedAt = Date.now();
let lastClientAt = Date.now();
if (IDLE_EXIT) {
  setInterval(() => {
    if (sseClients.size > 0) return;
    if (launcher.running.size > 0) return;
    if (Date.now() - Math.max(serverStartedAt, lastClientAt) < 60000) return;
    console.log('界面已关闭且没有游戏在运行，服务退出。');
    process.exit(0);
  }, 5000).unref();
}

/* ---------------- 路由 ---------------- */

const routes = [];
const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

route('GET', /^\/api\/state$/, async (req, res) => send(res, 200, statePayload()));

route('POST', /^\/api\/settings$/, async (req, res) => {
  const body = await readBody(req);
  const allowed = [
    'downloadSource',
    'downloadThreads',
    'maxMemoryMB',
    'minMemoryMB',
    'javaPath',
    'jvmArgs',
    'windowWidth',
    'windowHeight',
    'clientId',
    'curseforgeKey',
    'selectedVersion',
    'showSnapshot',
  ];
  const patch = {};
  for (const k of allowed) if (k in body) patch[k] = body[k];
  if ('gameDir' in body) {
    patch.gameDir = body.gameDir;
    setMcDir(body.gameDir);
    ensureAll();
  }
  store.saveSettings(patch);
  if (patch.downloadSource) setSource(patch.downloadSource);
  broadcast('state', statePayload());
  send(res, 200, { ok: true, settings: { ...store.getSettings(), gameDir: getMcDir() } });
});

route('GET', /^\/api\/manifest$/, async (req, res, m, url) => {
  const force = url.searchParams.get('force') === '1';
  const data = await getManifest({ force });
  const latest = {};
  for (const v of data.versions) if (!latest[v.type]) latest[v.type] = v.id;
  send(res, 200, { latest, versions: data.versions.map((v) => ({ id: v.id, type: v.type, releaseTime: v.releaseTime })) });
});

route('POST', /^\/api\/install$/, async (req, res) => {
  const { versionId, loader, loaderVersion } = await readBody(req);
  if (!versionId) return send(res, 400, { error: '缺少版本号' });
  const task = tasks.createTask(loader && loader !== 'vanilla' ? `安装 ${versionId} + ${loader}` : `安装 ${versionId}`);
  (async () => {
    try {
      if (loader === 'fabric') await installFabric(versionId, task, loaderVersion || null);
      else if (loader === 'forge' || loader === 'neoforge') await installLoader(versionId, loader, loaderVersion, task);
      else await installVersion(versionId, task);
      tasks.finish(task, null);
    } catch (e) {
      tasks.log(task, `失败：${e.message}`);
      tasks.finish(task, e);
    }
    broadcast('state', statePayload());
  })();
  send(res, 200, { taskId: task.id });
});

route('POST', /^\/api\/kill$/, async (req, res) => {
  const { versionId } = await readBody(req);
  const s = launcher.running.get(versionId);
  if (!s) return send(res, 400, { error: '这个版本没有在运行' });
  try {
    s.child.kill();
  } catch (e) {
    return send(res, 500, { error: `结束进程失败：${e.message}` });
  }
  send(res, 200, { ok: true });
  setTimeout(() => broadcast('state', statePayload()), 300);
});

route('POST', /^\/api\/launch$/, async (req, res) => {
  const { versionId } = await readBody(req);
  if (!versionId) return send(res, 400, { error: '缺少版本号' });
  const task = tasks.createTask(`启动 ${versionId}`);
  (async () => {
    try {
      await launcher.launch(versionId, task);
    } catch (e) {
      tasks.log(task, `启动失败：${e.message}`);
      tasks.finish(task, e);
    }
    broadcast('state', statePayload());
  })();
  send(res, 200, { taskId: task.id });
});

route('POST', /^\/api\/version\/([^/]+)\/meta$/, async (req, res, m) => {
  const id = decodeURIComponent(m[1]);
  const body = await readBody(req);
  const patch = {};
  if ('isolated' in body) patch.isolated = !!body.isolated;
  store.setVersionMeta(id, patch);
  broadcast('state', statePayload());
  send(res, 200, { ok: true, meta: store.getVersionMeta(id) });
});

route('POST', /^\/api\/version\/([^/]+)\/delete$/, async (req, res, m) => {
  const id = decodeURIComponent(m[1]);
  const dir = path.join(dirs().versions, id);
  if (path.dirname(dir) !== path.resolve(dirs().versions)) return send(res, 400, { error: '非法路径' });
  if (launcher.running.has(id)) return send(res, 400, { error: '这个版本正在运行' });
  fs.rmSync(dir, { recursive: true, force: true });
  store.removeVersionMeta(id);
  broadcast('state', statePayload());
  send(res, 200, { ok: true });
});

route('POST', /^\/api\/version\/([^/]+)\/reveal$/, async (req, res, m, url) => {
  const id = decodeURIComponent(m[1]);
  const sub = url.searchParams.get('sub') || '';
  let dir;
  if (!sub) dir = path.join(dirs().versions, id);
  else if (sub === 'game') dir = launcher.gameDirFor(id);
  else dir = path.join(launcher.gameDirFor(id), sub);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* 只读目录就算了 */
  }
  exec(`explorer.exe "${dir}"`);
  send(res, 200, { ok: true, dir });
});

route('POST', /^\/api\/version\/([^/]+)\/cmdline$/, async (req, res, m) => {
  const id = decodeURIComponent(m[1]);
  try {
    let acc = auth.currentAccount();
    if (!acc) acc = { type: 'offline', name: 'Player', uuid: '00000000000000000000000000000000', accessToken: '0' };
    const cmd = launcher.buildCommand(id, acc, '<java>');
    send(res, 200, {
      text: `"<java>" ${cmd.args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`,
      gameDir: cmd.gameDir,
    });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

/* 账号 */

route('GET', /^\/api\/java$/, async (req, res) => {
  const list = await detectJava({ refresh: true });
  send(res, 200, { list, custom: store.getSettings().javaPath });
});

route('POST', /^\/api\/java\/install$/, async (req, res) => {
  const { major = 21 } = await readBody(req);
  const task = tasks.createTask(`下载 Java ${major}`);
  (async () => {
    try {
      await installJava(major, null, task);
      tasks.finish(task, null);
    } catch (e) {
      tasks.finish(task, e);
    }
    broadcast('state', statePayload());
  })();
  send(res, 200, { taskId: task.id });
});

// 只检查应用 ID 配置对不对，不真正登录（拿到的设备码直接丢掉）
route('POST', /^\/api\/auth\/client-check$/, async (req, res) => {
  try {
    const d = await auth.startDeviceLogin();
    const custom = !!(store.getSettings().clientId || '').trim();
    send(res, 200, {
      ok: !d.fallback,
      fallback: !!d.fallback,
      custom,
      usedClientId: d.fallback ? '公共备用 ID' : '你自己的 ID',
      reason: d.reason || '',
      // 这一步只验证 Azure 那边配对了，Minecraft 的白名单要真登录才知道
      note: custom ? '注意：这只检查了微软侧配置。能不能换到 Minecraft 令牌，要真的登录一次才知道（自注册应用常报 403 Invalid app registration）。' : '',
    });
  } catch (e) {
    send(res, 200, { ok: false, fallback: false, error: e.message });
  }
});

route('POST', /^\/api\/auth\/device\/start$/, async (req, res) => {
  try {
    const d = await auth.startDeviceLogin();
    send(res, 200, d);
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

route('POST', /^\/api\/auth\/device\/poll$/, async (req, res) => {
  const { deviceCode } = await readBody(req);
  try {
    const r = await auth.pollDeviceLogin(deviceCode);
    if (r.status !== 'ok') return send(res, 200, r);
    const acc = await auth.completeMicrosoftLogin(r.token);
    broadcast('state', statePayload());
    send(res, 200, { status: 'ok', account: { name: acc.name, uuid: acc.uuid, type: 'msa' } });
  } catch (e) {
    send(res, 200, { status: 'error', message: e.message });
  }
});

route('POST', /^\/api\/auth\/offline$/, async (req, res) => {
  const { name } = await readBody(req);
  try {
    const acc = auth.loginOffline(name);
    broadcast('state', statePayload());
    send(res, 200, { ok: true, account: { name: acc.name, uuid: acc.uuid, type: 'offline' } });
  } catch (e) {
    send(res, 400, { error: e.message });
  }
});

route('POST', /^\/api\/auth\/clear$/, async (req, res) => {
  const acc = store.getAccounts();
  acc.list = [];
  acc.current = null;
  store.saveAccounts();
  broadcast('state', statePayload());
  send(res, 200, { ok: true });
});

route('POST', /^\/api\/auth\/logout$/, async (req, res) => {
  auth.logout();
  broadcast('state', statePayload());
  send(res, 200, { ok: true });
});

route('POST', /^\/api\/auth\/switch$/, async (req, res) => {
  const { name } = await readBody(req);
  const acc = store.getAccounts();
  const hit = (acc.list || []).find((a) => a.name === name);
  if (!hit) return send(res, 404, { error: '没有这个账号' });
  acc.current = hit;
  store.saveAccounts();
  broadcast('state', statePayload());
  send(res, 200, { ok: true });
});

/* Modrinth */

route('GET', /^\/api\/cf\/probe$/, async (req, res) => {
  try {
    send(res, 200, await cf.probe());
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

route('GET', /^\/api\/modrinth\/search$/, async (req, res, m, url) => {
  try {
    const data = await searchAll({
      query: url.searchParams.get('q') || '',
      type: url.searchParams.get('type') || 'mod',
      gameVersion: url.searchParams.get('gv') || undefined,
      loader: url.searchParams.get('loader') || undefined,
      limit: Number(url.searchParams.get('limit') || 20),
      offset: Number(url.searchParams.get('offset') || 0),
    });
    send(res, 200, data);
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

route('GET', /^\/api\/cn\/stats$/, async (req, res) => {
  send(res, 200, cn.stats());
});

function cmpMc(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

// 项目详情：项目信息 + 全部文件版本 + 出现过的 MC 版本（给详情页做 tab）
route('GET', /^\/api\/project$/, async (req, res, m, url) => {
  const id = url.searchParams.get('project');
  if (!id) return send(res, 400, { error: '缺少 project' });
  const source = url.searchParams.get('source') || 'modrinth';
  try {
    if (source === 'curseforge') {
      const d = await cf.project(id);
      return send(res, 200, d);
    }
    const [p, vers] = await Promise.all([modrinth.project(id), modrinth.versions(id)]);
    const mcSet = new Set();
    for (const v of vers) for (const g of v.gameVersions || []) if (/^\d/.test(g)) mcSet.add(g);
    const mcVersions = [...mcSet].sort(cmpMc).reverse();

    // 汇总所有版本里「必需」的前置项目，供详情页展示（玩家可以点进去自己挑版本）
    const depIds = [];
    for (const v of vers) {
      for (const d of v.dependencies || []) {
        if (d.dependency_type === 'required' && d.project_id && !depIds.includes(d.project_id)) depIds.push(d.project_id);
      }
    }
    let depProjects = [];
    if (depIds.length) {
      try {
        depProjects = (await modrinth.projects(depIds)).map((x) => ({
          id: x.id,
          slug: x.slug,
          title: x.title,
          description: x.description || '',
          icon: x.icon_url || '',
          downloads: x.downloads || 0,
          source: 'modrinth',
        }));
      } catch {
        depProjects = [];
      }
    }

    send(res, 200, {
      project: {
        id: p.id,
        slug: p.slug,
        title: p.title,
        description: p.description,
        icon: p.icon_url,
        downloads: p.downloads,
        follows: p.followers,
        categories: p.display_categories || p.categories || [],
        loaders: p.loaders || [],
        updated: p.updated,
        sourceUrl: p.source_url || '',
        projectType: p.project_type,
      },
      versions: vers,
      mcVersions,
      depProjects,
    });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

route('GET', /^\/api\/modrinth\/versions$/, async (req, res, m, url) => {
  try {
    const data = await modrinth.versions(url.searchParams.get('project'), {
      gameVersion: url.searchParams.get('gv') || undefined,
      loader: url.searchParams.get('loader') || undefined,
    });
    send(res, 200, { versions: data });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

route('POST', /^\/api\/modrinth\/install$/, async (req, res) => {
  const { projectId, versionId, targetVersionId, gameVersion, loader, kind, source, fileId, modId } = await readBody(req);
  if (!projectId) return send(res, 400, { error: '缺少 projectId' });
  const target = targetVersionId || store.getSettings().selectedVersion;
  if (!target) return send(res, 400, { error: '没有选中要装进哪个版本' });

  const subdir = kind === 'resourcepack' ? 'resourcepacks' : kind === 'shader' ? 'shaderpacks' : 'mods';
  const label = kind === 'resourcepack' ? '资源包' : kind === 'shader' ? '光影' : '模组';
  const task = tasks.createTask(`安装${label} → ${target}`);

  (async () => {
    try {
      const gameDir0 = launcher.gameDirFor(target);
      if (source === 'curseforge') {
        const info = await cf.fileInfo(modId || projectId, fileId || versionId);
        if (!info.url) throw new Error('作者禁止第三方分发这个文件，只能去 CurseForge 网页手动下载');
        const dest = path.join(ensureDir(path.join(gameDir0, subdir)), info.filename);
        tasks.patch(task, { stage: `下载 ${info.filename}` });
        tasks.log(task, `CurseForge → ${dest}`);
        await download(info.url, dest, { size: info.size, timeout: 600000 });
        tasks.patch(task, { done: 100 });
        tasks.finish(task, null);
        return;
      }

      const meta = store.getVersionMeta(target) || {};
      const gv = gameVersion || meta.mcVersion;
      const ld = loader || meta.loader;
      let ver;
      if (versionId) {
        const list = await modrinth.versions(projectId);
        ver = list.find((v) => v.id === versionId);
      } else {
        ver = await modrinth.latestFor(projectId, gv && gv !== 'vanilla' ? gv : undefined, ld === 'vanilla' ? undefined : ld);
      }
      if (!ver) throw new Error('找不到适配当前版本的可用文件');
      const file = modrinth.primaryFile(ver);
      const gameDir = launcher.gameDirFor(target);
      tasks.patch(task, { stage: `下载 ${ver.versionNumber}` });
      await modrinth.installModFile(file, gameDir, task, (l) => tasks.log(task, l), subdir);

      // 只有模组才自动补 required 前置
      if (subdir === 'mods') {
        for (const dep of ver.dependencies || []) {
          if (dep.dependency_type !== 'required' || !dep.project_id) continue;

          // Modrinth 会明确给出「这个模组要哪个前置版本」。
          // 必须照它来——MC 的模组是版本锁死的，前置乱升到最新版会直接炸整合包。
          let dv = null;
          if (dep.version_id) {
            try {
              const list = await modrinth.versions(dep.project_id);
              dv = list.find((v) => v.id === dep.version_id) || null;
            } catch {
              dv = null;
            }
          }
          if (!dv) {
            // 只有在作者没指定具体版本时，才退回"适配当前 MC 版本的最新版"
            dv = await modrinth.latestFor(dep.project_id, gv, ld);
            if (dv) tasks.log(task, `前置 ${dv.name} 没有指定版本，使用适配的最新版 ${dv.versionNumber}`);
          }
          if (!dv) continue;

          const df = modrinth.primaryFile(dv);
          if (df) {
            tasks.patch(task, { stage: `安装前置依赖 ${dv.name} ${dv.versionNumber || ''}` });
            await modrinth.installModFile(df, gameDir, task, (l) => tasks.log(task, l), subdir);
          }
        }
      }
      tasks.patch(task, { done: 100 });
      tasks.finish(task, null);
    } catch (e) {
      tasks.log(task, `失败：${e.message}`);
      tasks.finish(task, e);
    }
    broadcast('state', statePayload());
  })();
  send(res, 200, { taskId: task.id });
});

/* 模组管理 */

route('GET', /^\/api\/mods$/, async (req, res, m, url) => {
  const id = url.searchParams.get('version') || store.getSettings().selectedVersion;
  if (!id) return send(res, 400, { error: '没有指定版本' });
  try {
    const gameDir = launcher.gameDirFor(id);
    const data = mods.listMods(gameDir);
    send(res, 200, { version: id, gameDir, ...data });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

route('POST', /^\/api\/mods\/toggle$/, async (req, res) => {
  const { version, file, enabled } = await readBody(req);
  if (!version || !file) return send(res, 400, { error: '参数不全' });
  try {
    const gameDir = launcher.gameDirFor(version);
    const r = mods.setModEnabled(gameDir, file, !!enabled);
    send(res, 200, { ok: true, ...r });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

route('POST', /^\/api\/mods\/delete$/, async (req, res) => {
  const { version, file } = await readBody(req);
  if (!version || !file) return send(res, 400, { error: '参数不全' });
  try {
    mods.deleteMod(launcher.gameDirFor(version), file);
    send(res, 200, { ok: true });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

route('GET', /^\/api\/forge\/list$/, async (req, res, m, url) => {
  const mc = url.searchParams.get('mc');
  const kind = url.searchParams.get('loader') || 'forge';
  try {
    const list = kind === 'neoforge' ? await listNeoForge(mc) : await listForge(mc);
    send(res, 200, { versions: list.slice(0, 50) });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

route('POST', /^\/api\/modpack\/install$/, async (req, res) => {
  const body = await readBody(req);
  const task = tasks.createTask(`安装整合包 ${body.title || ''}`.trim());
  (async () => {
    try {
      await installMrpack(body, task);
      tasks.finish(task, null);
    } catch (e) {
      tasks.log(task, `失败：${e.message}`);
      tasks.finish(task, e);
    }
    broadcast('state', statePayload());
  })();
  send(res, 200, { taskId: task.id });
});

// 本地 .mrpack 导入：浏览器把整个文件原样 POST 上来（本机，不走 multipart）
route('POST', /^\/api\/modpack\/import$/, async (req, res) => {
  let name = 'import.mrpack';
  try {
    name = decodeURIComponent(String(req.headers['x-filename'] || 'import.mrpack'));
  } catch {
    /* 用默认名 */
  }
  let buf;
  try {
    buf = await readRawBody(req, 1024 * 1024 * 1024);
  } catch (e) {
    return send(res, 413, { error: e.message });
  }
  if (!buf.length) return send(res, 400, { error: '收到的是空文件' });

  const dir = ensureDir(path.join(dirs().cache, 'packs'));
  const tmp = path.join(dir, `import-${Date.now()}.mrpack`);
  fs.writeFileSync(tmp, buf);

  const title = name.replace(/\.(mrpack|zip)$/i, '');
  const task = tasks.createTask(`导入整合包 ${title}`);
  (async () => {
    try {
      await installMrpackFromFile(tmp, task, title);
      tasks.finish(task, null);
    } catch (e) {
      tasks.log(task, `失败：${e.message}`);
      tasks.finish(task, e);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    broadcast('state', statePayload());
  })();
  send(res, 200, { taskId: task.id });
});

/* 事件流 */

route('GET', /^\/api\/events$/, async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('retry: 2000\n\n');
  sseClients.add(res);
  lastClientAt = Date.now();
  res.write(`event: hello\ndata: ${JSON.stringify(statePayload())}\n\n`);
  req.on('close', () => {
    sseClients.delete(res);
    lastClientAt = Date.now();
  });
});

route('GET', /^\/api\/tasks$/, async (req, res) => send(res, 200, { tasks: tasks.listTasks() }));

// 只允许打开微软/Modrinth 相关页面，避免变成任意命令执行
const OPEN_ALLOW = [/^https:\/\/([a-z0-9-]+\.)*microsoft\.com\//i, /^https:\/\/([a-z0-9-]+\.)*microsoftonline\.com\//i, /^https:\/\/([a-z0-9-]+\.)*live\.com\//i];
route('POST', /^\/api\/open$/, async (req, res) => {
  const { url } = await readBody(req);
  if (!url || !OPEN_ALLOW.some((re) => re.test(url))) return send(res, 400, { error: '这个地址不允许打开' });
  exec(`start "" "${url}"`);
  send(res, 200, { ok: true });
});

route('POST', /^\/api\/shutdown$/, async (req, res) => {
  send(res, 200, { ok: true });
  setTimeout(() => process.exit(0), 200);
});

/* ---------------- HTTP 服务器 ---------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = decodeURIComponent(url.pathname);

  if (p.startsWith('/api/')) {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.pattern.exec(p);
      if (!m) continue;
      try {
        await r.handler(req, res, m, url);
      } catch (e) {
        if (!res.headersSent) send(res, 500, { error: e.message || String(e) });
      }
      return;
    }
    return send(res, 404, { error: '没有这个接口' });
  }

  // 静态文件
  const rel = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
  const file = path.join(UI_ROOT, rel);
  const root = path.resolve(UI_ROOT);
  if (!path.resolve(file).startsWith(root)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

function openApp(url) {
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || '';
  const candidates = [
    path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ];
  const exe = candidates.find((c) => c && fs.existsSync(c));
  if (!exe) {
    exec(`start "" "${url}"`);
    return null;
  }
  const child = spawn(
    exe,
    [
      `--app=${url}`,
      '--window-size=1200,800',
      `--user-data-dir=${dirs().browser}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate,msSmartScreenProtection',
      '--allow-file-access-from-files',
    ],
    { detached: true, stdio: 'ignore', windowsHide: false }
  );
  child.on('error', () => {});
  child.unref();
  return exe;
}

const PORT = Number(process.env.MCL_PORT || 0);
const openWindow = !process.argv.includes('--no-window');

server.listen(PORT, '127.0.0.1', () => {
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/`;
  console.log('');
  console.log('  M-DSH-C 已启动');
  console.log(`  界面地址：${url}`);
  console.log(`  游戏目录：${getMcDir()}`);
  console.log(`  数据目录：${DATA_ROOT}`);
  console.log('  关掉这个黑窗口就等于关掉启动器。');
  console.log('');
  if (openWindow) {
    // 开窗口失败不能把服务带崩，控制台里有地址可以直接手动打开
    let exe = null;
    try {
      exe = openApp(url);
    } catch (e) {
      console.log(`  打开窗口失败（${e.message}），请手动在浏览器里访问上面的地址`);
    }
    if (exe) console.log(`  已用 ${path.basename(exe)} 的应用窗口打开界面`);
  }
  fs.writeFileSync(path.join(DATA_ROOT, 'ui-url.txt'), url, 'utf8');
});

bus.on('task', (t) => broadcast('task', t));
bus.on('task-log', (d) => broadcast('log', d));

process.on('uncaughtException', (e) => {
  console.error('[未捕获异常]', e);
});
process.on('unhandledRejection', (e) => {
  console.error('[未处理 Promise]', e && e.message ? e.message : e);
});
