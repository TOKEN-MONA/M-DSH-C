#!/usr/bin/env node
/**
 * 冒烟测试：只验纯逻辑，不联网、不启动服务。
 * 加 --net 会额外检查 Mojang / Modrinth 能否访问。
 *
 * 跑：node scripts/smoke-test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mdshc-smoke-'));
process.env.MCL_DATA = TMP;

const mod = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

let failed = 0;
let passed = 0;

function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  ok    ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? '  <- ' + detail : ''}`);
  }
}

console.log('== 1. 模块能否加载 ==');
{
  const dir = path.join(ROOT, 'src', 'core');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    try {
      await mod(`src/core/${f}`);
      check(`import ${f}`, true);
    } catch (e) {
      check(`import ${f}`, false, e.message);
    }
  }
}

console.log('\n== 2. zip 读取（回归：条目名反斜杠）==');
{
  // 由 PowerShell 的 Compress-Archive 生成，条目名是 `overrides\config\hello.txt`
  const FIXTURE =
    'UEsDBBQAAAAIAPkDVl1H3dx5BAAAAAIAAAAaAAAAb3ZlcnJpZGVzXGNvbmZpZ1xoZWxsby50eHTLzwYAUEsBAhQAFAAAAAgA+QNWXUfd3HkEAAAAAgAAABoAAAAAAAAAAAAAAAAAAAAAAG92ZXJyaWRlc1xjb25maWdcaGVsbG8udHh0UEsFBgAAAAABAAEASAAAADwAAAAAAA==';
  const buf = Buffer.from(FIXTURE, 'base64');
  const { listZip, readEntry } = await mod('src/core/zip.js');
  const entries = listZip(buf);

  check('条目名里没有反斜杠', entries.every((e) => !e.name.includes('\\')), entries.map((e) => e.name).join(','));
  check('能用 overrides/ 前缀匹配', entries.some((e) => e.name.startsWith('overrides/')));

  const e = entries.find((x) => x.name === 'overrides/config/hello.txt');
  check('内容可解出', !!e && readEntry(buf, e).toString('utf8') === 'ok');
}

console.log('\n== 3. 规则求值（os / features）==');
{
  const v = await mod('src/core/version.js');
  const win = process.platform === 'win32';
  check('无规则时默认允许', v.ruleAllows(undefined, {}) === true);
  check('空数组默认允许', v.ruleAllows([], {}) === true);
  check('allow 本平台', v.ruleAllows([{ action: 'allow', os: { name: win ? 'windows' : 'linux' } }], {}) === true);
  check('allow 其它平台', v.ruleAllows([{ action: 'allow', os: { name: win ? 'linux' : 'windows' } }], {}) === false);
  check(
    '后命中的 deny 生效',
    v.ruleAllows([{ action: 'allow' }, { action: 'deny', os: { name: win ? 'windows' : 'linux' } }], {}) === false
  );
  check(
    'features 不满足时跳过',
    v.ruleAllows([{ action: 'allow', features: { has_custom_resolution: true } }], { has_custom_resolution: false }) === false
  );
}

console.log('\n== 4. 依赖库解析 ==');
{
  const v = await mod('src/core/version.js');
  const merged = {
    libraries: [
      { name: 'a:b:1', downloads: { artifact: { path: 'a/b/1/b-1.jar', url: 'https://example.invalid/', size: 1 } } },
      {
        name: 'c:d:1',
        rules: [{ action: 'allow', os: { name: 'plan9' } }],
        downloads: { artifact: { path: 'c/d/1/d-1.jar', url: 'https://example.invalid/', size: 1 } },
      },
    ],
  };
  const { classpath, natives } = v.resolveLibraries(merged, {});
  check('只保留允许的库', classpath.length === 1 && classpath[0].path === 'a/b/1/b-1.jar', `got ${classpath.length}`);
  check('没有 natives 时不报错', natives.length === 0);

  check('maven 坐标转路径', v.mavenRelPath('org.ow2.asm:asm:9.6') === 'org/ow2/asm/asm/9.6/asm-9.6.jar');
  check(
    'maven 带 classifier',
    v.mavenRelPath('org.lwjgl:lwjgl:3.3.1:natives-windows') === 'org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1-natives-windows.jar'
  );
}

console.log('\n== 5. 中文词表 ==');
{
  const cn = await mod('src/core/cn.js');
  check('精确命中「钠」', (cn.lookup('钠')[0] || {}).en === 'sodium');
  check('精确命中「机械动力」', (cn.lookup('机械动力')[0] || {}).en === 'create');
  check('部分匹配「农夫」', cn.lookup('农夫').length > 0);
  check('反查 Sodium 得到中文', cn.revLookup('Sodium') === '钠', cn.revLookup('Sodium'));
  check('反查不存在的返回空', cn.revLookup('No Such Mod Xyz') === '');
  check('hasCJK 判定', cn.hasCJK('钠') === true && cn.hasCJK('sodium') === false);
}

console.log('\n== 6. MC百科文本解析 ==');
{
  const { parseMcmodText } = await mod('src/core/mcmod.js');
  const r = parseMcmodText("[农业]  [FD] 农夫乐事 (Farmer's Delight)\nhttps://www.mcmod.cn/class/2820.html");
  check('解析出一条结果', r.length === 1);
  check('中文名去掉 [FD] 前缀', r[0] && r[0].cn === '农夫乐事', r[0] && r[0].cn);
  check('英文名取最后一对括号', r[0] && r[0].en === "Farmer's Delight", r[0] && r[0].en);
  check('class id 解析正确', r[0] && r[0].id === '2820');
  check('"被百科娘吃掉" 视为无结果', parseMcmodText('你要找的结果可能已经被百科娘吃掉').length === 0);
  check('空字符串不报错', parseMcmodText('').length === 0);
}

console.log('\n== 7. 内存策略 ==');
{
  const { autoMaxMB } = await mod('src/core/memory.js');
  check('4GB 机器至少给 1GB', autoMaxMB(4096) >= 1024, String(autoMaxMB(4096)));
  check('8GB 机器在 1~3GB 之间', autoMaxMB(8192) >= 1024 && autoMaxMB(8192) <= 3072, String(autoMaxMB(8192)));
  check('32GB 机器在 4~8GB 之间', autoMaxMB(32371) >= 4096 && autoMaxMB(32371) <= 8192, String(autoMaxMB(32371)));
  check('128GB 机器上限 8GB', autoMaxMB(131072) <= 8192, String(autoMaxMB(131072)));
  check('结果按 512MB 对齐', autoMaxMB(32371) % 512 === 0, String(autoMaxMB(32371)));
}

console.log('\n== 9. 崩溃诊断规则 ==');
{
  const { diagnose } = await mod('src/core/crash.js');
  const g = path.join(TMP, 'crash-case');
  fs.mkdirSync(path.join(g, 'logs'), { recursive: true });
  const logFile = path.join(g, 'logs', 'latest.log');

  const cases = [
    ['java.lang.UnsupportedClassVersionError: X', 'Java 版本不对'],
    ['java.lang.OutOfMemoryError: Java heap space', '内存不够'],
    ['net.minecraftforge.fml.ModResolutionException: Missing or unsupported mandatory dependencies', '缺前置模组'],
    ['Found duplicate mods: sodium', '模组重复'],
    ['Mixin apply failed: mod x', 'Mixin 冲突（模组不兼容）'],
    ['java.lang.NoSuchMethodError: x.y.Z', '模组与游戏版本不匹配'],
  ];
  for (const [line, expect] of cases) {
    fs.writeFileSync(logFile, `[main/INFO] boot\n${line}\n`, 'utf8');
    const d = diagnose(g, 1);
    check(`识别：${expect}`, d.title === expect, d.title);
  }

  fs.writeFileSync(logFile, 'nothing useful here', 'utf8');
  const d = diagnose(g, 1);
  check('未知错误走兜底', d.title.includes('异常退出'), d.title);
  check('能定位日志文件', d.logPath === logFile);
  check('没有崩溃报告时 crashPath 为空', d.crashPath === '');
}

console.log('\n== 10. natives 归类 ==');
{
  const v = await mod('src/core/version.js');
  const merged = {
    libraries: [
      {
        name: 'org.lwjgl:lwjgl:3.3.3',
        downloads: { artifact: { path: 'a/lwjgl-3.3.3.jar', url: 'https://example.invalid/', size: 1 } },
      },
      {
        name: 'org.lwjgl:lwjgl:3.3.3:natives-windows',
        rules: [{ action: 'allow', os: { name: 'windows' } }],
        downloads: { artifact: { path: 'a/lwjgl-3.3.3-natives-windows.jar', url: 'https://example.invalid/', size: 1 } },
      },
      {
        name: 'org.lwjgl:lwjgl:3.3.3:natives-windows-arm64',
        rules: [{ action: 'allow', os: { name: 'windows' } }],
        downloads: { artifact: { path: 'a/lwjgl-3.3.3-natives-windows-arm64.jar', url: 'https://example.invalid/', size: 1 } },
      },
    ],
  };
  const { classpath, natives } = v.resolveLibraries(merged, {});
  check('natives jar 不进 classpath', classpath.every((c) => !/natives-/.test(c.path)), classpath.map((c) => c.path).join(','));
  check('x64 机器只取无后缀的 natives', natives.length === 1, `got ${natives.length}`);
  check('挑中的是对的', natives[0] && natives[0].path === 'a/lwjgl-3.3.3-natives-windows.jar', natives[0] && natives[0].path);
}

console.log('\n== 11. 路径与数据目录 ==');
{
  const p = await mod('src/core/paths.js');
  p.setMcDir(path.join(TMP, 'mc'));
  const d = p.dirs();
  check('dirs() 跟随 setMcDir', d.mc === path.join(TMP, 'mc'));
  check('versions 在游戏目录下', d.versions.startsWith(d.mc));
  check('数据目录受 MCL_DATA 控制', d.data === TMP);
}

if (process.argv.includes('--net')) {
  console.log('\n== 12. 网络（--net）==');
  const { getManifest } = await mod('src/core/manifest.js');
  try {
    const m = await getManifest();
    check('拿得到版本清单', Array.isArray(m.versions) && m.versions.length > 100, `${m.versions && m.versions.length}`);
  } catch (e) {
    check('拿得到版本清单', false, e.message);
  }
  try {
    const r = await fetch('https://api.modrinth.com/v2/search?query=sodium&limit=1', {
      headers: { 'User-Agent': 'M-DSH-C/smoke' },
    });
    check('Modrinth 可达', r.ok, `HTTP ${r.status}`);
  } catch (e) {
    check('Modrinth 可达', false, e.message);
  }
} else {
  console.log('\n  （跳过网络检查，加 --net 开启）');
}

fs.rmSync(TMP, { recursive: true, force: true });

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
