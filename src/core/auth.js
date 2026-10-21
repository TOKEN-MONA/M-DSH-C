import crypto from 'node:crypto';
import { getSettings, getAccounts, saveAccounts } from './store.js';

// 本项目自己注册的 Azure 应用（"Minecraft D-S-H Project"）。
// 已向 Mojang 提交 Minecraft API 访问权限申请，审批中。
export const PROJECT_CLIENT_ID = 'bd0e57f1-7ba4-4cea-8ed5-20c44ff9f6f5';

// Mojang 对 Minecraft API 有独立于 Azure 的白名单：自注册应用在获批之前，
// 微软账号和 Xbox 认证都能过，但最后一步 login_with_xbox 会返回
// 403 Invalid app registration。所以获批前用一个能被接受的应用 ID 顶上。
const TEMP_CLIENT_ID = 'c36a9fb6-4f2a-41ff-90bd-ae7cc92031eb';

// ⚠ 申请通过后把这里改成 false，就会切回本项目自己的应用 ID。
const USE_TEMP_CLIENT_ID = true;

const BUILTIN_CLIENT_ID = USE_TEMP_CLIENT_ID ? TEMP_CLIENT_ID : PROJECT_CLIENT_ID;

// 自己填的 ID 配置有误时（AADSTS700016 / AADSTS50059 等）的兜底
const FALLBACK_CLIENT_ID = TEMP_CLIENT_ID;
const SCOPE = 'XboxLive.signin offline_access';
const DEVICE_CODE_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode';
const TOKEN_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token';

export function clientId() {
  const s = getSettings();
  return (s.clientId || '').trim() || BUILTIN_CLIENT_ID;
}

/** 本次设备码流程实际用的是哪个 client id（兜底时会和配置不一样） */
let activeDeviceClientId = null;

async function postForm(url, form) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`认证服务返回异常：${text.slice(0, 200)}`);
  }
  return { ok: res.ok, status: res.status, data };
}

async function postJson(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} ${data.error || ''} ${data.errorMessage || data.Message || ''}`.trim());
    err.body = data;
    throw err;
  }
  return data;
}

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers: { Accept: 'application/json', ...headers } });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} ${data.error || ''}`.trim());
    err.body = data;
    err.status = res.status;
    throw err;
  }
  return data;
}

export async function startDeviceLogin() {
  const primary = clientId();
  const first = await postForm(DEVICE_CODE_URL, { client_id: primary, scope: SCOPE });

  if (first.ok) {
    activeDeviceClientId = primary;
    return {
      deviceCode: first.data.device_code,
      userCode: first.data.user_code,
      verificationUri: first.data.verification_uri,
      expiresIn: first.data.expires_in,
      interval: first.data.interval || 5,
      message: first.data.message,
      fallback: false,
    };
  }

  const desc = String(first.data.error_description || '');
  const configProblem = /AADSTS700016|AADSTS50059|AADSTS700018|unauthorized_client/.test(`${first.data.error} ${desc}`);

  if (configProblem && primary !== FALLBACK_CLIENT_ID) {
    const second = await postForm(DEVICE_CODE_URL, { client_id: FALLBACK_CLIENT_ID, scope: SCOPE });
    if (second.ok) {
      activeDeviceClientId = FALLBACK_CLIENT_ID;
      return {
        deviceCode: second.data.device_code,
        userCode: second.data.user_code,
        verificationUri: second.data.verification_uri,
        expiresIn: second.data.expires_in,
        interval: second.data.interval || 5,
        message: second.data.message,
        fallback: true,
        reason: desc.split('\n')[0].slice(0, 200),
      };
    }
  }

  throw new Error(first.data.error_description || first.data.error || '无法获取设备码');
}

export async function pollDeviceLogin(deviceCode) {
  const { ok, data } = await postForm(TOKEN_URL, {
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    client_id: activeDeviceClientId || clientId(),
    device_code: deviceCode,
  });
  if (!ok) {
    if (data.error === 'authorization_pending') return { status: 'pending' };
    if (data.error === 'slow_down') return { status: 'pending', slow: true };
    if (data.error === 'expired_token') return { status: 'expired', message: '设备码已过期，请重试' };
    if (data.error === 'authorization_declined') return { status: 'declined', message: '你在浏览器里拒绝了授权' };
    const desc = String(data.error_description || '');
    if (/AADSTS70000|already been used/i.test(desc)) {
      return { status: 'used', message: '这个授权码已经用过了（可能已经登录成功），重新点一次「开始正版登录」' };
    }
    return { status: 'error', message: desc.split('\n')[0] || data.error || '登录失败' };
  }
  return { status: 'ok', token: data };
}

/** 用微软 access_token 走一遍 Xbox → XSTS → Minecraft 服务 */
export async function completeMicrosoftLogin(tokenSet) {
  const msAccess = tokenSet.access_token;
  const refresh = tokenSet.refresh_token;
  const client = activeDeviceClientId || clientId();

  let xbl;
  try {
    xbl = await postJson('https://user.auth.xboxlive.com/user/authenticate', {
      Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${msAccess}` },
      RelyingParty: 'http://auth.xboxlive.com',
      TokenType: 'JWT',
    });
  } catch (e) {
    throw new Error(`Xbox Live 认证失败：${e.message}`);
  }

  let xsts;
  try {
    xsts = await postJson('https://xsts.auth.xboxlive.com/xsts/authorize', {
      Properties: { SandboxId: 'RETAIL', UserTokens: [xbl.Token] },
      RelyingParty: 'rp://api.minecraftservices.com/',
      TokenType: 'JWT',
    });
  } catch (e) {
    const xerr = e.body && e.body.XErr;
    const map = {
      2148916233: '这个微软账号还没有 Xbox 档案，先去 xbox.com 登录一次创建',
      2148916235: '该账号所在地区不允许 Xbox Live',
      2148916236: '需要成人验证（韩国区）',
      2148916237: '需要成人验证（韩国区）',
      2148916238: '这是儿童账号，需要家长加入家庭组',
      2148916227: '该账号已被 Xbox Live 封禁',
    };
    throw new Error(map[xerr] || `XSTS 授权失败：${e.message}（XErr ${xerr || '未知'}）`);
  }

  const uhs = (xsts.DisplayClaims && xsts.DisplayClaims.xui && xsts.DisplayClaims.xui[0].uhs) || (xbl.DisplayClaims.xui[0].uhs);

  let mc;
  try {
    mc = await postJson('https://api.minecraftservices.com/authentication/login_with_xbox', {
      identityToken: `XBL3.0 x=${uhs};${xsts.Token}`,
    });
  } catch (e) {
    const raw = `${e.message} ${JSON.stringify(e.body || {})}`;
    if (/Invalid app registration/i.test(raw)) {
      throw new Error(
        'Mojang 不认可这个应用 ID（403 Invalid app registration）。\n\n' +
          '这不是 Azure 配置问题——微软账号那边已经登录成功了，卡在"换 Minecraft 令牌"这一步。\n' +
          'Minecraft API 有自己的一份允许列表，自注册的 Azure 应用默认进不去。\n\n' +
          '解决办法：设置 → 高级 → 把「微软应用 ID」清空，改用内置 ID 重新登录。'
      );
    }
    throw new Error(`Minecraft 服务登录失败：${e.message}`);
  }

  let profile;
  try {
    profile = await getJson('https://api.minecraftservices.com/minecraft/profile', {
      Authorization: `Bearer ${mc.access_token}`,
    });
  } catch (e) {
    if (e.status === 404) throw new Error('这个账号没有购买 Minecraft: Java Edition（找不到游戏档案）');
    throw new Error(`获取游戏档案失败：${e.message}`);
  }

  const account = {
    type: 'msa',
    name: profile.name,
    uuid: profile.id,
    accessToken: mc.access_token,
    refreshToken: refresh,
    clientId: client,
    expiresAt: Date.now() + (mc.expires_in || 86400) * 1000,
    skins: profile.skins || [],
    capes: profile.capes || [],
    addedAt: Date.now(),
  };
  rememberAccount(account);
  return account;
}

export async function refreshAccount(account) {
  if (!account || account.type !== 'msa' || !account.refreshToken) return account;
  if (account.expiresAt && account.expiresAt > Date.now() + 60_000) return account;
  const cid = account.clientId || clientId();
  const { ok, data } = await postForm(TOKEN_URL, {
    grant_type: 'refresh_token',
    client_id: cid,
    refresh_token: account.refreshToken,
    scope: SCOPE,
  });
  if (!ok) throw new Error(`刷新登录状态失败：${data.error_description || data.error}（需要在界面上重新登录）`);
  const fresh = await completeMicrosoftLogin({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
  });
  return fresh;
}

function offlineUuid(name) {
  const h = crypto.createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
  h[6] = (h[6] & 0x0f) | 0x30;
  h[8] = (h[8] & 0x3f) | 0x80;
  const hex = h.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function loginOffline(name) {
  const clean = String(name || '').trim();
  if (!/^[A-Za-z0-9_]{3,16}$/.test(clean)) {
    throw new Error('离线用户名只能是 3~16 位字母/数字/下划线');
  }
  const account = {
    type: 'offline',
    name: clean,
    uuid: offlineUuid(clean),
    accessToken: '0',
    clientId: '',
    expiresAt: 0,
    addedAt: Date.now(),
  };
  rememberAccount(account);
  return account;
}

export function rememberAccount(account) {
  const acc = getAccounts();
  acc.list = (acc.list || []).filter((a) => !(a.type === account.type && a.name === account.name));
  acc.list.push(account);
  acc.current = account;
  saveAccounts();
  return account;
}

export function currentAccount() {
  const acc = getAccounts();
  return acc.current || null;
}

export function logout() {
  const acc = getAccounts();
  acc.current = null;
  saveAccounts();
  return true;
}

export function forget(name) {
  const acc = getAccounts();
  acc.list = (acc.list || []).filter((a) => a.name !== name);
  if (acc.current && acc.current.name === name) acc.current = null;
  saveAccounts();
  return true;
}
