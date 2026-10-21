import os from 'node:os';

/**
 * 内存分配策略。
 * 自动值取物理内存的 16%，按 512MB 取整，限制在 1~8 GB，
 * 并且永远给系统留够 2GB 以上。
 */
export function autoMaxMB(totalMB) {
  const total = Number(totalMB) || 8192;
  let v = Math.round((total * 0.16) / 512) * 512;
  v = Math.max(1024, Math.min(8192, v));
  if (total - v < 2048) v = Math.max(1024, Math.round((total - 2048) / 512) * 512);
  return v;
}

export function systemMemory() {
  const totalMB = Math.round(os.totalmem() / 1048576);
  const freeMB = Math.round(os.freemem() / 1048576);
  return { totalMB, freeMB, usedMB: totalMB - freeMB };
}

/** 算出实际要用的内存（考虑自动/自定义） */
export function effectiveMemory(settings) {
  const sys = systemMemory();
  const auto = settings.autoMemory !== false;
  let maxMB = auto ? autoMaxMB(sys.totalMB) : Number(settings.maxMemoryMB) || 4096;
  if (maxMB > sys.totalMB - 1024) maxMB = Math.max(1024, sys.totalMB - 1024);
  let minMB = Number(settings.minMemoryMB) || 1024;
  if (minMB > maxMB) minMB = Math.round(maxMB / 2);
  return { maxMB, minMB, auto, ...sys };
}
