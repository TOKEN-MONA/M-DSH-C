import fs from 'node:fs';
import path from 'node:path';

/**
 * 崩溃诊断：读 latest.log 和最近的 crash-report，按已知特征给出人话结论。
 * 规则从最常见到少见排列，命中第一条就停。
 */
const RULES = [
  {
    re: /UnsupportedClassVersionError|class file (?:major )?version|requires at least Java|has been compiled by a more recent version/i,
    title: 'Java 版本不对',
    hint: '这个版本需要更新的 Java：1.17~1.20.4 用 Java 17，1.20.5+ 用 Java 21。到「设置 → Java」换一个，或让启动器下载。',
  },
  {
    re: /OutOfMemoryError|Java heap space|GC overhead limit exceeded/i,
    title: '内存不够',
    hint: 'Xmx 给小了，或者整合包装的东西太多。到「设置 → 内存分配」调大（4~8 GB 的包给 6~8 GB）。',
  },
  {
    re: /ModResolutionException|Missing or unsupported mandatory dependencies|which is missing|requires .* which is not installed/i,
    title: '缺前置模组',
    hint: '有模组缺依赖。到模组列表看哪个报错，回下载页搜它的前置装上（详情页有「前置资源」入口）。',
  },
  {
    re: /Duplicate mods|DuplicateModsFoundException|Found duplicate mods/i,
    title: '模组重复',
    hint: 'mods 文件夹里有两个同名模组（常见是手动装了一次、又自动装了一次）。删掉旧的那个。',
  },
  {
    re: /Mixin apply failed|MixinTransformerError|InvalidInjectionException|MixinException/i,
    title: 'Mixin 冲突（模组不兼容）',
    hint: '多半是某个模组和当前游戏版本或加载器版本对不上。留意日志里 "Mixin apply failed" 后面那个模组名。',
  },
  {
    re: /NoSuchMethodError|NoClassDefFoundError|NoSuchFieldError|AbstractMethodError/i,
    title: '模组与游戏版本不匹配',
    hint: '某个模组不是给这个 MC 版本编的。日志里 "Caused by" 后面会指出是哪个类/哪个模组。',
  },
  {
    re: /EXCEPTION_ACCESS_VIOLATION|HARD CRASH|hs_err_pid|Problematic frame/i,
    title: '崩溃在原生层（显卡驱动 / 系统库）',
    hint: '常见于显卡驱动过旧、或者用了和系统不匹配的 OpenGL 库。更新显卡驱动，或试试关闭光影/降低设置。',
  },
  {
    re: /GLFW error|Failed to create window|Pixel format not accelerated/i,
    title: '创建窗口失败（显卡/驱动）',
    hint: '显卡驱动异常或远程桌面环境。更新驱动，别在远程桌面里跑游戏。',
  },
  {
    re: /Could not find or load main class|ClassNotFoundException: net\.minecraft/i,
    title: '版本文件不完整',
    hint: '客户端的 jar 或依赖库缺失。在版本列表里对这个版本点「重新安装」。',
  },
  {
    re: /java\.lang\.IllegalStateException:.*already (running|in use)|Failed to lock/i,
    title: '游戏已经在运行',
    hint: '同一个实例开了两次，或者上次的进程没退干净。任务管理器里结束残留的 java.exe。',
  },
];

/** 读文件尾部若干字节（日志可能几十 MB） */
export function tailFile(file, maxBytes = 200000) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - maxBytes);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

export function latestCrashReport(gameDir) {
  const dir = path.join(gameDir, 'crash-reports');
  try {
    const list = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.txt'))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    return list.length ? path.join(dir, list[0].f) : null;
  } catch {
    return null;
  }
}

/** 从日志里挑一行最能说明问题的 */
function pickExcerpt(blob) {
  const lines = blob.split(/\r?\n/).filter((l) => l.trim());
  const pats = [
    /Caused by: .+/,
    /Exception in thread .+/,
    /^[a-z][\w.]*(Exception|Error): .+/,
    /^\s+at [\w.$]+\(.*\)/,
  ];
  for (const p of pats) {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (p.test(lines[i])) return lines[i].trim().slice(0, 300);
    }
  }
  return '';
}

/**
 * @returns {{title:string,hint:string,detail:string,excerpt:string,logPath:string,crashPath:string,ruleId:string}}
 */
export function diagnose(gameDir, exitCode = 1) {
  const logPath = path.join(gameDir, 'logs', 'latest.log');
  const crashPath = latestCrashReport(gameDir);
  const logText = tailFile(logPath);
  const crashText = crashPath ? tailFile(crashPath, 120000) : '';
  const blob = `${crashText}\n${logText}`;

  let rule = null;
  for (const r of RULES) {
    if (r.re.test(blob)) {
      rule = r;
      break;
    }
  }

  const descMatch = /Description:\s*(.+)/.exec(crashText) || /Description:\s*(.+)/.exec(logText);
  const detail = descMatch ? descMatch[1].trim().slice(0, 200) : '';

  return {
    title: rule ? rule.title : exitCode === 1 ? '游戏异常退出' : `游戏异常退出（退出码 ${exitCode}）`,
    hint: rule ? rule.hint : '日志里没匹配到已知特征，去下面的日志里看最后几十行。',
    detail,
    excerpt: pickExcerpt(blob),
    ruleId: rule ? rule.re.source.slice(0, 40) : '',
    logPath: fs.existsSync(logPath) ? logPath : '',
    crashPath: crashPath || '',
  };
}
