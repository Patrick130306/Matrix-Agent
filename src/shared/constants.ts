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
  profilesBatchCreate: 'profiles:batch-create', // 批量创建（可选代理池联动自动指纹）
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
  flowsUpdate: 'flows:update', // 可视化编辑流程步骤
  // proxy pool（全局代理池）
  proxyPoolList: 'proxy-pool:list',
  proxyPoolAdd: 'proxy-pool:add', // 批量导入文本
  proxyPoolDelete: 'proxy-pool:delete',
  proxyPoolClear: 'proxy-pool:clear',
  proxyPoolCheckAll: 'proxy-pool:check-all', // 并发验证全部
  // extract templates（结构化采集模板）
  extractTemplatesList: 'extract-templates:list',
  extractTemplatesCreate: 'extract-templates:create',
  extractTemplatesDelete: 'extract-templates:delete',
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

  // 外观 / 反检测 / 成本
  theme: 'dark', // 深色 / 亮色（默认深色，与现有 UI 一致）
  behaviorSimulation: true, // 拟人行为模拟（思考延迟 / hover 预热等），默认开
  llmPricePer1kTokens: 0, // LLM 单价（元/千 token），0 = 不估算
};

/** §7.2 序列化上限 */
export const SERIALIZE_MAX_ELEMENTS = 200;
export const SERIALIZE_ARIA_MAX_CHARS = 5000; // 控制 prompt 体积 = 控制 LLM 延迟

/** §7.4 上下文预算（粗算：字符数 ≈ token 数 × 1.5，取保守值） */
export const PROMPT_CHAR_BUDGET = 50_000;
export const HISTORY_SNAPSHOT_MAX_CHARS = 1000;

/** §7.6 防卡死：连续 N 步页面状态指纹不变判定卡住 */
export const STUCK_THRESHOLD = 3;

/** §7.7 验证码弹窗豁免：用户确认"继续"后跳过 N 轮检测，防同一验证码反复弹窗死循环 */
export const CAPTCHA_SNOOZE_ROUNDS = 3;

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

/** 代理池一键验证的并发上限（保护本机网络与目标回显服务） */
export const PROXY_CHECK_CONCURRENCY = 4;
/** 单个代理验证超时（ms） */
export const PROXY_CHECK_TIMEOUT_MS = 25_000;

/**
 * 内置结构化采集模板（builtin = true，不可删除）。
 * 用户在「自动化 → 结构化采集」里一键套用：fields 决定提取字段，instruction 拼进任务指令。
 */
export const EXTRACT_PRESET_TEMPLATES: {
  name: string;
  category: string;
  fields: string[];
  instruction: string;
}[] = [
  {
    name: '电商商品列表',
    category: '电商',
    fields: ['标题', '价格', '原价', '销量', '店铺名'],
    instruction: '按列表页逐条整理商品：标题、价格、原价（无则省略）、销量、店铺名；翻页直到没有下一页。',
  },
  {
    name: '订单列表',
    category: '电商',
    fields: ['订单号', '商品', '金额', '状态', '下单时间'],
    instruction: '逐条整理订单：订单号、商品、金额、状态、下单时间；翻页直到没有下一页。',
  },
  {
    name: '社媒帖子',
    category: '社媒',
    fields: ['作者', '内容', '点赞数', '评论数', '发布时间'],
    instruction: '逐条整理帖子：作者、内容（截断到 200 字）、点赞数、评论数、发布时间；滚动加载直到没有新内容。',
  },
  {
    name: '搜索结果',
    category: '通用',
    fields: ['标题', '链接', '摘要'],
    instruction: '逐条整理搜索结果：标题、链接、摘要；翻页直到没有下一页。',
  },
];
