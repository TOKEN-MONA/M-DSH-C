/* MCLauncher 前端 —— 原生 JS，无框架 */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const state = {
  settings: {},
  account: null,
  accounts: [],
  versions: [],
  manifest: [],
  manifestType: 'release',
  selected: '',
  currentTaskId: null,
  modpack: null,
};

/* ---------------- 基础工具 ---------------- */

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.body ? 'POST' : 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    data = {};
  }
  if (!res.ok) throw new Error(data.error || `请求失败 ${res.status}`);
  if (data.error && !data.ok && !data.taskId && !data.versions && !data.list) throw new Error(data.error);
  return data;
}

let toastTimer;
function toast(msg, isErr = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast show${isErr ? ' err' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = 'toast'), 3200);
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

function fmtSize(n) {
  if (!n) return '0';
  if (n > 1048576) return (n / 1048576).toFixed(1) + ' MB';
  return Math.round(n / 1024) + ' KB';
}

function fmtNum(n) {
  if (n > 1e8) return (n / 1e8).toFixed(1) + ' 亿';
  if (n > 1e4) return (n / 1e4).toFixed(1) + ' 万';
  return String(n || 0);
}

/** MC百科的名字常带「[FD] 农夫乐事」这种前缀，显示时去掉 */
function cleanCnName(s) {
  const raw = String(s || '');
  const stripped = raw.replace(/^\s*\[[^\]]{1,10}\]\s*/, '').trim();
  return stripped || raw;
}

/** 有中文名就中文为主、英文为辅（和 PCL 一致）；没有就只显示英文 */
function nameHtml(h) {
  const cn = h.cnName ? cleanCnName(h.cnName) : '';
  const en = h.title || '';
  if (cn && String(cn).toLowerCase() !== String(en).toLowerCase()) {
    return `${esc(cn)}<span class="title-alt">${esc(en)}</span>`;
  }
  return esc(en);
}

function ago(ts) {
  if (!ts) return '从未';
  const d = Date.now() - ts;
  if (d < 60000) return '刚刚';
  if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前';
  if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前';
  return Math.floor(d / 86400000) + ' 天前';
}

const LOADER_LABEL = { vanilla: '原版', fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge', quilt: 'Quilt', modpack: '整合包' };

/* ---------------- 页面切换 ---------------- */

function goto(page) {
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.page === page));
  $$('.page').forEach((p) => p.classList.toggle('active', p.id === `page-${page}`));
  if (page === 'versions') renderVersions();
  if (page === 'mods') {
    fillModsVersionSelect();
    loadMods();
  }
  if (page === 'download' && !state.manifest.length) loadManifest();
  if (page === 'settings') renderSettings();
  if (page === 'account') renderAccounts();
}

$('#nav').addEventListener('click', (e) => {
  const b = e.target.closest('.nav-item');
  if (b) goto(b.dataset.page);
});
document.addEventListener('click', (e) => {
  const g = e.target.closest('[data-goto]');
  if (g) goto(g.dataset.goto);

  const q = e.target.closest('[data-quick]');
  if (q) {
    const k = q.dataset.quick;
    if (k === 'mods') return goto('mods');
    if (!state.selected) return toast('先选一个版本', true);
    const sub = k === 'game' ? 'game' : 'logs';
    api(`/api/version/${encodeURIComponent(state.selected)}/reveal?sub=${sub}`, { body: {} }).catch((err) => toast(err.message, true));
  }
});
$('#accChip').addEventListener('click', () => goto('account'));

/* ---------------- 状态 ---------------- */

async function refresh() {
  const data = await api('/api/state');
  state.settings = data.settings;
  state.account = data.account;
  state.accounts = data.accounts || [];
  state.versions = data.versions || [];
  state.system = data.system || null;
  state.memory = data.memory || null;
  if (!state.selected || !state.versions.some((v) => v.id === state.selected)) {
    state.selected = state.settings.selectedVersion || (state.versions[0] && state.versions[0].id) || '';
  }
  renderHeader();
  renderHome();
  renderVersions();
  renderAccounts();
  renderSettings();
  fillVersionSelects();
}

function renderHeader() {
  const a = state.account;
  const chip = $('#accChip');
  chip.classList.toggle('msa', !!(a && a.type === 'msa'));
  $('#accAvatar').textContent = a ? a.name.slice(0, 1) : '?';
  $('#accName').textContent = a ? a.name : '未登录';
  $('#accType').textContent = a ? (a.type === 'msa' ? '正版账号' : '离线账号') : '点这里登录';
  $('#brandSub').textContent = state.versions.length ? `${state.versions.length} 个版本` : '自用启动器';
}

/* ---------------- 首页 ---------------- */

function renderHome() {
  const sel = $('#homeVersionSelect');
  if (state.versions.length) {
    sel.disabled = false;
    sel.innerHTML = state.versions
      .map(
        (v) =>
          `<option value="${esc(v.id)}"${v.id === state.selected ? ' selected' : ''}>${esc(v.id)} · ${LOADER_LABEL[v.loader] || v.loader}</option>`
      )
      .join('');
  } else {
    sel.disabled = true;
    sel.innerHTML = '<option value="">（还没有安装任何版本）</option>';
  }

  const v = state.versions.find((x) => x.id === state.selected);
  const badges = $('#homeBadges');
  if (v) {
    const items = [
      `<span class="badge ${v.loader}">${LOADER_LABEL[v.loader] || v.loader}</span>`,
      `<span class="badge">Minecraft ${esc(v.mcVersion)}</span>`,
      `<span class="badge">Java ${v.javaMajor}+</span>`,
    ];
    if (v.isolated) items.push('<span class="badge ok">版本隔离</span>');
    badges.innerHTML = items.join('');
  } else {
    badges.innerHTML = '<span class="badge">去「下载中心」装一个版本</span>';
  }
  const btn = $('#btnLaunch');
  const running = !!(v && v.running);
  btn.disabled = !v || (!running && !state.account);
  btn.classList.toggle('stop', running);
  const useEl = $('#launchIcon') && $('#launchIcon').querySelector('use');
  if (useEl) useEl.setAttribute('href', running ? '#i-power' : '#i-play');
  $('#launchLabel').textContent = running ? '终 止' : '启 动';

  const info = $('#homeInfo');
  if (v) {
    const rows = [
      ['加载器', `${LOADER_LABEL[v.loader] || v.loader}${v.loaderVersion ? ' ' + v.loaderVersion : ''}`],
      ['Minecraft', v.mcVersion],
      ['需要 Java', v.javaMajor + '+'],
      ['版本隔离', v.isolated ? '开启' : '关闭'],
      ['累计游玩', v.playTimeSec ? Math.round(v.playTimeSec / 60) + ' 分钟' : '还没玩过'],
    ];
    info.innerHTML = rows
      .map((r) => `<div class="kv-row"><span>${esc(r[0])}</span><span>${esc(r[1])}</span></div>`)
      .join('');
  } else {
    info.innerHTML = `<div class="kv-row"><span>游戏目录</span><span>${esc(state.settings.gameDir || '')}</span></div>`;
  }
}

$('#homeVersionSelect').addEventListener('change', (e) => {
  if (!e.target.value) return;
  state.selected = e.target.value;
  saveSelected();
  renderHome();
  renderVersions();
  syncModFilters();
});

function saveSelected() {
  api('/api/settings', { body: { selectedVersion: state.selected } }).catch(() => {});
}

$('#btnLaunch').addEventListener('click', async () => {
  if (!state.selected) return toast('先选一个版本', true);

  const cur = state.versions.find((x) => x.id === state.selected);
  if (cur && cur.running) {
    if (!confirm(`强制结束「${cur.id}」？\n未保存的游戏进度会丢失。`)) return;
    try {
      await api('/api/kill', { body: { versionId: state.selected } });
      toast('已发送终止指令');
      setTimeout(() => refresh().catch(() => {}), 700);
    } catch (e) {
      toast(e.message, true);
    }
    return;
  }

  if (!state.account) return toast('先登录账号', true);
  try {
    const r = await api('/api/launch', { body: { versionId: state.selected } });
    state.currentTaskId = r.taskId;
    $('#progressWrap').hidden = false;
    $('#progressBar').style.width = '0%';
    $('#progressStage').textContent = '准备启动';
    $('#progressPct').textContent = '0%';
    appendLog('=== 开始启动 ' + state.selected + ' ===');
  } catch (e) {
    toast(e.message, true);
  }
});

/* ---------------- 版本管理 ---------------- */

function renderVersions() {
  const t = $('#versionTable');
  if (!state.versions.length) {
    t.innerHTML = '<div class="empty">没有已安装的版本</div>';
    return;
  }
  t.innerHTML =
    `<div class="thead"><div>版本</div><div>加载器</div><div>隔离</div><div>操作</div></div>` +
    state.versions
      .map(
        (v) => `
    <div class="trow">
      <div>
        <div class="row-title">${esc(v.id)} ${v.running ? '<span class="badge ok">运行中</span>' : ''}</div>
        <div class="row-sub">MC ${esc(v.mcVersion)} · Java ${v.javaMajor}+ · ${v.playTimeSec ? '玩了 ' + Math.round(v.playTimeSec / 60) + ' 分钟' : '未玩过'}</div>
      </div>
      <div><span class="badge ${v.loader}">${LOADER_LABEL[v.loader] || v.loader}</span></div>
      <div><label class="check"><input type="checkbox" data-iso="${esc(v.id)}" ${v.isolated ? 'checked' : ''}/></label></div>
      <div class="row-actions">
        <button class="btn mini" data-run="${esc(v.id)}">启动</button>
        <button class="btn mini" data-dir="${esc(v.id)}">目录</button>
        <button class="btn mini danger" data-del="${esc(v.id)}">删除</button>
      </div>
    </div>`
      )
      .join('');

  $$('#versionTable [data-run]').forEach((b) =>
    b.addEventListener('click', async () => {
      state.selected = b.dataset.run;
      saveSelected();
      await refresh();
      $('#btnLaunch').click();
      goto('home');
    })
  );
  $$('#versionTable [data-dir]').forEach((b) =>
    b.addEventListener('click', () => api(`/api/version/${encodeURIComponent(b.dataset.dir)}/reveal`, { body: {} }).catch((e) => toast(e.message, true)))
  );
  $$('#versionTable [data-del]').forEach((b) =>
    b.addEventListener('click', async () => {
      const id = b.dataset.del;
      if (!confirm(`确定删除版本「${id}」？\n会删除该版本目录（含 mods/存档，如果开了隔离）。`)) return;
      try {
        await api(`/api/version/${encodeURIComponent(id)}/delete`, { body: {} });
        toast('已删除');
        await refresh();
      } catch (e) {
        toast(e.message, true);
      }
    })
  );
  $$('#versionTable [data-iso]').forEach((c) =>
    c.addEventListener('change', async () => {
      try {
        await api(`/api/version/${encodeURIComponent(c.dataset.iso)}/meta`, { body: { isolated: c.checked } });
        toast(c.checked ? '已开启版本隔离（mods/存档独立）' : '已关闭隔离（用公共 .minecraft）');
        await refresh();
      } catch (e) {
        toast(e.message, true);
        c.checked = !c.checked;
      }
    })
  );
}

/* ---------------- 下载：原版 ---------------- */

async function loadManifest(force = false) {
  $('#vanillaList').innerHTML = '<div class="empty">正在获取版本列表……</div>';
  try {
    const data = await api('/api/manifest' + (force ? '?force=1' : ''));
    state.manifest = data.versions;
    renderVanilla();
    fillVersionSelects();
  } catch (e) {
    $('#vanillaList').innerHTML = `<div class="empty">获取失败：${esc(e.message)}<br/>点这里重试 <button class="link" id="retryMan">重试</button></div>`;
    const r = $('#retryMan');
    if (r) r.addEventListener('click', () => loadManifest(true));
  }
}

function renderVanilla() {
  const q = ($('#verFilter').value || '').trim().toLowerCase();
  const type = state.manifestType;
  const installed = new Set(state.versions.map((v) => v.mcVersion));
  let list = state.manifest.filter((v) => (type === 'all' ? true : v.type === type));
  if (q) list = list.filter((v) => v.id.toLowerCase().includes(q));
  list = list.slice(0, 300);

  const box = $('#vanillaList');
  if (!list.length) {
    box.innerHTML = '<div class="empty">没有匹配的版本</div>';
    return;
  }
  box.innerHTML = list
    .map(
      (v) => `
    <div class="row">
      <div class="row-main">
        <div class="row-title">${esc(v.id)}
          ${v.type === 'release' ? '<span class="badge">正式版</span>' : v.type === 'snapshot' ? '<span class="badge">快照</span>' : `<span class="badge">${esc(v.type)}</span>`}
          ${installed.has(v.id) ? '<span class="badge ok">已安装</span>' : ''}
        </div>
        <div class="row-sub">${new Date(v.releaseTime).toLocaleDateString('zh-CN')}</div>
      </div>
      <div class="row-actions">
        <button class="btn mini primary" data-install="${esc(v.id)}">安装</button>
      </div>
    </div>`
    )
    .join('');

  $$('#vanillaList [data-install]').forEach((b) =>
    b.addEventListener('click', async () => {
      const id = b.dataset.install;
      const fabric = $('#withFabric').checked;
      b.disabled = true;
      b.textContent = '安装中…';
      try {
        const r = await api('/api/install', { body: { versionId: id, loader: fabric ? 'fabric' : 'vanilla' } });
        state.currentTaskId = r.taskId;
        $('#progressWrap').hidden = false;
        goto('home');
        appendLog(`=== 开始安装 ${id}${fabric ? ' + Fabric' : ''} ===`);
        toast(`开始安装 ${id}`);
      } catch (e) {
        toast(e.message, true);
        b.disabled = false;
        b.textContent = '安装';
      }
    })
  );
}

$('#verFilter').addEventListener('input', renderVanilla);
$('#verTypeSeg').addEventListener('click', (e) => {
  const b = e.target.closest('.seg-item');
  if (!b) return;
  $$('#verTypeSeg .seg-item').forEach((x) => x.classList.toggle('active', x === b));
  state.manifestType = b.dataset.type;
  renderVanilla();
});

/* ---------------- 下载：模组 ---------------- */

function currentVersionMeta() {
  return state.versions.find((v) => v.id === state.selected) || null;
}

function defaultGameVersion() {
  const v = currentVersionMeta();
  if (v) return v.mcVersion;
  const first = state.manifest.find((m) => m.type === 'release');
  return first ? first.id : '';
}

/** 填充「游戏版本」「装到哪个版本」两个下拉 */
function fillVersionSelects() {
  const sel = $('#modGameVer');
  if (!sel) return;

  const installed = [...new Set(state.versions.map((v) => v.mcVersion).filter(Boolean))];
  const releases = state.manifest.filter((v) => v.type === 'release').map((v) => v.id);
  // 已装的和官方清单合并后统一按版本号倒序，否则「已装的」会堆在最前面，
  // 把 1.18.2 这种重复项在清单段里去掉，看起来就像少了一个版本
  const all = [...new Set([...installed, ...releases])].sort(cmpMcStr).reverse();
  const prev = sel.value;

  if (!all.length) {
    sel.innerHTML = '<option value="">（版本列表还没加载）</option>';
  } else {
    sel.innerHTML = all
      .map((id) => `<option value="${esc(id)}">${esc(id)}${installed.includes(id) ? ' （已装）' : ''}</option>`)
      .join('');
    sel.value = prev && all.includes(prev) ? prev : defaultGameVersion() || all[0];
  }

  const t = $('#modTarget');
  if (!t) return;
  const prevT = t.value;
  t.innerHTML = state.versions.length
    ? state.versions.map((v) => `<option value="${esc(v.id)}">${esc(v.id)} · ${LOADER_LABEL[v.loader] || v.loader}</option>`).join('')
    : '<option value="">（还没有装任何版本）</option>';
  if (prevT && state.versions.some((v) => v.id === prevT)) t.value = prevT;
  else if (state.selected && state.versions.some((v) => v.id === state.selected)) t.value = state.selected;

  for (const id of ['#rpGameVer', '#shGameVer']) {
    const el = $(id);
    if (!el) continue;
    const prevGv = el.value;
    el.innerHTML = all.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
    el.value = prevGv && all.includes(prevGv) ? prevGv : defaultGameVersion() || all[0] || '';
  }
}

function syncModFilters() {
  fillVersionSelects();
  const v = state.versions.find((x) => x.id === $('#modTarget').value) || currentVersionMeta();
  const loaderSel = $('#modLoader');
  if (v && v.loader !== 'vanilla' && v.loader !== 'modpack') loaderSel.value = v.loader;
  $('#modHint').textContent = v
    ? `装到「${v.id}」的 mods 目录；上面筛的是搜索结果要匹配的游戏版本`
    : '还没有选中版本，先在上面「装到哪个版本」里选一个';
}

$('#modTarget').addEventListener('change', (e) => {
  const id = e.target.value;
  if (!id) return;
  state.selected = id;
  saveSelected();
  renderHome();
  renderVersions();
  syncModFilters();
});

async function searchMods() {
  const box = $('#modList');
  box.innerHTML = '<div class="empty">搜索中……</div>';
  const q = new URLSearchParams({
    q: $('#modQuery').value || '',
    type: 'mod',
    gv: $('#modGameVer').value || '',
    loader: $('#modLoader').value || '',
    limit: 20,
  });
  try {
    const data = await api('/api/modrinth/search?' + q.toString());
    const target = state.versions.find((v) => v.id === $('#modTarget').value) || currentVersionMeta();
    const mapped = data.cnTerms || [];
    $('#modHint').textContent = mapped.length
      ? `中文匹配：${mapped
          .slice(0, 3)
          .map((t) => `${t.cn} → ${t.en}`)
          .join('　')}${data.cnSource === 'mcmod' ? '（来自 MC百科，已存入本地表）' : '（来自本地词表）'}`
      : target
        ? `装到「${target.id}」的 mods 目录`
        : '先在上面选一个「装到哪个版本」';

    if (data.relaxed) {
      $('#modHint').textContent += `　·　按 ${$('#modGameVer').value} 筛完没有结果，已放开版本限制，安装前请确认支持你的版本`;
    }

    if (!data.hits.length && !(data.mcmod || []).length) {
      box.innerHTML = '<div class="empty">没有结果，换个关键词试试</div>';
      return;
    }

    box.innerHTML = data.hits
      .map(
        (h) => `
      <div class="row clickable" data-mod="${esc(h.id)}" data-title="${esc(h.title)}" data-cn="${esc(h.cnName || '')}" data-src="${esc(h.source || 'modrinth')}">
        <img class="icon-img" src="${esc(h.icon || '')}" onerror="this.style.visibility='hidden'"/>
        <div class="row-main">
          <div class="row-title">${nameHtml(h)}<span class="badge ${h.source === 'curseforge' ? 'forge' : ''}">${h.source === 'curseforge' ? 'CF' : 'Modrinth'}</span></div>
          <div class="row-sub">${esc(h.description || '')}</div>
          <div class="row-sub">↓ ${fmtNum(h.downloads)} · ${esc((h.categories || []).slice(0, 4).join(' / '))}</div>
        </div>
        <div class="row-arrow">›</div>
      </div>`
      )
      .join('');

    $$('#modList .row[data-mod]').forEach((row) =>
      row.addEventListener('click', () => {
        if (!target) return toast('先在上面选一个「装到哪个版本」', true);
        pickVersion(row.dataset.mod, row.dataset.title, {
          kind: 'mod',
          cnName: row.dataset.cn,
          source: row.dataset.src,
          gameVersion: $('#modGameVer').value,
          loader: $('#modLoader').value,
        });
      })
    );

    // MC百科里查到、但 Modrinth / CF 上没有的，单独列一段
    const mc = data.mcmod || [];
    if (mc.length) {
      box.insertAdjacentHTML(
        'beforeend',
        `<div class="mcmod-sec">
          <div class="mcmod-head">MC百科里还有这些（点开去百科看，这里不能直接装）</div>
          ${mc
            .map(
              (x) => `
          <div class="row clickable" data-mcmod="${esc(x.url)}">
            <div class="row-main">
              <div class="row-title">${esc(cleanCnName(x.cn) || x.en)}${
                x.en ? `<span class="title-alt">${esc(x.en)}</span>` : ''
              }<span class="badge">MC百科</span></div>
              <div class="row-sub">百科条目，可以点开看详情和下载地址</div>
            </div>
            <div class="row-arrow">↗</div>
          </div>`
            )
            .join('')}
        </div>`
      );
      $$('#modList [data-mcmod]').forEach((r) =>
        r.addEventListener('click', () => window.open(r.dataset.mcmod, '_blank'))
      );
    }
  } catch (e) {
    box.innerHTML = `<div class="empty">搜索失败：${esc(e.message)}</div>`;
  }
}

$('#btnModSearch').addEventListener('click', searchMods);
$('#modQuery').addEventListener('keydown', (e) => e.key === 'Enter' && searchMods());

/* ---------------- 下载：整合包 ---------------- */

async function searchPacks() {
  const box = $('#packList');
  box.innerHTML = '<div class="empty">搜索中……</div>';
  const q = new URLSearchParams({ q: $('#packQuery').value || '', type: 'modpack', limit: 20 });
  try {
    const data = await api('/api/modrinth/search?' + q.toString());
    if (!data.hits.length) {
      box.innerHTML = '<div class="empty">没有结果</div>';
      return;
    }
    box.innerHTML = data.hits
      .map(
        (h) => `
      <div class="row">
        <img class="icon-img" src="${esc(h.icon || '')}" onerror="this.style.visibility='hidden'"/>
        <div class="row-main">
          <div class="row-title">${esc(h.title)}</div>
          <div class="row-sub">${esc(h.description || '')}</div>
          <div class="row-sub">↓ ${fmtNum(h.downloads)} · ${esc((h.versions || []).slice(-1)[0] || '')}</div>
        </div>
        <div class="row-actions">
          <button class="btn mini primary" data-pack="${esc(h.id)}" data-title="${esc(h.title)}" data-desc="${esc(h.description || '')}">安装</button>
        </div>
      </div>`
      )
      .join('');

    $$('#packList [data-pack]').forEach((b) =>
      b.addEventListener('click', async () => {
        const title = b.dataset.title;
        if (!confirm(`安装整合包「${title}」？\n\n会作为独立实例安装，包含它自己的 mods 和配置。\n体积可能有好几百 MB。`)) return;
        b.disabled = true;
        b.textContent = '安装中…';
        try {
          const r = await api('/api/modpack/install', {
            body: { projectId: b.dataset.pack, title, description: b.dataset.desc },
          });
          state.currentTaskId = r.taskId;
          $('#progressWrap').hidden = false;
          toast(`开始安装整合包 ${title}`);
          setTimeout(() => goto('home'), 400);
        } catch (e) {
          toast(e.message, true);
          b.disabled = false;
          b.textContent = '安装';
        }
      })
    );
  } catch (e) {
    box.innerHTML = `<div class="empty">搜索失败：${esc(e.message)}</div>`;
  }
}

$('#btnPackSearch').addEventListener('click', searchPacks);
$('#packQuery').addEventListener('keydown', (e) => e.key === 'Enter' && searchPacks());

/* ---------------- 账号 ---------------- */

function renderAccounts() {
  const box = $('#accountList');
  if (!state.accounts.length) {
    box.innerHTML = '<div class="empty">还没有保存的账号</div>';
    return;
  }
  box.innerHTML = state.accounts
    .map(
      (a) => `
    <div class="row">
      <div class="avatar ${a.type}">${esc(a.name.slice(0, 1))}</div>
      <div class="row-main">
        <div class="row-title">${esc(a.name)} ${state.account && state.account.name === a.name ? '<span class="badge ok">当前</span>' : ''}</div>
        <div class="row-sub">${a.type === 'msa' ? '正版（微软）' : '离线'} · ${esc(a.uuid)}</div>
      </div>
      <div class="row-actions">
        <button class="btn mini" data-use="${esc(a.name)}">切换</button>
      </div>
    </div>`
    )
    .join('');
  $$('#accountList [data-use]').forEach((b) =>
    b.addEventListener('click', async () => {
      try {
        await api('/api/auth/switch', { body: { name: b.dataset.use } });
        await refresh();
        toast('已切换账号');
      } catch (e) {
        toast(e.message, true);
      }
    })
  );
}

let deviceTimer = null;

$('#btnMsLogin').addEventListener('click', async () => {
  try {
    const d = await api('/api/auth/device/start', { body: {} });
    $('#deviceBox').hidden = false;
    $('#deviceCode').textContent = d.userCode;
    $('#deviceHint').innerHTML = d.fallback
      ? '⚠ 你配置的应用 ID 用不了（多半是账户类型选成了「仅此组织目录中的账户」），已临时改用公共 ID，授权页会显示成别的启动器名字。功能不受影响。'
      : `等待授权中……（最多 ${Math.round(d.expiresIn / 60)} 分钟）`;
    $('#deviceBox').dataset.code = d.deviceCode;
    $('#deviceBox').dataset.uri = d.verificationUri;
    try {
      await navigator.clipboard.writeText(d.userCode);
      toast('验证码已复制到剪贴板');
    } catch {
      toast('验证码：' + d.userCode);
    }
    api('/api/open', { body: { url: d.verificationUri } }).catch(() => {});

    // 串行轮询：一次设备码只能用一次，setInterval 会让两个请求撞车，
    // 导致"已经登录成功"之后又冒出一个 AADSTS70000。
    if (deviceTimer) clearTimeout(deviceTimer);
    const every = Math.max(3, d.interval || 5) * 1000;
    let stopped = false;

    const tick = async () => {
      if (stopped) return;
      let r;
      try {
        r = await api('/api/auth/device/poll', { body: { deviceCode: d.deviceCode } });
      } catch (e) {
        if (!stopped) deviceTimer = setTimeout(tick, every);
        return;
      }
      if (stopped) return;
      if (r.status === 'pending') {
        deviceTimer = setTimeout(tick, every);
        return;
      }

      stopped = true;
      deviceTimer = null;

      if (r.status === 'ok') {
        $('#deviceHint').textContent = '登录成功：' + r.account.name;
        $('#deviceBox').hidden = true;
        toast('正版登录成功：' + r.account.name);
        await refresh();
      } else if (r.status === 'used') {
        // 大概率是上一次已经成功了，别用红色错误吓人
        $('#deviceHint').textContent = r.message;
        toast('授权码已失效，请重新点一次登录');
      } else {
        $('#deviceHint').textContent = r.message || '失败';
        toast(r.message || '登录失败', true);
      }
    };

    deviceTimer = setTimeout(tick, every);
  } catch (e) {
    toast(e.message, true);
  }
});

$('#btnOpenMs').addEventListener('click', () => {
  const uri = $('#deviceBox').dataset.uri;
  if (uri) api('/api/open', { body: { url: uri } }).catch((e) => toast(e.message, true));
});

$('#btnCopyCode').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('#deviceCode').textContent);
    toast('已复制');
  } catch {
    toast('复制失败，手动记一下', true);
  }
});

$('#btnOffline').addEventListener('click', async () => {
  try {
    const r = await api('/api/auth/offline', { body: { name: $('#offlineName').value } });
    toast('离线登录成功：' + r.account.name);
    await refresh();
  } catch (e) {
    toast(e.message, true);
  }
});

$('#btnLogout').addEventListener('click', async () => {
  await api('/api/auth/logout', { body: {} });
  await refresh();
  toast('已退出');
});

$('#btnClearAccounts').addEventListener('click', async () => {
  if (!confirm('清除全部登录数据？\n\n会删掉本地保存的所有令牌。下次启动游戏要重新登录微软账号。')) return;
  try {
    await api('/api/auth/clear', { body: {} });
    await refresh();
    toast('已清除本地登录数据');
  } catch (e) {
    toast(e.message, true);
  }
});

/* ---------------- 设置 ---------------- */

function renderMemBar(maxMB) {
  const sys = state.system || { totalMB: 8192, usedMB: 2048 };
  const total = Math.max(1, sys.totalMB);
  const usedPct = Math.min(100, (sys.usedMB / total) * 100);
  const gamePct = Math.min(100 - usedPct, (maxMB / total) * 100);
  $('#membarUsed').style.width = usedPct + '%';
  $('#membarGame').style.width = Math.max(0, gamePct) + '%';
  const gb = (n) => (n / 1024).toFixed(1) + ' GB';
  $('#memUsedLabel').textContent = `已用 ${gb(sys.usedMB)} / ${gb(sys.totalMB)}`;
  $('#memGameLabel').textContent = `游戏分配 ${gb(maxMB)}`;
}

function renderSettings() {
  const s = state.settings;
  const auto = s.autoMemory !== false;
  const mem = state.memory || { maxMB: s.maxMemoryMB || 4096, minMB: s.minMemoryMB || 1024 };

  $('#memAuto').checked = auto;
  $('#memCustom').checked = !auto;
  $('#maxMem').disabled = auto;
  $('#minMem').disabled = auto;

  const maxVal = auto ? mem.maxMB : s.maxMemoryMB || 4096;
  $('#maxMem').value = Math.min(32768, Math.max(1024, maxVal));
  $('#maxMemVal').textContent = maxVal + ' MB';
  $('#minMem').value = Math.min(16384, Math.max(512, s.minMemoryMB || 1024));
  $('#minMemVal').textContent = (s.minMemoryMB || 1024) + ' MB';

  renderMemBar(maxVal);

  $('#downloadSource').value = s.downloadSource || 'auto';
  $('#threads').value = s.downloadThreads || 32;
  $('#jvmArgs').value = s.jvmArgs || '';
  $('#clientId').value = s.clientId || '';
  $('#curseforgeKey').value = s.curseforgeKey || '';
  $('#gameDir').value = s.gameDir || '';
  $('#dirHint').textContent = '当前：' + (s.gameDir || '(未设置)');

  $('#memHint').textContent = auto
    ? `自动配置：按物理内存的 16% 推荐（当前 ${mem.maxMB} MB）。整合包跑不动的话切到自定义调大。`
    : '自定义：4~8 GB 的整合包给 6~8 GB，别超过物理内存。';
}

// 内存相关改动即时保存（PCL 的做法：拖完就记住，不用再点保存）
async function saveMemory(patch) {
  try {
    await api('/api/settings', { body: patch });
    await refresh();
  } catch (e) {
    toast(e.message, true);
  }
}

$('#memAuto').addEventListener('change', () => saveMemory({ autoMemory: true }));
$('#memCustom').addEventListener('change', () => saveMemory({ autoMemory: false }));

$('#maxMem').addEventListener('input', (e) => {
  if ($('#maxMem').disabled) return;
  $('#maxMemVal').textContent = e.target.value + ' MB';
  renderMemBar(Number(e.target.value));
});
$('#maxMem').addEventListener('change', () => {
  if ($('#maxMem').disabled) return;
  saveMemory({ maxMemoryMB: Number($('#maxMem').value) });
});

$('#minMem').addEventListener('input', (e) => {
  if ($('#minMem').disabled) return;
  $('#minMemVal').textContent = e.target.value + ' MB';
});
$('#minMem').addEventListener('change', () => {
  if ($('#minMem').disabled) return;
  saveMemory({ minMemoryMB: Number($('#minMem').value) });
});

$('#btnSaveSettings').addEventListener('click', async () => {
  try {
    await api('/api/settings', {
      body: {
        downloadSource: $('#downloadSource').value,
        downloadThreads: Number($('#threads').value),
        jvmArgs: $('#jvmArgs').value,
        clientId: $('#clientId').value,
        curseforgeKey: $('#curseforgeKey').value.trim(),
      },
    });
    toast('已保存');
    await refresh();
  } catch (e) {
    toast(e.message, true);
  }
});

$('#btnSaveDir').addEventListener('click', async () => {
  try {
    await api('/api/settings', { body: { gameDir: $('#gameDir').value } });
    toast('游戏目录已切换');
    await refresh();
  } catch (e) {
    toast(e.message, true);
  }
});

$('#downloadSource').addEventListener('change', async (e) => {
  await api('/api/settings', { body: { downloadSource: e.target.value } });
  toast('下载源已切换');
});

async function loadJava() {
  const sel = $('#javaSelect');
  sel.innerHTML = '<option>扫描中……</option>';
  try {
    const d = await api('/api/java');
    if (!d.list.length) {
      sel.innerHTML = '<option value="">没有找到 Java（点下面按钮下载）</option>';
      $('#javaHint').textContent = '这台机器上没有任何 java.exe。建议先下载 Java 21。';
      return;
    }
    sel.innerHTML =
      '<option value="">自动选择（推荐）</option>' +
      d.list.map((j) => `<option value="${esc(j.path)}" ${d.custom === j.path ? 'selected' : ''}>Java ${j.major} · ${j.vendor} · ${j.bits}位 · ${esc(j.path)}</option>`).join('');
    $('#javaHint').textContent = `找到 ${d.list.length} 个 Java：` + d.list.map((j) => `Java ${j.major}`).join('、');
  } catch (e) {
    sel.innerHTML = '<option>扫描失败</option>';
  }
}

$('#javaSelect').addEventListener('change', async (e) => {
  await api('/api/settings', { body: { javaPath: e.target.value } });
  toast(e.target.value ? '已指定 Java：' + e.target.value : '已改回自动选择');
});

$('#btnRescanJava').addEventListener('click', loadJava);

$('#btnClientCheck').addEventListener('click', async () => {
  const hint = $('#clientCheckHint');
  hint.textContent = '检查中……';
  try {
    await api('/api/settings', { body: { clientId: $('#clientId').value.trim() } });
    const d = await api('/api/auth/client-check', { body: {} });
    if (d.ok) {
      hint.innerHTML = `✅ 微软侧配置正确。${d.note ? '<br/>' + esc(d.note) : ''}`;
    } else if (d.fallback) {
      hint.innerHTML = `⚠ 你的 ID 用不了，现在会退回公共 ID（显示成别的启动器名字）。<br/>原因：${esc(d.reason || '未知')}<br/>去门户把「受支持的账户类型」改成「个人 Microsoft 账户」。`;
    } else {
      hint.innerHTML = `❌ 失败：${esc(d.error || '未知错误')}`;
    }
  } catch (e) {
    hint.textContent = '检查失败：' + e.message;
  }
});

$('#btnCfProbe').addEventListener('click', async () => {
  const hint = $('#cfHint');
  hint.textContent = '正在保存并测试……';
  try {
    await api('/api/settings', { body: { curseforgeKey: $('#curseforgeKey').value.trim() } });
    const d = await api('/api/cf/probe');
    const lines = d.endpoints.map((e) => `${e.name}${e.ok ? ' ✅' : ' ❌(' + (e.status || '?') + ')'}`);
    hint.innerHTML = `端点：${esc(lines.join('　'))}<br/>${
      d.searchUsable
        ? '搜索接口正常，CF 结果已经会出现在搜索里了。'
        : '搜索接口还没生效（新 key 常见，等几分钟到几小时），其余接口已经能用。'
    }`;
  } catch (e) {
    hint.textContent = '测试失败：' + e.message;
  }
});

$$('[data-java]').forEach((b) =>
  b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      const r = await api('/api/java/install', { body: { major: Number(b.dataset.java) } });
      state.currentTaskId = r.taskId;
      $('#progressWrap').hidden = false;
      toast(`开始下载 Java ${b.dataset.java}`);
      setTimeout(() => goto('home'), 400);
    } catch (e) {
      toast(e.message, true);
    } finally {
      b.disabled = false;
    }
  })
);

/* ---------------- 日志 + 进度 ---------------- */

const logLines = [];
function appendLog(line) {
  logLines.push(line);
  if (logLines.length > 600) logLines.shift();
  const box = $('#logBox');
  box.textContent = logLines.join('\n');
  box.scrollTop = box.scrollHeight;
}

$('#btnClearLog').addEventListener('click', () => {
  logLines.length = 0;
  $('#logBox').textContent = '';
});
$('#btnCopyLog').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(logLines.join('\n'));
    toast('日志已复制');
  } catch {
    toast('复制失败', true);
  }
});

function updateTask(t) {
  if (state.currentTaskId && t.id !== state.currentTaskId) return;
  if (!state.currentTaskId) state.currentTaskId = t.id;
  $('#progressWrap').hidden = false;
  $('#progressBar').style.width = Math.min(100, t.percent || 0) + '%';
  $('#progressStage').textContent = t.stage || t.title;
  $('#progressPct').textContent = (t.percent || 0) + '%';
}

/* ---------------- SSE ---------------- */

function connectSSE() {
  const es = new EventSource('/api/events');
  es.addEventListener('hello', (e) => {
    try {
      const d = JSON.parse(e.data);
      state.settings = d.settings;
    } catch {}
  });
  es.addEventListener('task', (e) => {
    try {
      const t = JSON.parse(e.data);
      updateTask(t);
      if (t.status === 'done' || t.status === 'error') {
        if (t.status === 'error') toast(`${t.title} 失败：${t.error}`, true);
        else toast(`${t.title} 完成`);
        refresh().catch(() => {});
      }
    } catch {}
  });
  es.addEventListener('log', (e) => {
    try {
      const d = JSON.parse(e.data);
      if (state.currentTaskId && d.id !== state.currentTaskId) return;
      appendLog(d.line);
    } catch {}
  });
  es.addEventListener('state', () => refresh().catch(() => {}));
  es.onerror = () => {
    /* EventSource 自己会重连 */
  };
}

/* ---------------- 启动 ---------------- */

(async function main() {
  try {
    await refresh();
  } catch (e) {
    toast('连接后端失败：' + e.message, true);
  }
  connectSSE();
  syncModFilters();
  if (!state.settings.maxMemoryMB) renderSettings();
  if (state.versions.length === 0) {
    $('#logBox').textContent = '还没有版本。去「下载中心」装一个，或者装个整合包。';
  }
})();

$('#dlTabs').addEventListener('click', (e) => {
  const b = e.target.closest('.tab');
  if (!b) return;
  $$('#dlTabs .tab').forEach((x) => x.classList.toggle('active', x === b));
  $$('.tab-page').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + b.dataset.tab));
  if (b.dataset.tab === 'mod') syncModFilters();
  if (b.dataset.tab === 'vanilla' && !state.manifest.length) loadManifest();
});

/* ================= 弹窗 ================= */

function openModal(title, html) {
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = html;
  $('#modal').hidden = false;
}

function closeModal() {
  $('#modal').hidden = true;
  $('#modalBody').innerHTML = '';
}

$('#modalClose').addEventListener('click', closeModal);
$('#modalMask').addEventListener('click', closeModal);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
});

/* ================= 模组管理 ================= */

function fillModsVersionSelect() {
  const sel = $('#modsVersion');
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = state.versions.length
    ? state.versions.map((v) => `<option value="${esc(v.id)}">${esc(v.id)} · ${LOADER_LABEL[v.loader] || v.loader}</option>`).join('')
    : '<option value="">（还没有版本）</option>';
  if (prev && state.versions.some((v) => v.id === prev)) sel.value = prev;
  else if (state.selected && state.versions.some((v) => v.id === state.selected)) sel.value = state.selected;
}

async function loadMods() {
  const ver = $('#modsVersion').value;
  if (!ver) {
    $('#modsList').innerHTML = '<div class="empty">还没有安装任何版本</div>';
    return;
  }
  $('#modsList').innerHTML = '<div class="empty">读取中……</div>';
  try {
    state.modsData = await api('/api/mods?version=' + encodeURIComponent(ver));
    renderMods();
  } catch (e) {
    $('#modsList').innerHTML = `<div class="empty">读取失败：${esc(e.message)}</div>`;
  }
}

function renderMods() {
  const d = state.modsData;
  if (!d) return;
  const q = ($('#modsFilter').value || '').trim().toLowerCase();
  const showDisabled = $('#modsShowDisabled').checked;
  let list = d.mods || [];
  const total = list.length;
  if (!showDisabled) list = list.filter((m) => m.enabled);
  if (q) list = list.filter((m) => `${m.name} ${m.file} ${m.id}`.toLowerCase().includes(q));

  $('#modsCount').textContent = `模组列表（${list.length}${q || !showDisabled ? '/' + total : ''}）`;
  $('#modsHint').textContent = d.exists
    ? `目录：${d.dir}`
    : `这个实例还没有 mods 目录，第一次装模组会自动建：${d.dir}`;

  if (!list.length) {
    $('#modsList').innerHTML = `<div class="empty">${total ? '没有匹配的模组' : '还没装模组'}</div>`;
    return;
  }

  $('#modsList').innerHTML = list
    .map(
      (m) => `
    <div class="row">
      <div class="row-main">
        <div class="row-title">${esc(m.name)}
          ${m.enabled ? '' : '<span class="badge">已禁用</span>'}
          ${m.loader ? `<span class="badge ${esc(m.loader)}">${LOADER_LABEL[m.loader] || esc(m.loader)}</span>` : ''}
        </div>
        <div class="row-sub">${esc(m.file)}${m.version ? ' · v' + esc(m.version) : ''} · ${fmtSize(m.size)}</div>
      </div>
      <div class="row-actions">
        <button class="btn mini" data-mod-toggle="${esc(m.file)}" data-en="${m.enabled ? '0' : '1'}">${m.enabled ? '禁用' : '启用'}</button>
        <button class="btn mini danger" data-mod-del="${esc(m.file)}">删除</button>
      </div>
    </div>`
    )
    .join('');

  $$('#modsList [data-mod-toggle]').forEach((b) =>
    b.addEventListener('click', async () => {
      try {
        await api('/api/mods/toggle', {
          body: { version: $('#modsVersion').value, file: b.dataset.modToggle, enabled: b.dataset.en === '1' },
        });
        await loadMods();
        toast(b.dataset.en === '1' ? '已启用' : '已禁用');
      } catch (e) {
        toast(e.message, true);
      }
    })
  );

  $$('#modsList [data-mod-del]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!confirm(`删除 ${b.dataset.modDel}？\n文件会直接从 mods 目录删掉。`)) return;
      try {
        await api('/api/mods/delete', { body: { version: $('#modsVersion').value, file: b.dataset.modDel } });
        await loadMods();
        toast('已删除');
      } catch (e) {
        toast(e.message, true);
      }
    })
  );
}

$('#modsVersion').addEventListener('change', loadMods);
$('#modsFilter').addEventListener('input', renderMods);
$('#modsShowDisabled').addEventListener('change', renderMods);
$('#btnModsRefresh').addEventListener('click', loadMods);
$('#btnModsDir').addEventListener('click', () => {
  const v = $('#modsVersion').value;
  if (!v) return;
  api(`/api/version/${encodeURIComponent(v)}/reveal?sub=mods`, { body: {} }).catch((e) => toast(e.message, true));
});

/* ================= 项目详情页 ================= */

let detailState = null;
const detailStack = []; // 点前置进来时，记住上一层，返回能退回去

function showDetail(on) {
  $('#page-download').classList.toggle('detail-open', on);
  $('#dlDetail').hidden = !on;
  if (on) window.scrollTo({ top: 0 });
}

$('#dlBack').addEventListener('click', () => {
  if (detailStack.length) {
    detailState = detailStack.pop();
    renderDetail();
    return;
  }
  showDetail(false);
  detailState = null;
});

/** 取大版本号："1.21.1" → "1.21"，"26.3-rc-2" → "26.3" */
function majorOf(v) {
  const m = /^(\d+)\.(\d+)/.exec(String(v || ''));
  return m ? `${m[1]}.${m[2]}` : String(v || '');
}

function cmpMcStr(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/** 详情页默认停在「全部」：玩家常常记不住某个模组支持哪些版本，先全看一遍再自己收窄 */
function pickTab() {
  return '全部';
}

async function pickVersion(projectId, title, opts) {
  opts = opts || {};
  showDetail(true);
  $('#detailHead').innerHTML = '<div class="empty">读取项目信息……</div>';
  $('#detailVersions').innerHTML = '';
  try {
    const src = opts.source || 'modrinth';
    if (detailState) detailStack.push(detailState);
    const d = await api(`/api/project?project=${encodeURIComponent(projectId)}&source=${encodeURIComponent(src)}`);
    detailState = {
      data: d,
      kind: opts.kind || 'mod',
      cnName: opts.cnName || '',
      source: src,
      tab: pickTab(),
      wantGv: opts.gameVersion || '',
      justOpened: true,
    };
    renderDetail();
  } catch (e) {
    $('#detailHead').innerHTML = `<div class="empty">读取失败：${esc(e.message)}</div>`;
  }
}

function renderDetail() {
  const st = detailState;
  if (!st) return;
  const { data, kind, cnName, tab, source } = st;
  const p = data.project;
  const target = state.versions.find((v) => v.id === ($('#modTarget').value || state.selected)) || {};

  const cats = (p.categories || []).slice(0, 5).join(' · ');
  const loaders = (p.loaders || []).join(' / ');

  $('#detailHead').innerHTML = `
    <div class="detail-top">
      <img class="detail-icon" src="${esc(p.icon || '')}" onerror="this.style.visibility='hidden'"/>
      <div style="flex:1;min-width:0">
        <div class="detail-title">${esc(cnName ? cleanCnName(cnName) : p.title)}${
          cnName ? ` <span style="font-weight:400;color:var(--muted);font-size:14px">${esc(p.title)}</span>` : ''
        }</div>
        <div class="detail-sub">${esc(cats)}${loaders ? '　·　' + esc(loaders) : ''}</div>
        <div class="detail-sub">↓ ${fmtNum(p.downloads)}　·　更新于 ${ago(Date.parse(p.updated))}　·　${data.versions.length} 个文件</div>
        <div class="detail-desc">${esc(p.description || '')}</div>
        <div class="detail-actions">
          <button class="btn" data-open-cf>转到 CurseForge</button>
          <button class="btn" data-open-mcmod>转到 MC百科</button>
          <button class="btn" data-copy-name>复制名称</button>
        </div>
      </div>
    </div>`;

  $('#detailHead').querySelector('[data-open-cf]').addEventListener('click', () => {
    if (source === 'curseforge' && p.sourceUrl) {
      window.open(p.sourceUrl, '_blank');
      return;
    }
    const q = encodeURIComponent(p.slug || p.title);
    window.open(`https://www.curseforge.com/minecraft/search?search=${q}`, '_blank');
  });
  $('#detailHead').querySelector('[data-open-mcmod]').addEventListener('click', () => {
    const q = encodeURIComponent(cnName || p.title);
    window.open(`https://search.mcmod.cn/s?key=${q}`, '_blank');
  });
  $('#detailHead').querySelector('[data-copy-name]').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(p.title);
      toast('已复制：' + p.title);
    } catch {
      toast(p.title);
    }
  });

  // tab 只到「大版本」：1.21 / 1.20 / 1.19 / 1.18 …
  const majors = [];
  for (const g of data.mcVersions || []) {
    const m = majorOf(g);
    if (!majors.includes(m)) majors.push(m);
  }
  const tabs = ['全部', ...majors];

  // 组内再按「完整版本 + 加载器」拆开：1.18.2 / Forge 1.18.2 / NeoForge 1.18.2 …
  const groups = new Map();
  for (const f of data.versions || []) {
    const mcs = (f.gameVersions || []).filter((g) => /^\d/.test(g));
    const loaders = (f.loaders || []).length ? f.loaders : [''];
    for (const mc of mcs) {
      if (tab !== '全部' && majorOf(mc) !== tab) continue;
      for (const ld of loaders) {
        const key = `${mc}|${ld}`;
        if (!groups.has(key)) groups.set(key, { key, mc, ld, files: [] });
        groups.get(key).files.push(f);
      }
    }
  }
  const ordered = [...groups.values()].sort((a, b) => cmpMcStr(b.mc, a.mc) || String(a.ld).localeCompare(String(b.ld)));

  if (!st.open) {
    st.open = new Set();
    const want = target.mcVersion || st.wantGv;
    const first = ordered.find((g) => g.mc === want);
    if (first) st.open.add(first.key);
  }

  const totalFiles = new Set(ordered.flatMap((g) => g.files.map((f) => f.id))).size;
  const note =
    tab !== '全部' && st.wantGv && majorOf(st.wantGv) === tab && tab !== st.wantGv
      ? `　·　按 ${esc(st.wantGv)} 归到 ${esc(tab)}`
      : target.mcVersion && tab !== '全部' && majorOf(target.mcVersion) !== tab
        ? `　·　当前实例是 ${esc(target.mcVersion)}`
        : '';

  const rowOf = (f) => `
    <div class="file-row">
      <div class="file-main">
        <div class="file-name">${esc(f.versionNumber)}${f.type !== 'release' ? ` <span class="badge">${esc(f.type)}</span>` : ''}</div>
        <div class="file-meta">${new Date(f.datePublished).toLocaleDateString('zh-CN')} · ↓${fmtNum(f.downloads || 0)}</div>
      </div>
      <button class="btn mini primary" data-install-file="${esc(f.id)}">安装</button>
    </div>`;

  // 前置资源：只展示、可点进去自己选版本（不偷偷替玩家决定）
  const deps = data.depProjects || [];
  const depBlock = deps.length
    ? `<div class="dep-sec">
        <div class="dep-title">前置资源（点进去自己选版本）</div>
        ${deps
          .map(
            (d) => `
          <div class="row clickable" data-dep="${esc(d.id)}" data-dep-title="${esc(d.title)}" data-dep-src="${esc(d.source || 'modrinth')}">
            <img class="icon-img" src="${esc(d.icon || '')}" onerror="this.style.visibility='hidden'"/>
            <div class="row-main">
              <div class="row-title">${esc(d.title)}</div>
              <div class="row-sub">${esc(String(d.description || '').slice(0, 90))}</div>
            </div>
            <div class="row-arrow">›</div>
          </div>`
          )
          .join('')}
      </div>`
    : '';

  $('#detailVersions').innerHTML = `
    ${depBlock}
    <div class="vtabs">${tabs
      .map((t) => `<button class="vtab${t === tab ? ' active' : ''}" data-vtab="${esc(t)}">${esc(t)}</button>`)
      .join('')}</div>
    <div class="hint">${ordered.length} 组 · ${totalFiles} 个文件${note}</div>
    <div style="margin-top:10px">
      ${
        ordered.length
          ? ordered
              .map((g) => {
                const ldLabel = g.ld ? `${LOADER_LABEL[g.ld] || g.ld} ` : '';
                const hit = g.mc === (target.mcVersion || st.wantGv);
                return `
        <div class="vgroup${st.open.has(g.key) ? ' open' : ''}" data-group="${esc(g.key)}">
          <div class="vgroup-head">
            <span class="vgroup-title">${esc(ldLabel)}${esc(g.mc)}${hit ? ' <span class="badge ok">所选版本</span>' : ''}</span>
            <span class="vgroup-count">${g.files.length} 个文件</span>
            <span class="vgroup-chev">▾</span>
          </div>
          <div class="vgroup-body">${g.files.map(rowOf).join('')}</div>
        </div>`;
              })
              .join('')
          : '<div class="empty">这个版本下没有文件</div>'
      }
    </div>`;

  $$('#detailVersions [data-vtab]').forEach((b) =>
    b.addEventListener('click', () => {
      detailState.tab = b.dataset.vtab;
      detailState.open = null;
      renderDetail();
    })
  );

  $$('#detailVersions .vgroup-head').forEach((h) =>
    h.addEventListener('click', () => {
      const box = h.parentElement;
      const key = box.dataset.group;
      box.classList.toggle('open');
      if (box.classList.contains('open')) detailState.open.add(key);
      else detailState.open.delete(key);
    })
  );

  $$('#detailVersions [data-install-file]').forEach((b) =>
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      startInstall(p.id, b.dataset.installFile, p.title, kind, source);
    })
  );

  $$('#detailVersions [data-dep]').forEach((row) =>
    row.addEventListener('click', () =>
      pickVersion(row.dataset.dep, row.dataset.depTitle, {
        kind,
        source: row.dataset.depSrc,
        gameVersion: st.wantGv,
        cnName: '',
      })
    )
  );

  // 默认停在「全部」时，把命中当前实例版本的那一组滚到视野中间
  if (st.justOpened) {
    st.justOpened = false;
    const openGroup = $('#detailVersions .vgroup.open');
    if (openGroup && openGroup.scrollIntoView) {
      setTimeout(() => openGroup.scrollIntoView({ block: 'center', behavior: 'smooth' }), 80);
    }
  }
}


async function startInstall(projectId, versionId, title, kind, source) {
  const target = $('#modTarget').value || state.selected;
  if (!target) return toast('先选一个实例', true);
  const meta = state.versions.find((v) => v.id === target) || {};
  try {
    const r = await api('/api/modrinth/install', {
      body: {
        projectId,
        versionId,
        targetVersionId: target,
        gameVersion: meta.mcVersion,
        loader: meta.loader,
        kind,
        source: source || 'modrinth',
        modId: source === 'curseforge' ? projectId : undefined,
        fileId: source === 'curseforge' ? versionId : undefined,
      },
    });
    state.currentTaskId = r.taskId;
    $('#progressWrap').hidden = false;
    toast(`开始安装「${title}」到 ${target}`);
    setTimeout(() => goto('home'), 400);
  } catch (e) {
    toast(e.message, true);
  }
}

/* ================= 资源包 / 光影 ================= */

async function searchAsset(kind) {
  const isRp = kind === 'resourcepack';
  const box = $(isRp ? '#rpList' : '#shList');
  const q = $(isRp ? '#rpQuery' : '#shQuery').value || '';
  const gv = $(isRp ? '#rpGameVer' : '#shGameVer').value || '';
  $(isRp ? '#rpHint' : '#shHint').textContent = `搜索结果会装到「${state.selected || '未选中'}」实例里`;
  box.innerHTML = '<div class="empty">搜索中……</div>';
  try {
    const params = new URLSearchParams({ q, type: kind, gv, limit: 20 });
    const data = await api('/api/modrinth/search?' + params.toString());
    if (!data.hits.length) {
      box.innerHTML = '<div class="empty">没有结果，换个关键词</div>';
      return;
    }
    box.innerHTML = data.hits
      .map(
        (h) => `
      <div class="row clickable" data-asset="${esc(h.id)}" data-title="${esc(h.title)}">
        <img class="icon-img" src="${esc(h.icon || '')}" onerror="this.style.visibility='hidden'"/>
        <div class="row-main">
          <div class="row-title">${nameHtml(h)}<span class="badge ${h.source === 'curseforge' ? 'forge' : ''}">${h.source === 'curseforge' ? 'CF' : 'Modrinth'}</span></div>
          <div class="row-sub">${esc(h.description || '')}</div>
          <div class="row-sub">↓ ${fmtNum(h.downloads)} · ${esc((h.categories || []).slice(0, 4).join(' / '))}</div>
        </div>
        <div class="row-arrow">›</div>
      </div>`
      )
      .join('');

    $$('#' + box.id + ' .row[data-asset]').forEach((row) =>
      row.addEventListener('click', () => {
        pickVersion(row.dataset.asset, row.dataset.title, {
          kind,
          cnName: '',
          source: row.dataset.src || 'modrinth',
          gameVersion: gv,
          loader: null,
        });
      })
    );
  } catch (e) {
    box.innerHTML = `<div class="empty">搜索失败：${esc(e.message)}</div>`;
  }
}

$('#btnRpSearch').addEventListener('click', () => searchAsset('resourcepack'));
$('#btnShSearch').addEventListener('click', () => searchAsset('shader'));
$('#rpQuery').addEventListener('keydown', (e) => e.key === 'Enter' && searchAsset('resourcepack'));
$('#shQuery').addEventListener('keydown', (e) => e.key === 'Enter' && searchAsset('shader'));

/* ================= 本地整合包导入 ================= */

$('#btnPackImport').addEventListener('click', () => $('#packFile').click());

$('#packFile').addEventListener('change', async (e) => {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!f) return;
  if (!/\.mrpack$/i.test(f.name)) return toast('只支持 .mrpack 文件', true);
  if (!confirm(`导入「${f.name}」（${fmtSize(f.size)}）？\n会作为独立实例安装，可能还要下几百 MB 的模组。`)) return;

  toast('正在读取文件…');
  try {
    const r = await fetch('/api/modpack/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(f.name) },
      body: f,
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    state.currentTaskId = d.taskId;
    $('#progressWrap').hidden = false;
    goto('home');
    toast(`开始导入 ${f.name}`);
  } catch (err) {
    toast('导入失败：' + err.message, true);
  }
});
