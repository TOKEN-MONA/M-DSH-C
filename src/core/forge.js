import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { dirs } from './paths.js';
import { fetchText, download } from './http.js';
import { detectJava, pickJava } from './java.js';
import { installVersion } from './install.js';
import { jarPathFor } from './version.js';
import { setVersionMeta } from './store.js';
import * as tasks from './tasks.js';

const FORGE_META = 'https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml';
const NEO_META = 'https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml';

function parseVersions(xml) {
  return [...String(xml).matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1]);
}

/** 该 Minecraft 版本可用的 Forge 版本（新的在前） */
export async function listForge(mcVersion) {
  const xml = await fetchText(FORGE_META, { timeout: 30000 });
  return parseVersions(xml)
    .filter((v) => v.startsWith(`${mcVersion}-`))
    .map((v) => v.slice(mcVersion.length + 1))
    .reverse();
}

/** NeoForge：版本号按 Minecraft 版本折算，如 1.21.1 → 21.1.x */
export async function listNeoForge(mcVersion) {
  const xml = await fetchText(NEO_META, { timeout: 30000 });
  const mc = mcVersion.split('.').slice(1).join('.'); // 1.21.1 -> 21.1
  const all = parseVersions(xml);
  const out = all.filter((v) => v.startsWith(`${mc}.`)).reverse();
  if (out.length) return out;
  // 1.21 -> 21.0.x
  return all.filter((v) => v.startsWith(`${mc.split('.')[0]}.0.`)).reverse();
}

function runInstaller(javaExe, jarPath, mcDir, onLine) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      javaExe,
      ['-jar', jarPath, '--installClient', mcDir],
      { cwd: mcDir, timeout: 20 * 60 * 1000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const all = `${stdout || ''}\n${stderr || ''}`;
        for (const line of all.split(/\r?\n/)) if (line.trim()) onLine(line.trim());
        if (err) reject(new Error(`安装器退出异常：${err.message}`));
        else resolve(all);
      }
    );
    child.stdout && child.stdout.on('data', (d) => String(d).split(/\r?\n/).forEach((l) => l.trim() && onLine(l.trim())));
    child.stderr && child.stderr.on('data', (d) => String(d).split(/\r?\n/).forEach((l) => l.trim() && onLine(l.trim())));
  });
}

/**
 * 用官方安装器装 Forge / NeoForge。
 * 安装器自己会往 .minecraft/versions 里写 json 和 libraries，我们只负责跑它。
 */
export async function installLoader(mcVersion, loader, version, task) {
  const mcDir = dirs().mc;
  const log = (l) => tasks.log(task, l);

  // 安装器只下载 Forge 自己的库，原版那些（lwjgl、gson、netty…）得我们自己装，
  // 否则 classpath 里会有一大批文件不存在，启动时才炸。
  if (!fs.existsSync(jarPathFor(mcVersion))) {
    log(`基础版本 ${mcVersion} 还没装，先装原版`);
    await installVersion(mcVersion, task);
  }

  let java = await pickJava(21);
  if (!java) {
    const list = await detectJava({ refresh: true });
    java = list[0];
  }
  if (!java) throw new Error('安装 Forge/NeoForge 需要先有 Java，请到“设置”里下载一个');

  let url;
  let expectId;
  if (loader === 'neoforge') {
    const ver = version || (await listNeoForge(mcVersion))[0];
    if (!ver) throw new Error(`没有找到支持 ${mcVersion} 的 NeoForge`);
    url = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${ver}/neoforge-${ver}-installer.jar`;
    expectId = `neoforge-${ver}`;
  } else {
    const ver = version || (await listForge(mcVersion))[0];
    if (!ver) throw new Error(`没有找到支持 ${mcVersion} 的 Forge`);
    url = `https://maven.minecraftforge.net/net/minecraftforge/forge/${mcVersion}-${ver}/forge-${mcVersion}-${ver}-installer.jar`;
    expectId = `${mcVersion}-forge-${ver}`;
  }

  const jarFile = path.join(dirs().cache, path.basename(url));
  tasks.patch(task, { stage: `下载 ${loader} 安装器` });
  log(`下载 ${path.basename(url)}`);
  await download(url, jarFile, { timeout: 300000 });

  // 官方安装器会检查这个文件，全新目录里没有就直接报
  // "There is no minecraft launcher profile ... you need to run the launcher first!"
  const profiles = path.join(mcDir, 'launcher_profiles.json');
  if (!fs.existsSync(profiles)) {
    log('创建 launcher_profiles.json（安装器要求）');
    fs.mkdirSync(mcDir, { recursive: true });
    fs.writeFileSync(profiles, JSON.stringify({ profiles: {}, settings: { language: 'zh_CN' }, version: 3 }, null, 2), 'utf8');
  }

  tasks.patch(task, { stage: '运行安装器（可能要几分钟）' });
  log(`用 ${java.path} 运行安装器`);
  await runInstaller(java.path, jarFile, mcDir, log);

  const jsonPath = path.join(mcDir, 'versions', expectId, `${expectId}.json`);
  if (!fs.existsSync(jsonPath)) {
    // 安装器有时候版本目录名略有差异，扫一遍找最新的
    const vdir = path.join(mcDir, 'versions');
    const hits = fs
      .readdirSync(vdir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && new RegExp(`${loader}|forge`, 'i').test(d.name))
      .map((d) => d.name);
    throw new Error(`安装器跑完了但没找到 ${expectId}。目录里现有的：${hits.join(', ') || '(空)'}`);
  }

  setVersionMeta(expectId, {
    type: loader,
    loader,
    loaderVersion: version,
    mcVersion,
    javaMajor: 21,
    installedAt: Date.now(),
  });
  log(`安装完成：${expectId}`);
  return expectId;
}
