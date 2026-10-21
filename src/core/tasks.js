import fs from 'node:fs';
import { EventEmitter } from 'node:events';

export const bus = new EventEmitter();
bus.setMaxListeners(50);

const tasks = new Map();
let seq = 0;

export function createTask(title) {
  const id = `t${++seq}-${Date.now().toString(36)}`;
  const task = {
    id,
    title,
    status: 'running', // running | done | error | cancelled
    stage: '准备中',
    done: 0,
    total: 0,
    percent: 0,
    speed: 0,
    logs: [],
    error: null,
    startedAt: Date.now(),
    finishedAt: null,
  };
  tasks.set(id, task);
  emit(task);
  return task;
}

function emit(task) {
  bus.emit('task', { ...task, logs: task.logs.slice(-400) });
}

export function patch(task, fields) {
  Object.assign(task, fields);
  if (task.total > 0) task.percent = Math.min(100, Math.round((task.done / task.total) * 1000) / 10);
  emit(task);
  return task;
}

export function setStage(task, stage) {
  return patch(task, { stage });
}

export function log(task, line) {
  const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  task.logs.push(`[${ts}] ${line}`);
  if (task.logs.length > 2000) task.logs.splice(0, task.logs.length - 2000);
  bus.emit('task-log', { id: task.id, line: `[${ts}] ${line}` });
}

export function finish(task, error) {
  patch(task, {
    status: error ? 'error' : 'done',
    error: error ? String(error.message || error) : null,
    stage: error ? '失败' : '完成',
    percent: error ? task.percent : 100,
    finishedAt: Date.now(),
  });
  return task;
}

export function getTask(id) {
  return tasks.get(id);
}

export function listTasks() {
  return [...tasks.values()].slice(-12).reverse().map((t) => ({ ...t, logs: t.logs.slice(-400) }));
}
