import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { dirs } from './paths.js';
import { resolveMerged, resolveLibraries, jarPathFor, nativesDir, expandArgs, substitute, versionDir } from './version.js';
import { getSettings, getVersionMeta, setVersionMeta, setLastCrash, clearLastCrash } from './store.js';
import { pickJava, installJava, javaMajorFor, javaComponentFor, javaExeInDir } from './java.js';
import { extractNatives, featuresFor, installVersion } from './install.js';
import { effectiveMemory } from './memory.js';
import { refreshAccount, currentAccount } from './auth.js';
import * as tasks from './tasks.js';
import { diagnose } from './crash.js';

export const running = new Map(); // versionId -> {child, startedAt}

function toJvmList(merged) {
  if (merged.arguments && Array.isArray(merged.arguments.jvm)) return merged.arguments.jvm;
  return ['-Djava.library.path=${natives_directory}', '-cp', '${classpath}'];
}

function toGameList(merged) {
  if (merged.arguments && Array.isArray(merged.arguments.game)) return merged.arguments.game;
  if (merged.minecraftArguments) return String(merged.minecraftArguments).split(/\s+/).filter(Boolean);
  return [];
}

export function isIsolated(versionId) {
  const meta = getVersionMeta(versionId);
  if (meta && meta.isolated !== undefined) return !!meta.isolated;
  return true; // 与 PCL2 的目录结构保持一致
}

export function gameDirFor(versionId) {
  return isIsolated(versionId) ? versionDir(versionId) : dirs().mc;
}

/**
 * 组装完整命令行。不启动，方便排查。
 */
export function buildCommand(versionId, account, javaPath) {
  const merged = resolveMerged(versionId);
  const meta = getVersionMeta(versionId);
  const features = featuresFor();
  const gameDir = gameDirFor(versionId);
  const nd = nativesDir(versionId);
  const jarId = merged.__jarId || versionId;
  const clientJar = jarPathFor(jarId);

  if (!fs.existsSync(clientJar)) throw new Error(`缺少客户端 ${clientJar}，请先安装该版本`);

  const { classpath } = resolveLibraries(merged, features);
  const cpList = classpath.map((l) => path.join(dirs().libraries, l.path));

  // NeoForge 1.20.5+（"split client"）自带预打补丁的 client jar，
  // 原版 jar 再进 classpath 就会和它同时导出 com.mojang.blaze3d.platform，
  // modlauncher 直接报 "Modules minecraft and _1._21._1 export package ..."。
  // Forge / 老版 NeoForge 则相反：原版 jar 就是游戏本体，必须留着。
  const chain = merged.__chain || [];
  const loaderKind = String((meta && meta.loader) || '').toLowerCase();
  const isNeoForge = loaderKind === 'neoforge' || chain.some((x) => /^neoforge-/i.test(x));
  const mcStr = (meta && meta.mcVersion) || chain[0] || '';
  const vm = /^1\.(\d+)(?:\.(\d+))?/.exec(mcStr);
  const mcScore = vm ? Number(vm[1]) * 100 + Number(vm[2] || 0) : 0;
  const splitClient = isNeoForge && mcScore >= 2005;
  if (!splitClient) cpList.push(clientJar);

  const assetIndexName = merged.assets || (merged.assetIndex && merged.assetIndex.id) || 'legacy';
  const uuidNoDash = String(account.uuid || '').replace(/-/g, '');
  const isMsa = account.type === 'msa';

  const vars = {
    auth_player_name: account.name,
    version_name: versionId,
    game_directory: gameDir,
    assets_root: dirs().assets,
    game_assets: path.join(dirs().assets, 'virtual', assetIndexName),
    assets_index_name: assetIndexName,
    auth_uuid: uuidNoDash,
    auth_access_token: isMsa ? account.accessToken : '0',
    auth_session: isMsa ? `token:${account.accessToken}` : '0',
    user_type: isMsa ? 'msa' : 'legacy',
    version_type: merged.type || 'release',
    user_properties: '{}',
    clientid: '',
    auth_xuid: '',
    natives_directory: nd,
    launcher_name: 'MCLauncher',
    launcher_version: '1.0',
    classpath: cpList.join(';'),
    classpath_separator: ';',
    library_directory: dirs().libraries,
    resolution_width: String(getSettings().windowWidth || 854),
    resolution_height: String(getSettings().windowHeight || 480),
  };

  const s = getSettings();
  const mem = effectiveMemory(s);
  const userJvm = (s.jvmArgs || '').split(/\s+/).filter(Boolean);

  const jvm = expandArgs(toJvmList(merged), features).map((a) => substitute(a, vars));

  const logArg = (() => {
    const cl = merged.logging && merged.logging.client;
    if (!cl || !cl.argument) return null;
    const cfg = path.join(dirs().assets, 'log_configs', cl.file.id);
    if (!fs.existsSync(cfg)) return null;
    return substitute(cl.argument, { path: cfg });
  })();

  const gameArgs = expandArgs(toGameList(merged), features).map((a) => substitute(a, vars));

  const memArgs = [
    `-Xmx${mem.maxMB}m`,
    `-Xms${mem.minMB}m`,
    '-Dfile.encoding=UTF-8',
    '-Dstdout.encoding=UTF-8',
    '-Dstderr.encoding=UTF-8',
    '-Dlog4j2.formatMsgNoLookups=true',
    '-Djdk.lang.Process.allowAmbiguousCommands=true',
    `-Djava.library.path=${nd}`,
    `-Djna.tmpdir=${nd}`,
    `-Dorg.lwjgl.system.SharedLibraryExtractPath=${nd}`,
    `-Dio.netty.native.workdir=${nd}`,
    `-XX:+UseG1GC`,
    '-XX:-OmitStackTraceInFastThrow',
    '-Dfml.ignoreInvalidMinecraftCertificates=true',
    '-Dfml.ignorePatchDiscrepancies=true',
  ];
  if (logArg) memArgs.push(logArg);

  const args = [...memArgs, ...userJvm, ...jvm, merged.mainClass, ...gameArgs];

  return { args, gameDir, javaPath, merged, meta, jarId, clientJar, memory: mem };
}

export async function ensureRunnable(versionId, task) {
  const merged = resolveMerged(versionId);
  const major = javaMajorFor(merged);
  const component = javaComponentFor(merged);
  const s = getSettings();

  const java = await pickJava(major, s.javaPath);
  if (!java || java.major < major) {
    tasks.log(task, `没有可用的 Java ${major}（现有：${java ? java.major : '无'}），开始自动下载`);
    const dir = await installJava(major, component, task);
    const exe = javaExeInDir(dir) || javaExeInDir(path.join(dir, 'bin'));
    if (!exe) throw new Error(`Java ${major} 装到 ${dir} 但找不到 bin/java.exe`);
    tasks.log(task, `Java ${major} 已就绪：${exe}`);
    return { path: exe, major, vendor: '官方运行时', downloaded: true };
  }
  tasks.log(task, `使用 Java ${java.major} (${java.vendor})：${java.path}`);
  return java;
}

function pipeToTask(stream, task, prefix) {
  let buf = '';
  stream.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() || '';
    for (const line of lines) {
      if (line.trim()) tasks.log(task, prefix ? `${prefix}${line}` : line);
    }
  });
  stream.on('end', () => {
    if (buf.trim()) tasks.log(task, prefix ? `${prefix}${buf}` : buf);
  });
}

/**
 * 启动 Java 进程。优先接管 stdout/stderr 以便在界面里看日志；
 * 如果当前环境不允许（例如受限沙箱返回 EPERM），降级为静默启动，
 * 游戏自己的日志仍然写在 <游戏目录>/logs/latest.log 里。
 */
async function spawnWithFallback(javaPath, args, gameDir, task) {
  for (const usePipe of [true, false]) {
    let child;
    try {
      child = spawn(javaPath, args, {
        cwd: gameDir,
        windowsHide: false,
        stdio: usePipe ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'ignore', 'ignore'],
        env: { ...process.env },
      });
    } catch (e) {
      // 某些受限环境下 spawn 会同步抛 EPERM（建不了管道）
      if (usePipe && (e.code === 'EPERM' || e.code === 'EACCES')) {
        tasks.log(task, '当前环境不允许接管进程输出，改为静默启动（游戏日志见 logs/latest.log）');
        continue;
      }
      throw e;
    }
    const err = await new Promise((resolve) => {
      child.once('spawn', () => resolve(null));
      child.once('error', (e) => resolve(e));
    });
    if (!err) return child;
    if (usePipe && (err.code === 'EPERM' || err.code === 'EACCES')) {
      tasks.log(task, '当前环境不允许接管进程输出，改为静默启动（游戏日志见 logs/latest.log）');
      continue;
    }
    throw err;
  }
  throw new Error('无法启动 Java 进程');
}

export async function launch(versionId, task) {
  if (running.has(versionId)) throw new Error('这个版本已经在运行了');

  const meta = getVersionMeta(versionId);

  let account = currentAccount();
  if (!account) throw new Error('还没有登录，请先在“账号”页登录');
  if (account.type === 'msa') {
    tasks.patch(task, { stage: '校验登录状态' });
    try {
      account = await refreshAccount(account);
    } catch (e) {
      tasks.log(task, `登录状态刷新失败：${e.message}`);
      throw e;
    }
  }

  tasks.patch(task, { stage: '准备 Java' });
  const java = await ensureRunnable(versionId, task);

  tasks.patch(task, { stage: '准备原生库' });
  const m = resolveMerged(versionId);
  extractNatives(versionId, m);

  tasks.patch(task, { stage: '组装启动参数' });
  const cmd = buildCommand(versionId, account, java.path);
  tasks.log(task, `游戏目录：${cmd.gameDir}`);
  tasks.log(task, `Java：${java.path}`);

  if (isIsolated(versionId)) {
    fs.mkdirSync(cmd.gameDir, { recursive: true });
    const modsDir = path.join(cmd.gameDir, 'mods');
    if (!fs.existsSync(modsDir) && /fabric|forge|neoforge|quilt/.test((meta && meta.loader) || '')) {
      fs.mkdirSync(modsDir, { recursive: true });
    }
  }

  tasks.patch(task, { stage: '启动游戏' });
  tasks.log(task, '命令行：');
  tasks.log(task, `"${java.path}" ${cmd.args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`);

  const child = await spawnWithFallback(java.path, cmd.args, cmd.gameDir, task);

  const session = { child, startedAt: Date.now(), versionId, account: account.name };
  running.set(versionId, session);

  if (child.stdout) pipeToTask(child.stdout, task, '');
  if (child.stderr) pipeToTask(child.stderr, task, '');

  child.on('error', (e) => {
    tasks.log(task, `启动失败：${e.message}`);
    tasks.finish(task, e);
    running.delete(versionId);
  });

  child.on('exit', (code) => {
    const secs = Math.round((Date.now() - session.startedAt) / 1000);
    running.delete(versionId);
    fs.appendFileSync(
      path.join(dirs().data, 'launch.log'),
      `${new Date().toISOString()}\t${versionId}\texit=${code}\t${secs}s\n`,
      'utf8'
    );
    const old = getVersionMeta(versionId) || {};
    setVersionMeta(versionId, {
      lastPlayed: Date.now(),
      playTimeSec: (old.playTimeSec || 0) + secs,
    });
    if (code === 0) {
      tasks.log(task, `游戏正常退出（玩了 ${Math.round(secs / 60)} 分钟）`);
      tasks.finish(task, null);
    } else {
      const diag = diagnose(cmd.gameDir, code);
      setLastCrash({ ...diag, versionId, exitCode: code, at: Date.now() });
      tasks.log(task, `游戏异常退出（退出码 ${code}）`);
      tasks.log(task, `诊断：${diag.title}`);
      tasks.log(task, diag.hint);
      if (diag.excerpt) tasks.log(task, `关键行：${diag.excerpt}`);
      tasks.finish(task, null);
    }
  });

  tasks.log(task, '已发送启动指令，等待游戏窗口出现……');
  return { pid: child.pid, gameDir: cmd.gameDir };
}
