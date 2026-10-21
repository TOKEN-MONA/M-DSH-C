import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { dirs } from './paths.js';

export const ALL_FEATURES = [
  'is_demo_user',
  'has_custom_resolution',
  'has_quick_plays_support',
  'is_quick_play_singleplayer',
  'is_quick_play_multiplayer',
  'is_quick_play_realms',
];

function platformInfo() {
  return {
    name: os.platform() === 'win32' ? 'windows' : os.platform() === 'darwin' ? 'osx' : os.platform(),
    arch: os.arch(),
    version: os.release(),
  };
}

const ARCH_MAP = { x86: 'ia32', x64: 'x64', arm64: 'arm64', arm: 'arm' };

function ruleMatches(rule, features) {
  const p = platformInfo();
  if (rule.os) {
    if (rule.os.name && rule.os.name !== p.name) return false;
    if (rule.os.arch && (ARCH_MAP[rule.os.arch] || rule.os.arch) !== p.arch) return false;
    if (rule.os.version) {
      try {
        if (!new RegExp(rule.os.version).test(p.version)) return false;
      } catch {
        /* 正则坏了就当不限制 */
      }
    }
  }
  if (rule.features) {
    for (const k of Object.keys(rule.features)) {
      if (Boolean(features[k]) !== Boolean(rule.features[k])) return false;
    }
  }
  return true;
}

/**
 * 规则求值：默认允许；按顺序命中，最后命中的动作说了算。
 */
export function ruleAllows(rules, features = {}) {
  if (!Array.isArray(rules) || rules.length === 0) return true;
  let allow = false;
  for (const r of rules) {
    if (!ruleMatches(r, features)) continue;
    allow = r.action === 'allow';
  }
  return allow;
}

/** natives 的架构由名字后缀决定：windows / windows-arm64 / windows-x86 */
function nativeArchOk(name) {
  const m = /:natives-[a-z]+(?:-(arm64|x86|x86_64))?$/i.exec(String(name || ''));
  if (!m) return true;
  const want = (m[1] || 'x86_64').toLowerCase();
  const mine = process.arch === 'arm64' ? 'arm64' : process.arch === 'ia32' ? 'x86' : 'x86_64';
  return want === mine;
}
export function versionDir(id) {
  return path.join(dirs().versions, id);
}

export function jsonPath(id) {
  return path.join(versionDir(id), `${id}.json`);
}

export function jarPathFor(id) {
  return path.join(versionDir(id), `${id}.jar`);
}

export function nativesDir(id) {
  return path.join(versionDir(id), 'natives');
}

export function readVersionJson(id) {
  const f = jsonPath(id);
  if (!fs.existsSync(f)) throw new Error(`版本 ${id} 没有安装（缺少 ${f}）`);
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

export function writeVersionJson(id, data) {
  fs.mkdirSync(versionDir(id), { recursive: true });
  fs.writeFileSync(jsonPath(id), JSON.stringify(data, null, 2), 'utf8');
}

export function hasVersion(id) {
  return fs.existsSync(jsonPath(id));
}

function libKey(name) {
  // group:artifact[:classifier] -- keep the classifier in the key.
  // Otherwise natives variants (…:version:natives-windows) collapse into the
  // plain library and vanish from both classpath and natives.
  const p = String(name || '').split(':');
  const classifier = p.length >= 4 ? p[3] : '';
  return classifier ? `${p[0]}:${p[1]}:${classifier}` : `${p[0]}:${p[1]}`;
}

/**
 * 合并 inheritsFrom 链：parent 在前，child 在后。
 */
export function resolveMerged(id) {
  const chain = [];
  let cursor = id;
  let guard = 0;
  while (cursor) {
    if (guard++ > 12) throw new Error('inheritsFrom 链太深，可能循环引用');
    const json = readVersionJson(cursor);
    chain.unshift({ id: cursor, json });
    cursor = json.inheritsFrom;
  }

  const base = chain[0];
  let merged = { ...base.json, id, __jarId: base.id, __chain: chain.map((c) => c.id) };

  for (let i = 1; i < chain.length; i++) {
    const child = chain[i];
    merged = mergeTwo(merged, child.json, id);
  }

  // client.jar 所属版本：merged.jar 优先，否则取链里第一个带 downloads.client 的
  if (merged.jar) merged.__jarId = merged.jar;
  else {
    for (const c of chain) {
      if (c.json.downloads && c.json.downloads.client) {
        merged.__jarId = c.id;
        break;
      }
    }
  }

  merged.libraries = merged.libraries || [];
  merged.featureKeys = ALL_FEATURES;
  return merged;
}

function mergeTwo(parent, child, finalId) {
  const out = { ...parent, ...child, id: finalId };
  out.mainClass = child.mainClass || parent.mainClass;
  out.minecraftArguments = child.minecraftArguments || parent.minecraftArguments || null;
  out.assetIndex = child.assetIndex || parent.assetIndex || null;
  out.assets = child.assets || parent.assets || null;
  out.javaVersion = child.javaVersion || parent.javaVersion || null;
  out.logging = child.logging || parent.logging || null;
  out.type = child.type || parent.type;
  out.releaseTime = child.releaseTime || parent.releaseTime;
  out.downloads = { ...(parent.downloads || {}), ...(child.downloads || {}) };
  out.__jarId = parent.__jarId;

  out.libraries = mergeLibraries(child.libraries || [], parent.libraries || []);

  const pa = parent.arguments || {};
  const ca = child.arguments || {};
  if (pa.jvm || pa.game || ca.jvm || ca.game) {
    out.arguments = {
      jvm: [...(pa.jvm || []), ...(ca.jvm || [])],
      game: [...(pa.game || []), ...(ca.game || [])],
    };
  }
  return out;
}

function mergeLibraries(childLibs, parentLibs) {
  const seen = new Set();
  const out = [];
  for (const lib of [...childLibs, ...parentLibs]) {
    if (!lib || !lib.name) continue;
    const k = libKey(lib.name);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(lib);
  }
  return out;
}

/**
 * Maven 坐标 → 相对路径。用于 downloads 里没给 artifact 的老库。
 */
export function mavenRelPath(name) {
  const parts = String(name).split(':');
  const [group, artifact, version, classifier] = parts;
  if (!version) return null;
  const dir = group.replace(/\./g, '/');
  const file = `${artifact}-${version}${classifier ? `-${classifier}` : ''}.jar`;
  return `${dir}/${artifact}/${version}/${file}`;
}

/**
 * 解析出 classpath 条目和 native 压缩包条目。
 */
export function resolveLibraries(merged, features = {}) {
  const classpath = [];
  const natives = [];
  const seenPath = new Set();

  for (const lib of merged.libraries) {
    if (!ruleAllows(lib.rules, features)) continue;
    const dl = lib.downloads || {};

    let artifact = dl.artifact;
    if (!artifact && lib.name) {
      const rel = mavenRelPath(lib.name);
      if (rel) artifact = { path: rel, url: `https://libraries.minecraft.net/${rel}` };
    }
    if (artifact && artifact.path) {
      // 1.19+ 的 natives 是独立库（name 里带 :natives-windows 之类），
      // 必须解压到 natives 目录，不能进 classpath，否则 lwjgl.dll 找不到
      if (/:natives-/.test(String(lib.name || ''))) {
        if (!nativeArchOk(lib.name)) continue;
        natives.push({
          path: artifact.path,
          url: artifact.url || `https://libraries.minecraft.net/${artifact.path}`,
          sha1: artifact.sha1,
          size: artifact.size,
          from: lib.name,
        });
        continue;
      }
      if (!seenPath.has(artifact.path)) {
        seenPath.add(artifact.path);
        classpath.push({
          path: artifact.path,
          url: artifact.url || `https://libraries.minecraft.net/${artifact.path}`,
          sha1: artifact.sha1,
          size: artifact.size,
        });
      }
    }

    // 老版本（<=1.18）natives 放在 classifiers 里，必须解压出来
    if (lib.natives && lib.natives.windows) {
      const classifier = String(lib.natives.windows).replace('${arch}', '64');
      const nat = (dl.classifiers || {})[classifier];
      if (nat && nat.path) {
        natives.push({
          path: nat.path,
          url: nat.url || `https://libraries.minecraft.net/${nat.path}`,
          sha1: nat.sha1,
          size: nat.size,
          from: lib.name,
        });
      }
    }
  }

  return { classpath, natives };
}

/**
 * 把数组形式的参数（字符串或 {rules,value}）按规则展开
 */
export function expandArgs(list, features) {
  const out = [];
  for (const item of list || []) {
    if (typeof item === 'string') {
      out.push(item);
      continue;
    }
    if (item && typeof item === 'object' && ruleAllows(item.rules, features)) {
      if (Array.isArray(item.value)) out.push(...item.value);
      else if (typeof item.value === 'string') out.push(item.value);
    }
  }
  return out;
}

export function substitute(template, map) {
  return String(template).replace(/\$\{([^}]+)\}/g, (m, key) => (key in map ? String(map[key]) : m));
}
