import { fetchText } from './http.js';

/**
 * MC百科（mcmod.cn）中文搜索。
 * 只用来把中文名翻译成英文名，真正下载还是走 Modrinth。
 * 站点没有公开 API，这里是解析搜索结果页的 HTML，所以他们改版就得跟着改。
 */

const CACHE = new Map();
const TTL = 10 * 60 * 1000;

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  Referer: 'https://www.mcmod.cn/',
};

function stripTags(s) {
  return String(s)
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export function hasCJK(text) {
  return /[\u3400-\u4dbf\u4e00-\u9fff]/.test(String(text || ''));
}

/**
 * @returns {Promise<{id:string,cn:string,en:string,url:string}[]>}
 */
export async function searchMcmod(keyword, limit = 6) {
  const key = String(keyword || '').trim();
  if (!key) return [];

  const cached = CACHE.get(key);
  if (cached && Date.now() - cached.at < TTL) return cached.data;

  const url = `https://search.mcmod.cn/s?key=${encodeURIComponent(key)}&site=all&filter=0`;
  const html = await fetchText(url, { timeout: 15000, headers: HEADERS });

  const out = [];
  const seen = new Set();
  // 结果标题形如：<a href="https://www.mcmod.cn/class/2785.html">钠 (Sodium)</a>
  const re = /<a[^>]+href="https:\/\/www\.mcmod\.cn\/class\/(\d+)\.html"[^>]*>([\s\S]{0,160}?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) !== null && out.length < limit) {
    const id = m[1];
    if (seen.has(id)) continue;
    const title = stripTags(m[2]);
    if (!title) continue;
    seen.add(id);

    // "钠 (Sodium)" / "钠 · 扩展 (Sodium Extra)" / "Embeddium"
    const mm = /^(.*?)\s*\(([^()]+)\)\s*$/.exec(title);
    const cn = (mm ? mm[1] : title).trim();
    const en = mm ? mm[2].trim() : '';
    if (!cn && !en) continue;
    out.push({ id, cn, en, url: `https://www.mcmod.cn/class/${id}.html` });
  }

  CACHE.set(key, { at: Date.now(), data: out });
  if (CACHE.size > 200) CACHE.clear();
  return out;
}
