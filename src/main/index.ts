/**
 * Electron 主进程入口（含 §8.3 Recovery 启动序列）。
 *
 * 启动顺序：app ready → 初始化 DB → Recovery（任务修复 / 孤儿进程 / 锁文件）
 * → 装配各管理器 → 注册 IPC → 创建主窗口 → 调度器恢复 pending 任务。
 */
import { app, protocol, net } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { initDatabase, getSettings, getDataRoot } from './db';
import { runRecovery } from './recovery';
import { createMainWindow } from './window-manager';
import { BrowserManager } from './browser-manager';
import { ProfileManager } from './profile-manager';
import { LLMClient } from './llm-client';
import { TaskScheduler } from './task-scheduler';
import { Semaphore } from './semaphore';
import {
  broadcastTaskEvent,
  buildAgentHooks,
  HumanConfirmBridge,
  registerIpcHandlers,
} from './ipc';
import { startScheduleRunner } from './schedule-runner';
import { notifyTaskTerminal } from './notifier';
import { getTask } from './db';

const browsers = new BrowserManager();

async function bootstrap(): Promise<void> {
  await app.whenReady();

  // 1. 数据层
  initDatabase();
  const settings = getSettings();

  // 1.5 §6.6 录像回放：media:// 协议 → logs 目录（media://recording/<taskId>/recording.webm）
  protocol.handle('media', (req) => {
    try {
      const url = new URL(req.url);
      const rel = decodeURIComponent(url.pathname.replace(/^\//, ''));
      const logsRoot = path.resolve(path.join(getDataRoot(), 'logs'));
      const file = path.resolve(path.join(logsRoot, rel));
      if (!file.startsWith(logsRoot + path.sep)) return new Response('forbidden', { status: 403 });
      return net.fetch(pathToFileURL(file).toString());
    } catch {
      return new Response('bad request', { status: 400 });
    }
  });

  // 2. §8.3 崩溃恢复（提前至 MVP）
  const report = await runRecovery();
  console.log('[bootstrap] Recovery 完成:', report);

  // 3. 装配
  const profiles = new ProfileManager((id) => browsers.close(id));
  const llmSemaphore = new Semaphore(settings.llmConcurrency);
  const llm = new LLMClient(llmSemaphore);
  const bridge = new HumanConfirmBridge();

  // 调度器需要回指 hooks.isCancelled，先用引用占位再构造
  let scheduler!: TaskScheduler;
  const hooks = buildAgentHooks(bridge, {
    isCancelled: (id) => scheduler?.isCancelled(id) ?? false,
  });
  scheduler = new TaskScheduler(browsers, llm, hooks, {
    onStatus: (taskId, status, errorMessage) => {
      broadcastTaskEvent({ type: 'status', taskId, status, errorMessage });
      // 终态通知（桌面 + Webhook；批量子任务不单独通知，notifier 内部过滤）
      if (status === 'completed' || status === 'failed') {
        const task = getTask(taskId);
        if (task) notifyTaskTerminal(task, getSettings());
      }
    },
  }, settings.maxConcurrentProfiles);

  registerIpcHandlers({ browsers, profiles, scheduler, llm }, bridge);

  // 4. 主窗口
  createMainWindow();

  // 5. §8.3-4 调度恢复：pending 任务重新入队
  const recovered = scheduler.recoverPending();
  if (recovered > 0) console.log(`[bootstrap] ${recovered} 个 pending 任务重新入队`);

  // 6. 定时任务引擎：到点自动下发（>1 个 Profile 走批量任务）
  startScheduleRunner((s) => {
    if (s.profileIds.length > 1) {
      scheduler.submitBatch(s.instruction, s.requiresAuth, s.profileIds);
    } else {
      scheduler.submit(s.instruction, s.requiresAuth, s.profileIds[0]);
    }
  });

  app.on('activate', () => {
    const { BrowserWindow } = require('electron') as typeof import('electron');
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
  // 尽力关闭所有浏览器实例，避免孤儿 Chrome（§8.3 的第二道保险）
  event.preventDefault();
  void browsers
    .closeAll()
    .catch(() => undefined)
    .finally(() => {
      app.exit(0);
    });
});

void bootstrap();
