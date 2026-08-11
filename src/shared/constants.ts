import type { Settings } from './types';

/** IPC 通道名（invoke 系列） */
export const IPC = {
  // settings
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  settingsTestLlm: 'settings:test-llm',
  // profiles
  profilesList: 'profiles:list',
  profilesCreate: 'profiles:create',
  profilesUpdate: 'profiles:update',
  profilesDelete: 'profiles:delete',
  profilesClone: 'profiles:clone',
  profilesLaunch: 'profiles:launch', // 手动模式（强制 headed，用于人工登录）
  profilesStop: 'profiles:stop',
  profilesSelfTest: 'profiles:self-test', // 打开指纹检测页
  profilesExport: 'profiles:export',
  profilesImport: 'profiles:import',
  profilesCheckProxy: 'profiles:check-proxy', // 代理/直连出口 IP + 延迟检测
  profilesAutoFingerprint: 'profiles:auto-fingerprint', // 根据代理出口 IP 生成时区/语言指纹建议
  profilesExportCookies: 'profiles:export-cookies',
  profilesImportCookies: 'profiles:import-cookies',
  // login checks（登录态检测）
  loginChecksList: 'login-checks:list',
  loginChecksCreate: 'login-checks:create',
  loginChecksDelete: 'login-checks:delete',
  loginChecksRun: 'login-checks:run',
  // profile groups（分组）
  groupsList: 'groups:list',
  groupsCreate: 'groups:create',
  groupsRename: 'groups:rename',
  groupsDelete: 'groups:delete',
  // flows（流程复用）
  flowsList: 'flows:list',
  flowsRun: 'flows:run', // 指定 Profile 回放
  flowsDelete: 'flows:delete',
  // tasks
  tasksCreate: 'tasks:create',
  tasksCreateBatch: 'tasks:create-batch',
  tasksList: 'tasks:list',
  tasksGet: 'tasks:get',
  tasksCancel: 'tasks:cancel',
  tasksRetry: 'tasks:retry',
  tasksResolveInterrupted: 'tasks:resolve-interrupted', // resume | discard
  tasksLiveView: 'tasks:live-view', // 实时查看：窗口置前（§9 MVP）
  tasksReadSnapshot: 'tasks:read-snapshot',
  tasksReadScreenshot: 'tasks:read-screenshot', // 读取步骤截图（base64 data URL）
  // human confirm
  humanConfirmRespond: 'human-confirm:respond',
  settingsTestWebhook: 'settings:test-webhook',
  // schedules（定时任务）
  schedulesList: 'schedules:list',
  schedulesCreate: 'schedules:create',
  schedulesUpdate: 'schedules:update',
  schedulesDelete: 'schedules:delete',
  schedulesToggle: 'schedules:toggle',
  // templates（任务模板）
  templatesList: 'templates:list',
  templatesCreate: 'templates:create',
  templatesDelete: 'templates:delete',
  // system
  systemDetectChrome: 'system:detect-chrome',
} as const;

/** 主进程 → 渲染进程 事件通道 */
export const EVT = {
  taskEvent: 'evt:task',
  humanConfirmRequest: 'evt:human-confirm',
} as const;

/** §10.3 默认设置 */
export const DEFAULT_SETTINGS: Settings = {
  llmBaseUrl: 'https://api.openai.com/v1',
  llmApiKeyEnc: '',
  llmModel: 'gpt-4o-mini',
  llmMaxTokens: 4096,
  llmTemperature: 0.3,
  llmConcurrency: 3,

  chromeExecutablePath: undefined,
  maxConcurrentProfiles: 3,
  headless: false,
  recordTasks: false,

  maxStepsPerTask: 100,
  snapshotHistoryWindow: 5,
  requireHumanConfirm: true,
  taskMaxRetries: 3,
  screenshotOnStep: true,

  notifyDesktop: true,
  webhookUrl: '',
  webhookEvents: 'all',
};

/** §7.2 序列化上限 */
export const SERIALIZE_MAX_ELEMENTS = 200;
export const SERIALIZE_ARIA_MAX_CHARS = 5000; // 控制 prompt 体积 = 控制 LLM 延迟

/** §7.4 上下文预算（粗算：字符数 ≈ token 数 × 1.5，取保守值） */
export const PROMPT_CHAR_BUDGET = 50_000;
export const HISTORY_SNAPSHOT_MAX_CHARS = 1000;

/** §7.6 防卡死：连续 N 步页面状态指纹不变判定卡住 */
export const STUCK_THRESHOLD = 3;

/** §8.2 任务重试 */
export const TASK_MAX_RETRIES = 3;
export const RETRY_BASE_DELAY_MS = 2000;

/** §7.5 LLM 非法输出重试次数 */
export const LLM_PARSE_MAX_RETRIES = 2;

/** 新建 Profile 的默认指纹可调项 */
export const DEFAULT_PROFILE_TUNABLES = {
  screenWidth: 1920,
  screenHeight: 1080,
  timezone: 'America/New_York',
  locale: 'en-US',
  languages: ['en-US', 'en'],
  hardwareConcurrency: 8,
  deviceMemory: 8,
} as const;
