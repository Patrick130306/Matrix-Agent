/**
 * Matrix Agent —— 共享类型定义
 * 主进程 / 预加载 / 渲染进程三方共用，保持单一事实来源。
 * 对应需求文档 §10 数据模型。
 */

// ---------------------------------------------------------------- Profile

export type OSPresetId = 'win11-chrome' | 'win10-chrome' | 'macos-chrome' | 'linux-chrome';

export type ProxyType = 'none' | 'http' | 'https' | 'socks5';

export type ProfileStatus = 'idle' | 'running' | 'interrupted' | 'error';

/** 代理/直连出口检测结果（持久化在 Profile.data 里，UI 展示最近一次） */
export interface ProxyCheckResult {
  ok: boolean;
  ip?: string;
  latencyMs?: number;
  error?: string;
  checkedAt: string;
}

/** §10.1 Profile。UA / UA-CH / platform / WebGL / touchPoints 全部由 osPreset 派生，不单独存储。 */
export interface Profile {
  id: string; // UUID，同时作为指纹噪声种子来源（§6.3）
  name: string;
  groupId?: string;

  // 指纹：预设 + 少量可调项（§6.2）
  osPreset: OSPresetId;
  screenWidth: number;
  screenHeight: number;
  timezone: string; // "America/New_York"
  locale: string; // "en-US"
  languages: string[]; // ["en-US", "en"]，与 locale 联动
  hardwareConcurrency: number; // 2–16
  deviceMemory: number; // 2–8

  // 网络
  proxyType: ProxyType;
  proxyHost?: string;
  proxyPort?: number;
  proxyUsername?: string;
  proxyPasswordEnc?: string; // safeStorage 加密后的 base64（ADR-6）
  proxyCheck?: ProxyCheckResult; // 最近一次出口检测结果

  // 路径
  userDataDir: string;

  status: ProfileStatus;
  lastUsedAt?: string;
  createdAt: string;
}

export type ProfileInput = Omit<Profile, 'id' | 'userDataDir' | 'status' | 'createdAt' | 'lastUsedAt'>;

// ---------------------------------------------------------------- Task

export type TaskStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'interrupted'
  | 'completed'
  | 'failed';

export type StepType =
  | 'navigate'
  | 'click'
  | 'type'
  | 'select'
  | 'scroll'
  | 'extract'
  | 'wait'
  | 'human_confirm'
  | 'error';

/** §10.2 TaskStep */
export interface TaskStep {
  id: string;
  taskId: string;
  seq: number; // 任务内自增序号
  type: StepType;
  description: string;
  idx?: number; // 引用的元素打标
  value?: string;
  pageStateHash: string; // §7.6，用于卡死检测
  snapshotFile?: string; // 完整快照落盘路径（DB 不存大文本）
  screenshotFile?: string; // 当步页面截图落盘路径（JPEG）
  success: boolean;
  errorMessage?: string;
  timestamp: string;
}

export interface TaskResult {
  fragments: string[]; // extract 动作收集的原始片段
  final?: string; // done 动作给出的最终结果
}

/** §10.2 Task */
export interface Task {
  id: string;
  name: string; // 用户输入的原始指令
  type: 'single' | 'batch';
  requiresAuth: boolean; // false 才允许重试时换 Profile（§8.2）
  status: TaskStatus;

  profileId?: string; // 指定 Profile
  profileIds?: string[];
  parentId?: string; // 批量任务的子任务指向父任务

  flowId?: string; // 本任务是一次流程回放（走确定性回放，不调 LLM）
  saveFlowAs?: string; // 跑完后把本次动作序列存为该名称的流程
  collectFields?: string[]; // 结构化采集字段；完成时把数据片段合并为 JSON 行

  result?: TaskResult;
  retryCount: number;
  maxSteps: number; // 默认 100

  errorMessage?: string;

  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

// ---------------------------------------------------------------- Settings

/** §10.3 Settings */
export interface Settings {
  // LLM
  llmBaseUrl: string;
  llmApiKeyEnc: string; // safeStorage 加密存储
  llmModel: string;
  llmMaxTokens: number; // 4096
  llmTemperature: number; // 0.3
  llmConcurrency: number; // 默认 3（§8.1）

  // 浏览器
  chromeExecutablePath?: string; // 自动检测系统 Chrome / 用户指定 / Chromium 兜底
  maxConcurrentProfiles: number; // 默认 3
  headless: boolean; // MVP 默认 false

  // Agent
  maxStepsPerTask: number; // 默认 100
  snapshotHistoryWindow: number; // 近期历史保留步数，默认 5
  requireHumanConfirm: boolean;
  taskMaxRetries: number; // 任务失败自动重试次数，默认 3
  screenshotOnStep: boolean; // 每步执行后自动截图存档，默认开

  // 通知
  notifyDesktop: boolean; // 任务终态桌面通知，默认开
  webhookUrl: string; // 任务终态回调（钉钉/企微/自建），空 = 关闭
  webhookEvents: 'all' | 'failed'; // Webhook 触发范围
}

/** 渲染进程提交上来的设置表单（密钥字段为明文，主进程负责加密） */
export type SettingsInput = Omit<Settings, 'llmApiKeyEnc'> & { llmApiKey?: string };

// ---------------------------------------------------------------- Agent

/** LLM 决策出的动作（内部表示）。线协议见 action-protocol.ts（§7.5）。 */
export type AgentAction =
  | { type: 'navigate'; url: string; reason: string }
  | { type: 'click'; idx: number; reason: string }
  | { type: 'type'; idx: number; text: string; pressEnter?: boolean; reason: string }
  | { type: 'select'; idx: number; value: string; reason: string }
  | { type: 'scroll'; direction: 'up' | 'down' | 'top' | 'bottom'; reason: string }
  | { type: 'extract'; note: string; reason: string }
  | { type: 'wait'; ms: number; reason: string }
  | { type: 'switch_profile'; name: string; reason: string } // 切换到另一个 Profile 操作（原浏览器保持打开）
  | { type: 'human_confirm'; reason: string; message?: string }
  | { type: 'done'; result: string; reason: string }
  | { type: 'error'; reason: string };

// ---------------------------------------------------------------- Serializer

/** §7.2 可交互元素打标信息 */
export interface ElementInfo {
  idx: number;
  tag: string;
  type?: string;
  text: string;
  placeholder?: string;
  disabled?: boolean;
  xpath: string; // 打标失效时的备用定位（§7.3）
}

/** §7.2 页面快照 */
export interface PageSnapshot {
  url: string;
  title: string;
  aria: string; // aria snapshot（YAML，截断）
  elements: ElementInfo[];
  capturedAt: string;
}

// ---------------------------------------------------------------- IPC 事件载荷

export interface TaskStatusEvent {
  type: 'status';
  taskId: string;
  status: TaskStatus;
  errorMessage?: string;
}

export interface TaskStepEvent {
  type: 'step';
  taskId: string;
  step: TaskStep;
}

export type TaskEvent = TaskStatusEvent | TaskStepEvent;

/** §9 Human-in-the-Loop 弹窗载荷 */
export interface HumanConfirmRequest {
  requestId: string;
  taskId: string;
  taskName: string;
  reason: string;
  screenshotBase64?: string; // JPEG
  recentActions: { description: string; reason?: string }[];
}

export type HumanConfirmChoice = 'continue' | 'terminate';

export interface LlmTestResult {
  ok: boolean;
  latencyMs?: number;
  error?: string;
  model?: string;
}

// ---------------------------------------------------------------- 定时任务 / 模板

/** 定时规则（MVP：间隔 N 分钟 或 每日定点） */
export type ScheduleSpec =
  | { kind: 'interval'; everyMin: number } // 每 N 分钟
  | { kind: 'daily'; hhmm: string }; // 每日 HH:MM（本地时间）

export interface Schedule {
  id: string;
  name: string;
  instruction: string; // 任务指令
  requiresAuth: boolean;
  profileIds: string[]; // >1 时按批量任务下发
  spec: ScheduleSpec;
  enabled: boolean;
  lastRunAt?: string;
  nextRunAt?: string;
  createdAt: string;
}

export type ScheduleInput = Omit<Schedule, 'id' | 'lastRunAt' | 'nextRunAt' | 'createdAt'>;

/** 任务模板：验证过的指令存起来一键下发 */
export interface TaskTemplate {
  id: string;
  name: string;
  instruction: string;
  requiresAuth: boolean;
  createdAt: string;
}

// ---------------------------------------------------------------- 登录态检测

/**
 * 登录态检测项（矩阵运营防掉号）：
 * 打开 url 后，页面上能找到 target（CSS 选择器 / 包含文本）即视为已登录。
 */
export interface LoginCheck {
  id: string;
  profileId: string;
  name: string; // 平台名，如「抖音小店」
  url: string; // 检测页（通常是登录后才能看到的页面）
  mode: 'selector' | 'keyword';
  target: string; // CSS 选择器 或 页面应包含的文本
  status: 'unknown' | 'online' | 'offline';
  detail?: string;
  lastCheckedAt?: string;
  createdAt: string;
}

export type LoginCheckInput = Pick<LoginCheck, 'profileId' | 'name' | 'url' | 'mode' | 'target'>;

// ---------------------------------------------------------------- Profile 分组

/** Profile 分组（按店铺/平台归类，支撑整组批量操作） */
export interface ProfileGroup {
  id: string;
  name: string;
  createdAt: string;
}

// ---------------------------------------------------------------- 流程复用 / 结构化采集

/**
 * 流程中的一步：AI 探路（LLM 决策）时录制，回放时确定性执行、不调 LLM。
 * 元素级动作带 xpath / tag / text，回放定位失败时据此自愈（重新匹配并回写）。
 */
export interface FlowStep {
  action: AgentAction; // navigate/click/type/select/scroll/wait/extract
  xpath?: string; // 元素级动作的定位（自愈首选）
  tag?: string;
  text?: string; // 元素文本（自愈模糊匹配用）
  note?: string; // 人类可读描述
}

/** 可复用流程：一次 AI 探路的产物，之后秒级回放 */
export interface Flow {
  id: string;
  name: string;
  instruction: string; // 原始指令（回放失败时 LLM 接管修复的上下文）
  steps: FlowStep[];
  requiresAuth: boolean;
  runCount: number;
  lastRunAt?: string;
  lastStatus?: 'completed' | 'failed';
  createdAt: string;
}
