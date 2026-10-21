import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DATA_ROOT = process.env.MCL_DATA ? path.resolve(process.env.MCL_DATA) : path.join(APP_ROOT, '.data');
export const UI_ROOT = path.join(APP_ROOT, 'src', 'ui');

const DEFAULT_MC = path.join(DATA_ROOT, '.minecraft');
let mcDir = DEFAULT_MC;

export function getMcDir() {
  return mcDir;
}

/** 用户可在设置里把游戏目录指到别处（如现成的 .minecraft） */
export function setMcDir(dir) {
  mcDir = dir && dir.trim() ? path.resolve(dir.trim()) : DEFAULT_MC;
  return mcDir;
}

export function dirs() {
  const mc = mcDir;
  return {
    data: DATA_ROOT,
    mc,
    versions: path.join(mc, 'versions'),
    libraries: path.join(mc, 'libraries'),
    assets: path.join(mc, 'assets'),
    java: path.join(mc, 'java'),
    cache: path.join(DATA_ROOT, 'cache'),
    browser: path.join(DATA_ROOT, 'browser'),
    settings: path.join(DATA_ROOT, 'settings.json'),
    accounts: path.join(DATA_ROOT, 'accounts.json'),
    versionsMeta: path.join(DATA_ROOT, 'versions.json'),
  };
}

export function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

export function ensureAll() {
  const d = dirs();
  ensureDir(d.data);
  ensureDir(d.mc);
  ensureDir(d.versions);
  ensureDir(d.libraries);
  ensureDir(d.assets);
  ensureDir(d.cache);
}
