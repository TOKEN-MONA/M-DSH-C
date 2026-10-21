import { fetchText } from './http.js';

/**
 * MC百科（mcmod.cn）中文搜索 —— 使用站长提供的官方接口：
 *   GET https://api.mcmod.cn/meya/search.php?key=<关键词>
 *
 * 返回是纯文本，每个结果占两行：
 *   [农业] [FD] 农夫乐事 (Farmer's Delight)
 *   https://www.mcmod.cn/class/2820.html
 *
 * 这个接口是「最佳匹配」性质，一般只回一条。我们用它是为了把中文名
 * 翻成英文名，再去 Modrinth / CurseForge 找可下载的文件。
 * （qq / qqg 两个参数是给 QQ 群机器人用的，这里不需要）
 */

const API = 'https://api.mcmod.cn/meya/search.php';
const CACHE = new Map();
const TTL = 10 * 60 * 1000;

function stripTags(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 解析接口返回的纯文本 */
export function parseMcmodText(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^\[([^\]]*)\]\s*(.+)$/.exec(lines[i]);
    if (!m) continue;

    const category = stripTags(m[1]);
    let rest = stripTags(m[2]);
    const nextLine = lines[i + 1] || '';
    const url = /^https?:\/\//.test(nextLine) ? nextLine : '';

    // 英文名在最后一对括号里："农夫乐事 (Farmer's Delight)"
    const em = /^(.*)\(([^()]+)\)\s*$/.exec(rest);
    let cn = rest;
    let en = '';
    if (em) {
      cn = em[1].trim();
      en = em[2].trim();
    }

    // 去掉 "[FD] " 这类模组简称前缀，保留干净的中文名
    cn = cn.replace(/^\s*\[[^\]]{1,12}\]\s*/, '').trim();
    if (!cn && !en) continue;

    const idMatch = /\/class\/(\d+)/.exec(url);
    out.push({ id: idMatch ? idMatch[1] : '', cn: cn || en, en, category, url });
  }
  return out;
}

/**
 * @returns {Promise<{id:string,cn:string,en:string,category:string,url:string}[]>}
 */
export async function searchMcmod(keyword) {
  const key = String(keyword || '').trim();
  if (!key) return [];

  const cached = CACHE.get(key);
  if (cached && Date.now() - cached.at < TTL) return cached.data;

  const url = `${API}?key=${encodeURIComponent(key)}`;
  const text = await fetchText(url, { timeout: 15000 });
  const data = parseMcmodText(text);

  CACHE.set(key, { at: Date.now(), data });
  if (CACHE.size > 200) CACHE.clear();
  return data;
}
