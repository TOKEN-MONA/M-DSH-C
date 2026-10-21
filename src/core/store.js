import fs from 'node:fs';
import path from 'node:path';
import { dirs, DATA_ROOT, ensureAll } from './paths.js';

const DEFAULTS = {
  downloadSource: 'auto', // auto | official | mirror
  downloadThreads: 32,
  maxMemoryMB: 4096,
  minMemoryMB: 1024,
  javaPath: '',
  gameDir: '',
  jvmArgs: '',
  windowWidth: 854,
  windowHeight: 480,
  fullscreen: false,
  language: 'zh_CN',
  clientId: '', // 微软登录用的 Azure 应用 ID，用户自填
  curseforgeKey: '', // CurseForge API Key（可选）
  selectedVersion: '',
  showSnapshot: false,
};

let settings = { ...DEFAULTS };
let versions = {}; // id -> meta
let accounts = { current: null, list: [] };

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

export function loadAll() {
  ensureAll();
  const d = dirs();
  settings = { ...DEFAULTS, ...readJson(d.settings, {}) };
  versions = readJson(d.versionsMeta, {});
  accounts = { current: null, list: [], ...readJson(d.accounts, {}) };
  return { settings, versions, accounts };
}

export function saveSettings(patchObj = {}) {
  settings = { ...settings, ...patchObj };
  writeJson(dirs().settings, settings);
  return settings;
}

export function getSettings() {
  return settings;
}

export function saveVersions() {
  writeJson(dirs().versionsMeta, versions);
}

export function getVersionMeta(id) {
  return versions[id] || null;
}

export function setVersionMeta(id, meta) {
  versions[id] = { ...(versions[id] || {}), ...meta, id };
  saveVersions();
  return versions[id];
}

export function removeVersionMeta(id) {
  delete versions[id];
  saveVersions();
}

export function listVersionMeta() {
  return Object.values(versions);
}

export function getAccounts() {
  return accounts;
}

export function saveAccounts() {
  writeJson(dirs().accounts, accounts);
}

export function saveAccountsFile() {
  writeJson(path.join(DATA_ROOT, 'accounts.json'), accounts);
}

export { DEFAULTS };
