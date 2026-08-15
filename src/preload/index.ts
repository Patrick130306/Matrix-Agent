/**
 * 预加载脚本：contextBridge 暴露白名单 API（contextIsolation 开启，渲染进程无 Node 能力）。
 */
import { contextBridge, ipcRenderer } from 'electron';
import { EVT, IPC } from '@shared/constants';
import type {
  ExtractTemplate,
  Flow,
  GeoFingerprintSuggestion,
  HumanConfirmChoice,
  HumanConfirmRequest,
  LoginCheck,
  LoginCheckInput,
  LlmTestResult,
  Profile,
  ProfileGroup,
  ProfileInput,
  ProxyCheckResult,
  ProxyPoolEntry,
  ProxyType,
  Schedule,
  ScheduleInput,
  SettingsInput,
  Task,
  TaskEvent,
  TaskStep,
  TaskTemplate,
} from '@shared/types';

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args) as Promise<T>;
}

function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, payload: T) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api = {
  settings: {
    get: () => invoke<Omit<import('@shared/types').Settings, 'llmApiKeyEnc'> & { hasApiKey: boolean }>(IPC.settingsGet),
    set: (input: SettingsInput) => invoke(IPC.settingsSet, input),
    testLlm: () => invoke<LlmTestResult>(IPC.settingsTestLlm),
    testWebhook: (url?: string) =>
      invoke<{ ok: boolean; status?: number; error?: string }>(IPC.settingsTestWebhook, url),
  },
  profiles: {
    list: () => invoke<Profile[]>(IPC.profilesList),
    create: (input: ProfileInput) => invoke<Profile>(IPC.profilesCreate, input),
    update: (id: string, patch: Partial<ProfileInput>) => invoke<Profile>(IPC.profilesUpdate, id, patch),
    delete: (id: string) => invoke(IPC.profilesDelete, id),
    clone: (id: string) => invoke<Profile>(IPC.profilesClone, id),
    launch: (id: string) => invoke(IPC.profilesLaunch, id),
    stop: (id: string) => invoke(IPC.profilesStop, id),
    selfTest: (id: string) => invoke(IPC.profilesSelfTest, id),
    export: (id: string) => invoke<string>(IPC.profilesExport, id),
    import: (json: string) => invoke<Profile>(IPC.profilesImport, json),
    batchCreate: (input: { prefix: string; count: number; poolIds?: string[] }) =>
      invoke<{ profiles: Profile[]; fingerprintApplied: number }>(IPC.profilesBatchCreate, input),
    checkProxy: (id: string) => invoke<ProxyCheckResult>(IPC.profilesCheckProxy, id),
    autoFingerprint: (proxy: {
      type: ProxyType;
      host: string;
      port: number;
      username?: string;
      password?: string;
    }) => invoke<GeoFingerprintSuggestion>(IPC.profilesAutoFingerprint, proxy),
    exportCookies: (id: string) =>
      invoke<{ ok: boolean; cancelled?: boolean; count?: number; file?: string }>(IPC.profilesExportCookies, id),
    importCookies: (id: string) =>
      invoke<{ ok: boolean; cancelled?: boolean; count?: number }>(IPC.profilesImportCookies, id),
  },
  loginChecks: {
    list: (profileId?: string) => invoke<LoginCheck[]>(IPC.loginChecksList, profileId),
    create: (input: LoginCheckInput) => invoke<LoginCheck>(IPC.loginChecksCreate, input),
    delete: (id: string) => invoke(IPC.loginChecksDelete, id),
    run: (id: string) => invoke<LoginCheck>(IPC.loginChecksRun, id),
  },
  groups: {
    list: () => invoke<ProfileGroup[]>(IPC.groupsList),
    create: (name: string) => invoke<ProfileGroup>(IPC.groupsCreate, name),
    rename: (id: string, name: string) => invoke(IPC.groupsRename, id, name),
    delete: (id: string) => invoke(IPC.groupsDelete, id),
  },
  flows: {
    list: () => invoke<Flow[]>(IPC.flowsList),
    run: (flowId: string, profileId: string) => invoke<Task>(IPC.flowsRun, flowId, profileId),
    delete: (id: string) => invoke(IPC.flowsDelete, id),
    update: (id: string, patch: { name?: string; steps?: unknown[] }) => invoke<Flow>(IPC.flowsUpdate, id, patch),
  },
  proxyPool: {
    list: () => invoke<ProxyPoolEntry[]>(IPC.proxyPoolList),
    add: (text: string) =>
      invoke<{ added: number; skipped: number; skippedSamples: string[] }>(IPC.proxyPoolAdd, text),
    delete: (id: string) => invoke(IPC.proxyPoolDelete, id),
    clear: () => invoke<{ ok: boolean; cleared: number }>(IPC.proxyPoolClear),
    checkAll: () =>
      invoke<{ ok: number; fail: number; total: number; list: ProxyPoolEntry[] }>(IPC.proxyPoolCheckAll),
  },
  extractTemplates: {
    list: () => invoke<ExtractTemplate[]>(IPC.extractTemplatesList),
    create: (input: { name: string; category: string; fields: string[]; instruction: string }) =>
      invoke<ExtractTemplate>(IPC.extractTemplatesCreate, input),
    delete: (id: string) => invoke(IPC.extractTemplatesDelete, id),
  },
  tasks: {
    create: (input: {
      name: string;
      requiresAuth: boolean;
      profileId?: string;
      profileIds?: string[];
      saveFlowAs?: string;
      collectFields?: string[];
    }) => invoke<Task>(IPC.tasksCreate, input),
    createBatch: (input: {
      name: string;
      requiresAuth: boolean;
      profileIds: string[];
      autoCreate?: { prefix: string; count: number };
    }) => invoke<Task>(IPC.tasksCreateBatch, input),
    list: () => invoke<(Task & { steps: TaskStep[] })[]>(IPC.tasksList),
    get: (id: string) => invoke<(Task & { steps: TaskStep[] }) | null>(IPC.tasksGet, id),
    cancel: (id: string) => invoke(IPC.tasksCancel, id),
    retry: (id: string) => invoke(IPC.tasksRetry, id),
    resolveInterrupted: (id: string, action: 'resume' | 'discard') =>
      invoke(IPC.tasksResolveInterrupted, id, action),
    liveView: (id: string) => invoke(IPC.tasksLiveView, id),
    readSnapshot: (file: string) => invoke<string>(IPC.tasksReadSnapshot, file),
    readScreenshot: (file: string) => invoke<string | null>(IPC.tasksReadScreenshot, file),
  },
  humanConfirm: {
    respond: (requestId: string, choice: HumanConfirmChoice) =>
      invoke(IPC.humanConfirmRespond, requestId, choice),
  },
  schedules: {
    list: () => invoke<Schedule[]>(IPC.schedulesList),
    create: (input: ScheduleInput) => invoke<Schedule>(IPC.schedulesCreate, input),
    update: (id: string, patch: Partial<ScheduleInput>) => invoke<Schedule>(IPC.schedulesUpdate, id, patch),
    toggle: (id: string, enabled: boolean) => invoke(IPC.schedulesToggle, id, enabled),
    delete: (id: string) => invoke(IPC.schedulesDelete, id),
  },
  templates: {
    list: () => invoke<TaskTemplate[]>(IPC.templatesList),
    create: (input: { name: string; instruction: string; requiresAuth: boolean }) =>
      invoke<TaskTemplate>(IPC.templatesCreate, input),
    delete: (id: string) => invoke(IPC.templatesDelete, id),
  },
  system: {
    detectChrome: () => invoke(IPC.systemDetectChrome),
    checkUpdate: () =>
      invoke<{ current: string; latest: string; hasUpdate: boolean; url: string; notes?: string; error?: string }>(
        IPC.systemCheckUpdate,
      ),
  },
  chromium: {
    list: () =>
      invoke<
        {
          version: string;
          label: string;
          sizeMB: number;
          status:
            | { installed: true; executable: string }
            | { installed: false; downloading?: { received: number; total: number; status: string; error?: string } };
          active: boolean;
        }[]
      >(IPC.chromiumList),
    download: (version: string) => invoke<{ ok: boolean; executable?: string }>(IPC.chromiumDownload, version),
    remove: (version: string) => invoke<{ ok: boolean }>(IPC.chromiumRemove, version),
  },
  events: {
    onTaskEvent: (cb: (e: TaskEvent) => void) => subscribe(EVT.taskEvent, cb),
    onHumanConfirm: (cb: (req: HumanConfirmRequest) => void) =>
      subscribe(EVT.humanConfirmRequest, cb),
  },
};

export type MatrixApi = typeof api;

contextBridge.exposeInMainWorld('matrix', api);
