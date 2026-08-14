/**
 * IPC 注册中心：UI 与主进程间一律走 IPC，渲染进程不直接接触 Playwright（§11.4）。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { dialog, ipcMain } from 'electron';
import type {
  HumanConfirmChoice,
  HumanConfirmRequest,
  LoginCheck,
  LoginCheckInput,
  LlmTestResult,
  ProfileInput,
  Schedule,
  ScheduleInput,
  SettingsInput,
  TaskEvent,
  TaskTemplate,
} from '@shared/types';
import { EVT, IPC, EXTRACT_PRESET_TEMPLATES } from '@shared/constants';
import {
  createGroup,
  deleteExtractTemplate,
  deleteFlow,
  deleteGroup,
  deleteLoginCheck,
  deleteProxyEntry,
  deleteSchedule,
  deleteTemplate,
  clearProxyPool,
  getDataRoot,
  getLoginCheck,
  getSettings,
  getTask,
  listExtractTemplates,
  listFlows,
  listGroups,
  listLoginChecks,
  listProfiles,
  listProxyPool,
  listSchedules,
  listTasks,
  listTaskSteps,
  listTemplates,
  renameGroup,
  saveSettings,
  upsertExtractTemplate,
  upsertFlow,
  upsertLoginCheck,
  upsertProxyEntry,
  upsertSchedule,
  upsertTemplate,
} from './db';
import { computeNextRun } from './schedule-runner';
import { decryptString, encryptString } from './secure-store';
import { detectSystemChrome } from './chrome-locator';
import { checkProfileProxy, checkProxyConfig, type ProxyConfig } from './proxy-checker';
import { addProxyEntries, checkAllProxies, parseProxyList } from './proxy-pool';
import { suggestFingerprint } from './geo';
import { runLoginCheck } from './login-checker';
import { testWebhook } from './notifier';
import type { BrowserManager } from './browser-manager';
import type { ProfileManager } from './profile-manager';
import type { TaskScheduler } from './task-scheduler';
import type { LLMClient } from './llm-client';
import type { AgentHooks } from './agent-core';
import { getMainWindow } from './window-manager';

interface IpcDeps {
  browsers: BrowserManager;
  profiles: ProfileManager;
  scheduler: TaskScheduler;
  llm: LLMClient;
}

/** 广播任务事件到渲染进程 */
export function broadcastTaskEvent(event: TaskEvent): void {
  getMainWindow()?.webContents.send(EVT.taskEvent, event);
}

/**
 * §9 Human-in-the-Loop 桥：Agent 请求 → 渲染进程弹窗 → 用户选择回传。
 * 弹窗内容：当前页面截图 + Agent 的推理过程（最近几步）+ 继续/终止按钮。
 */
class HumanConfirmBridge {
  private readonly pending = new Map<string, (choice: HumanConfirmChoice) => void>();

  request(req: Omit<HumanConfirmRequest, 'requestId'>): Promise<HumanConfirmChoice> {
    const requestId = `${req.taskId}-${Date.now()}`;
    return new Promise((resolve) => {
      this.pending.set(requestId, resolve);
      getMainWindow()?.webContents.send(EVT.humanConfirmRequest, { ...req, requestId });
      // 兜底：窗口不存在时 60s 后自动终止，避免任务悬挂
      setTimeout(() => {
        if (this.pending.delete(requestId)) resolve('terminate');
      }, 10 * 60 * 1000);
    });
  }

  respond(requestId: string, choice: HumanConfirmChoice): void {
    const resolve = this.pending.get(requestId);
    if (resolve) {
      this.pending.delete(requestId);
      resolve(choice);
    }
  }
}

export function buildAgentHooks(bridge: HumanConfirmBridge, schedulerRef: { isCancelled(id: string): boolean }): AgentHooks {
  return {
    onStep: (step) => broadcastTaskEvent({ type: 'step', taskId: step.taskId, step }),
    requestHumanConfirm: (input) => bridge.request(input),
    isCancelled: (taskId) => schedulerRef.isCancelled(taskId),
  };
}

export { HumanConfirmBridge };

export function registerIpcHandlers(deps: IpcDeps, bridge: HumanConfirmBridge): void {
  // ---------------------------------------------------------------- settings
  ipcMain.handle(IPC.settingsGet, () => {
    const s = getSettings();
    // 密钥不下发：只告诉 UI 是否已配置
    const { llmApiKeyEnc, ...rest } = s;
    return { ...rest, hasApiKey: Boolean(llmApiKeyEnc) };
  });

  ipcMain.handle(IPC.settingsSet, (_e, input: SettingsInput) => {
    const current = getSettings();
    const { llmApiKey, ...rest } = input;
    const next = {
      ...current,
      ...rest,
      llmApiKeyEnc:
        llmApiKey === undefined || llmApiKey === ''
          ? current.llmApiKeyEnc // 空输入 = 不改动旧密钥
          : encryptString(llmApiKey),
    };
    saveSettings(next);
    deps.scheduler.setBrowserConcurrency(next.maxConcurrentProfiles);
    return { ok: true };
  });

  ipcMain.handle(IPC.settingsTestLlm, async (): Promise<LlmTestResult> => {
    const s = getSettings();
    const apiKeyEnc = s.llmApiKeyEnc;
    if (!apiKeyEnc) return { ok: false, error: '尚未配置 API Key' };
    const started = Date.now();
    try {
      await deps.llm.chat(s, decryptString(apiKeyEnc), [
        { role: 'user', content: '回复 "ok" 两个字即可。' },
      ]);
      return { ok: true, latencyMs: Date.now() - started, model: s.llmModel };
    } catch (err) {
      return { ok: false, error: (err as Error).message.slice(0, 300) };
    }
  });

  // Webhook 测试（设置页）：优先用表单里的新地址，否则用已保存的
  ipcMain.handle(IPC.settingsTestWebhook, (_e, url?: string) =>
    testWebhook(url ?? getSettings().webhookUrl),
  );

  // ---------------------------------------------------------------- profiles
  ipcMain.handle(IPC.profilesList, () => listProfiles());
  ipcMain.handle(IPC.profilesCreate, (_e, input: ProfileInput) => deps.profiles.create(input));
  ipcMain.handle(IPC.profilesUpdate, (_e, id: string, patch: Partial<ProfileInput>) => {
    // 代理密码明文经 '__encrypt__:' 前缀通道传入，主进程负责 safeStorage 加密（ADR-6）
    if (patch.proxyPasswordEnc?.startsWith('__encrypt__:')) {
      patch = { ...patch, proxyPasswordEnc: encryptString(patch.proxyPasswordEnc.slice('__encrypt__:'.length)) };
    }
    return deps.profiles.update(id, patch);
  });
  ipcMain.handle(IPC.profilesDelete, (_e, id: string) => deps.profiles.remove(id));
  ipcMain.handle(IPC.profilesClone, (_e, id: string) => deps.profiles.clone(id));

  // 手动模式：强制 headed，用于人工登录（验收场景 2）等
  ipcMain.handle(IPC.profilesLaunch, async (_e, id: string) => {
    const profile = deps.profiles.get(id);
    if (!profile) throw new Error('Profile 不存在');
    await deps.browsers.launch(profile, getSettings(), true);
    return { ok: true };
  });

  ipcMain.handle(IPC.profilesStop, async (_e, id: string) => {
    await deps.browsers.close(id);
    return { ok: true };
  });

  // 指纹自测：打开公开检测页，肉眼核对指纹一致性
  ipcMain.handle(IPC.profilesSelfTest, async (_e, id: string) => {
    const profile = deps.profiles.get(id);
    if (!profile) throw new Error('Profile 不存在');
    await deps.browsers.launch(profile, getSettings(), true);
    const page = await deps.browsers.getPage(id);
    await page.goto('https://bot.sannysoft.com/', { waitUntil: 'domcontentloaded' }).catch(() => undefined);
    await page.bringToFront();
    return { ok: true };
  });

  ipcMain.handle(IPC.profilesExport, (_e, id: string) => deps.profiles.export(id));
  ipcMain.handle(IPC.profilesImport, (_e, json: string) => deps.profiles.import(json));

  // 代理检测：验证代理可用性，返回出口 IP + 延迟，结果持久化到 Profile
  ipcMain.handle(IPC.profilesCheckProxy, async (_e, id: string) => {
    const profile = deps.profiles.get(id);
    if (!profile) throw new Error('Profile 不存在');
    const result = await checkProfileProxy(profile, getSettings());
    deps.profiles.update(id, { proxyCheck: result });
    return result;
  });

  // 根据代理出口 IP 自动生成时区/语言指纹建议（表单未保存时也能用：传代理配置快照）
  ipcMain.handle(IPC.profilesAutoFingerprint, async (_e, proxy: ProxyConfig) => {
    const ip = await checkProxyConfig(proxy, getSettings());
    return suggestFingerprint(ip);
  });

  // Cookie 导出（登录态迁移/备份）：弹出保存对话框
  ipcMain.handle(IPC.profilesExportCookies, async (_e, id: string) => {
    const profile = deps.profiles.get(id);
    if (!profile) throw new Error('Profile 不存在');
    await deps.browsers.launch(profile, getSettings()); // 未启动则启动；已运行直接复用
    const cookies = await deps.browsers.exportCookies(id);
    const win = getMainWindow();
    if (!win) throw new Error('主窗口不存在');
    const dlg = await dialog.showSaveDialog(win, {
      title: '导出 Cookie',
      defaultPath: `cookies-${profile.name.replace(/[\\/:*?"<>|]/g, '_')}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (dlg.canceled || !dlg.filePath) return { ok: false, cancelled: true };
    fs.writeFileSync(
      dlg.filePath,
      JSON.stringify(
        { format: 'matrix-agent-cookies@1', profileName: profile.name, exportedAt: new Date().toISOString(), cookies },
        null,
        2,
      ),
      'utf8',
    );
    return { ok: true, count: cookies.length, file: dlg.filePath };
  });

  // Cookie 导入：弹出选择对话框，回灌到该 Profile 的浏览器环境
  ipcMain.handle(IPC.profilesImportCookies, async (_e, id: string) => {
    const profile = deps.profiles.get(id);
    if (!profile) throw new Error('Profile 不存在');
    const win = getMainWindow();
    if (!win) throw new Error('主窗口不存在');
    const dlg = await dialog.showOpenDialog(win, {
      title: '导入 Cookie',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (dlg.canceled || dlg.filePaths.length === 0) return { ok: false, cancelled: true };
    const raw = JSON.parse(fs.readFileSync(dlg.filePaths[0], 'utf8')) as { cookies?: unknown } | unknown[];
    const cookies = (Array.isArray(raw) ? raw : raw.cookies) as Parameters<BrowserManager['importCookies']>[1];
    if (!Array.isArray(cookies) || cookies.length === 0) throw new Error('文件中没有 Cookie 数据');
    await deps.browsers.launch(profile, getSettings());
    const count = await deps.browsers.importCookies(id, cookies);
    return { ok: true, count };
  });

  // ---------------------------------------------------------------- login checks（登录态检测）
  ipcMain.handle(IPC.loginChecksList, (_e, profileId?: string) => listLoginChecks(profileId));
  ipcMain.handle(IPC.loginChecksCreate, (_e, input: LoginCheckInput) => {
    if (!input.name?.trim() || !input.url?.trim() || !input.target?.trim()) {
      throw new Error('名称、检测页 URL、检测目标都不能为空');
    }
    const c: LoginCheck = {
      ...input,
      id: crypto.randomUUID(),
      status: 'unknown',
      createdAt: new Date().toISOString(),
    };
    upsertLoginCheck(c);
    return c;
  });
  ipcMain.handle(IPC.loginChecksDelete, (_e, id: string) => {
    deleteLoginCheck(id);
    return { ok: true };
  });
  ipcMain.handle(IPC.loginChecksRun, async (_e, id: string) => {
    const check = getLoginCheck(id);
    if (!check) throw new Error('检测项不存在');
    const profile = deps.profiles.get(check.profileId);
    if (!profile) throw new Error('Profile 不存在');
    try {
      const outcome = await runLoginCheck(deps.browsers, profile, check, getSettings());
      check.status = outcome.status;
      check.detail = outcome.detail;
    } catch (err) {
      check.status = 'offline';
      check.detail = `检测失败：${(err as Error).message.slice(0, 200)}`;
    }
    check.lastCheckedAt = new Date().toISOString();
    upsertLoginCheck(check);
    return check;
  });

  // ---------------------------------------------------------------- profile groups（分组）
  ipcMain.handle(IPC.groupsList, () => listGroups());
  ipcMain.handle(IPC.groupsCreate, (_e, name: string) => {
    if (!name?.trim()) throw new Error('分组名不能为空');
    return createGroup(crypto.randomUUID(), name.trim());
  });
  ipcMain.handle(IPC.groupsRename, (_e, id: string, name: string) => {
    if (!name?.trim()) throw new Error('分组名不能为空');
    renameGroup(id, name.trim());
    return { ok: true };
  });
  ipcMain.handle(IPC.groupsDelete, (_e, id: string) => {
    deleteGroup(id); // 组内 Profile 落到「未分组」
    return { ok: true };
  });

  // ---------------------------------------------------------------- flows（流程复用）
  ipcMain.handle(IPC.flowsList, () => listFlows());
  ipcMain.handle(IPC.flowsRun, (_e, flowId: string, profileId: string) => {
    if (!profileId) throw new Error('请选择回放的 Profile');
    return deps.scheduler.submitFlow(flowId, profileId);
  });
  ipcMain.handle(IPC.flowsDelete, (_e, id: string) => {
    deleteFlow(id);
    return { ok: true };
  });
  // 可视化编辑流程：整存 steps（删步/调序/改参数在渲染端完成后整存）
  ipcMain.handle(IPC.flowsUpdate, (_e, id: string, patch: { name?: string; steps?: unknown[] }) => {
    const f = listFlows().find((x) => x.id === id);
    if (!f) throw new Error('流程不存在');
    if (patch.name !== undefined) f.name = patch.name.trim() || f.name;
    if (patch.steps !== undefined) {
      if (!Array.isArray(patch.steps) || patch.steps.length === 0) throw new Error('流程至少保留一步');
      f.steps = patch.steps as typeof f.steps;
    }
    upsertFlow(f);
    return f;
  });

  // ---------------------------------------------------------------- tasks
  ipcMain.handle(
    IPC.tasksCreate,
    (
      _e,
      input: {
        name: string;
        requiresAuth: boolean;
        profileId?: string;
        profileIds?: string[];
        saveFlowAs?: string; // 跑完存为流程
        collectFields?: string[]; // 结构化采集字段
      },
    ) => {
      if (!input.name?.trim()) throw new Error('任务指令不能为空');
      return deps.scheduler.submit(input.name.trim(), input.requiresAuth, input.profileId, input.profileIds, undefined, {
        saveFlowAs: input.saveFlowAs,
        collectFields: input.collectFields,
      });
    },
  );

  ipcMain.handle(IPC.tasksList, () =>
    listTasks(200).map((t) => ({ ...t, steps: listTaskSteps(t.id) })),
  );
  ipcMain.handle(IPC.tasksGet, (_e, id: string) => {
    const task = getTask(id);
    return task ? { ...task, steps: listTaskSteps(id) } : null;
  });
  // 批量任务：一条指令 × N 个 Profile
  ipcMain.handle(
    IPC.tasksCreateBatch,
    (_e, input: { name: string; requiresAuth: boolean; profileIds: string[] }) => {
      if (!input.name?.trim()) throw new Error('任务指令不能为空');
      if (!input.profileIds?.length) throw new Error('批量任务至少选择一个 Profile');
      return deps.scheduler.submitBatch(input.name.trim(), input.requiresAuth, input.profileIds);
    },
  );

  // ---------------------------------------------------------------- schedules（定时任务）
  ipcMain.handle(IPC.schedulesList, () => listSchedules());
  ipcMain.handle(IPC.schedulesCreate, (_e, input: ScheduleInput) => {
    const s: Schedule = {
      ...input,
      id: crypto.randomUUID(),
      nextRunAt: computeNextRun(input.spec),
      createdAt: new Date().toISOString(),
    };
    upsertSchedule(s);
    return s;
  });
  ipcMain.handle(IPC.schedulesUpdate, (_e, id: string, patch: Partial<ScheduleInput>) => {
    const s = listSchedules().find((x) => x.id === id);
    if (!s) throw new Error('Schedule 不存在');
    const next = { ...s, ...patch };
    if (patch.spec) next.nextRunAt = computeNextRun(patch.spec);
    upsertSchedule(next);
    return next;
  });
  ipcMain.handle(IPC.schedulesToggle, (_e, id: string, enabled: boolean) => {
    const s = listSchedules().find((x) => x.id === id);
    if (!s) throw new Error('Schedule 不存在');
    s.enabled = enabled;
    if (enabled) s.nextRunAt = computeNextRun(s.spec); // 重新启用从下一个周期开始
    upsertSchedule(s);
    return { ok: true };
  });
  ipcMain.handle(IPC.schedulesDelete, (_e, id: string) => {
    deleteSchedule(id);
    return { ok: true };
  });

  // ---------------------------------------------------------------- templates（任务模板）
  ipcMain.handle(IPC.templatesList, () => listTemplates());
  ipcMain.handle(IPC.templatesCreate, (_e, input: { name: string; instruction: string; requiresAuth: boolean }) => {
    const t: TaskTemplate = { ...input, id: crypto.randomUUID(), createdAt: new Date().toISOString() };
    upsertTemplate(t);
    return t;
  });
  ipcMain.handle(IPC.templatesDelete, (_e, id: string) => {
    deleteTemplate(id);
    return { ok: true };
  });

  // ---------------------------------------------------------------- proxy pool（全局代理池）
  ipcMain.handle(IPC.proxyPoolList, () => listProxyPool());
  // 批量导入：文本（每行一条 host:port[:user:pass] 或 protocol://host:port:user:pass）
  ipcMain.handle(IPC.proxyPoolAdd, (_e, text: string) => {
    if (!text?.trim()) throw new Error('导入内容为空');
    const { entries, skipped } = parseProxyList(text);
    const added = addProxyEntries(entries);
    return { added, skipped: skipped.length, skippedSamples: skipped.slice(0, 5) };
  });
  ipcMain.handle(IPC.proxyPoolDelete, (_e, id: string) => {
    deleteProxyEntry(id);
    return { ok: true };
  });
  ipcMain.handle(IPC.proxyPoolClear, () => {
    const n = clearProxyPool();
    return { ok: true, cleared: n };
  });
  // 一键验证全部（并发 PROXY_CHECK_CONCURRENCY，结果写回）
  ipcMain.handle(IPC.proxyPoolCheckAll, async () => {
    const summary = await checkAllProxies(getSettings());
    return { ...summary, list: listProxyPool() };
  });

  // ---------------------------------------------------------------- extract templates（采集模板）
  ipcMain.handle(IPC.extractTemplatesList, () => {
    // 内置模板 + 用户自定义合并返回
    const builtin = EXTRACT_PRESET_TEMPLATES.map((t, i) => ({
      id: `__builtin_${i}`,
      name: t.name,
      category: t.category,
      fields: t.fields,
      instruction: t.instruction,
      builtin: true,
      createdAt: '',
    }));
    return [...builtin, ...listExtractTemplates()];
  });
  ipcMain.handle(
    IPC.extractTemplatesCreate,
    (_e, input: { name: string; category: string; fields: string[]; instruction: string }) => {
      if (!input.name?.trim() || !input.fields?.length) throw new Error('模板名称和采集字段不能为空');
      const t = {
        id: crypto.randomUUID(),
        name: input.name.trim(),
        category: input.category?.trim() || '通用',
        fields: input.fields.map((s) => s.trim()).filter(Boolean),
        instruction: input.instruction ?? '',
        builtin: false,
        createdAt: new Date().toISOString(),
      };
      upsertExtractTemplate(t);
      return t;
    },
  );
  ipcMain.handle(IPC.extractTemplatesDelete, (_e, id: string) => {
    deleteExtractTemplate(id);
    return { ok: true };
  });

  ipcMain.handle(IPC.tasksCancel, (_e, id: string) => {
    deps.scheduler.cancel(id);
    return { ok: true };
  });
  ipcMain.handle(IPC.tasksRetry, (_e, id: string) => ({ ok: deps.scheduler.retry(id) }));
  ipcMain.handle(IPC.tasksResolveInterrupted, (_e, id: string, action: 'resume' | 'discard') => {
    deps.scheduler.resolveInterrupted(id, action);
    return { ok: true };
  });

  // §9 实时查看（MVP）：对应 Chrome 窗口置前
  ipcMain.handle(IPC.tasksLiveView, async (_e, taskId: string) => {
    const task = getTask(taskId);
    if (!task?.profileId) throw new Error('任务未绑定 Profile');
    await deps.browsers.bringToFront(task.profileId);
    return { ok: true };
  });

  // 读取落盘的完整快照（路径安全校验：必须在 logs 目录内）
  ipcMain.handle(IPC.tasksReadSnapshot, (_e, file: string) => {
    const logsRoot = path.join(getDataRoot(), 'logs');
    const resolved = path.resolve(file);
    if (!resolved.startsWith(path.resolve(logsRoot))) throw new Error('非法路径');
    if (!fs.existsSync(resolved)) return '';
    return fs.readFileSync(resolved, 'utf8');
  });

  // 读取步骤截图（base64 data URL；同样的 logs 目录安全校验）
  ipcMain.handle(IPC.tasksReadScreenshot, (_e, file: string) => {
    const logsRoot = path.join(getDataRoot(), 'logs');
    const resolved = path.resolve(file);
    if (!resolved.startsWith(path.resolve(logsRoot))) throw new Error('非法路径');
    if (!fs.existsSync(resolved)) return null;
    return `data:image/jpeg;base64,${fs.readFileSync(resolved).toString('base64')}`;
  });

  // ---------------------------------------------------------------- human confirm
  ipcMain.handle(IPC.humanConfirmRespond, (_e, requestId: string, choice: HumanConfirmChoice) => {
    bridge.respond(requestId, choice);
    return { ok: true };
  });

  // ---------------------------------------------------------------- system
  ipcMain.handle(IPC.systemDetectChrome, () => ({
    detected: detectSystemChrome(),
    current: getSettings().chromeExecutablePath ?? null,
  }));
}
