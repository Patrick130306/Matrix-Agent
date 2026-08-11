/**
 * §7 Agent 大脑 —— 自研精简循环（ADR-5：接口对齐 Stagehand 原语，保留切换预案）。
 *
 * 核心循环（§7.1 状态机）：
 *   序列化 → 构建 Prompt（§7.4 上下文管理）→ LLM 决策（§7.5 三级兜底）
 *   → 执行 → 记录步骤 → 护栏（maxSteps / §7.6 卡死检测）
 *
 * 熔断条款（ADR-5）：若开发两周后端到端成功率不达标（验收场景见 §13），
 * 切换 Stagehand v3 作为 Agent Core 底座，本模块退化为调度与人机协同层。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type {
  AgentAction,
  FlowStep,
  HumanConfirmChoice,
  PageSnapshot,
  Profile,
  Settings,
  Task,
  TaskResult,
  TaskStep,
} from '@shared/types';
import {
  HISTORY_SNAPSHOT_MAX_CHARS,
  PROMPT_CHAR_BUDGET,
  STUCK_THRESHOLD,
} from '@shared/constants';
import {
  addTaskStep,
  getLogsDir,
  getTask,
  listTaskSteps,
  nextStepSeq,
  updateStepScreenshot,
  upsertTask,
} from './db';
import { ElementStaleError, pageStateHash, snapshotToPromptText } from './serializer';
import { LLMParseFailedError, type ChatMessage, type LLMClient } from './llm-client';
import type { BrowserManager } from './browser-manager';
import { decryptString } from './secure-store';

export class TaskCancelledError extends Error {
  constructor() {
    super('任务已被用户取消');
    this.name = 'TaskCancelledError';
  }
}

/** Agent 与外部（IPC/UI）的桥 */
export interface AgentHooks {
  /** 步骤记录后回调（用于 UI 实时刷新） */
  onStep(step: TaskStep): void;
  /** 人机协同请求；resolve 用户选择 */
  requestHumanConfirm(input: {
    taskId: string;
    taskName: string;
    reason: string;
    screenshotBase64?: string;
    recentActions: { description: string; reason?: string }[];
  }): Promise<HumanConfirmChoice>;
  /** 取消令牌 */
  isCancelled(taskId: string): boolean;
}

/** 多 Profile 切换池（由调度器实现）：switch_profile 动作的执行通道 */
export interface ProfilePool {
  /** 给 prompt 用的池视图（含占用状态标注） */
  listForPrompt(task: Task, currentId: string): { name: string; note: string }[];
  /** 按名称切换：加锁 + 确保浏览器启动；原浏览器保持打开 */
  switchTo(
    taskId: string,
    name: string,
    settings: Settings,
  ): Promise<{ ok: boolean; profile?: Profile; error?: string }>;
}

export class AgentCore {
  private screenshotEnabled = false;
  /** 本次运行录制的可复用动作序列（任务成功后由调度器存为流程） */
  private flowSteps: FlowStep[] = [];

  constructor(
    private readonly browsers: BrowserManager,
    private readonly llm: LLMClient,
    private readonly hooks: AgentHooks,
  ) {}

  /** 录制结果（仅含确定性可回放动作；switch_profile / human_confirm 不入流程） */
  getRecordedSteps(): FlowStep[] {
    return this.flowSteps;
  }

  /** 任务主循环。抛 TaskCancelledError 表示用户取消；其余异常向上抛给调度器。 */
  async run(task: Task, initialProfile: Profile, settings: Settings, pool: ProfilePool): Promise<TaskResult> {
    const apiKey = decryptString(settings.llmApiKeyEnc);
    if (!apiKey) throw new Error('未配置 LLM API Key，请先到设置页填写');

    this.screenshotEnabled = settings.screenshotOnStep !== false;
    this.flowSteps = [];
    let current = initialProfile; // 当前操作的 Profile（switch_profile 可切换）

    const result: TaskResult = { fragments: task.result?.fragments ?? [], final: undefined };
    const recentHashes: string[] = [];
    let snapshot: PageSnapshot | null = null;

    while (true) {
      if (this.hooks.isCancelled(task.id)) throw new TaskCancelledError();

      // ---- 护栏 1：步数上限（§7.1-6） ----
      const stepCount = nextStepSeq(task.id) - 1;
      if (stepCount >= task.maxSteps) {
        throw new Error(`步骤超过上限（${task.maxSteps}），可能陷入循环`);
      }

      // ---- 1. 序列化（§7.2） ----
      snapshot = await this.browsers.serialize(current.id);
      const stateHash = pageStateHash(snapshot);

      // ---- 护栏 2：卡死检测（§7.6） ----
      recentHashes.push(stateHash);
      if (recentHashes.length > STUCK_THRESHOLD) recentHashes.shift();
      if (
        recentHashes.length === STUCK_THRESHOLD &&
        recentHashes.every((h) => h === recentHashes[0])
      ) {
        const choice = await this.askHuman(task, current.id, '连续操作未改变页面状态，疑似卡住');
        if (choice === 'terminate') throw new TaskCancelledError();
        recentHashes.length = 0;
        continue;
      }

      // ---- 验证码 / 人机协同检测（§7.7 三路并行） ----
      const captchaReason = await this.detectCaptcha(current.id, snapshot);
      if (captchaReason) {
        const choice = await this.askHuman(task, current.id, captchaReason);
        if (choice === 'terminate') throw new TaskCancelledError();
        recentHashes.length = 0;
        continue;
      }

      // ---- 2. 构建 Prompt（§7.4） ----
      const messages = this.buildPrompt(task, snapshot, settings, pool, current);

      // ---- 3. LLM 决策（§7.5）；一次决策可返回动作批次，减少 LLM 往返 ----
      let actions: AgentAction[];
      try {
        actions = await this.llm.decideAction(settings, apiKey, messages);
      } catch (err) {
        if (err instanceof LLMParseFailedError) {
          // 三级兜底全部失败 → 转 human_confirm，不直接判任务失败
          const choice = await this.askHuman(
            task,
            current.id,
            'LLM 多次返回非法输出，无法继续自动决策。请人工接管操作后点击"继续"，或终止任务。',
          );
          if (choice === 'terminate') throw new TaskCancelledError();
          continue;
        }
        throw err;
      }

      // ---- 4. 顺序执行本批动作 ----
      let redecide = false;
      for (const action of actions) {
        if (this.hooks.isCancelled(task.id)) throw new TaskCancelledError();

        // idx 合法性校验（§7.5：只允许引用当前快照中存在的 idx）
        if ('idx' in action && typeof action.idx === 'number') {
          if (!snapshot.elements.some((e) => e.idx === action.idx)) {
            this.recordStep(task, {
              type: 'error',
              description: `LLM 引用了不存在的 idx=${action.idx}，要求重新决策`,
              pageStateHash: stateHash,
              success: false,
              errorMessage: `idx=${action.idx} 不在当前快照中`,
            });
            redecide = true;
            break;
          }
        }

        switch (action.type) {
          case 'done': {
            result.final = action.result || result.fragments.join('\n\n');
            this.recordStep(task, {
              type: 'extract',
              description: `任务完成：${action.result.slice(0, 200)}`,
              pageStateHash: stateHash,
              success: true,
            }, snapshot, current.id);
            return result;
          }

          case 'error':
            throw new Error(`LLM 判定无法继续：${action.reason}`);

          case 'human_confirm': {
            this.recordStep(task, {
              type: 'human_confirm',
              description: `[${current.name}] ${action.message || action.reason}`,
              pageStateHash: stateHash,
              success: true,
            });
            const choice = await this.askHuman(task, current.id, action.message || action.reason);
            if (choice === 'terminate') throw new TaskCancelledError();
            recentHashes.length = 0;
            redecide = true; // 人工处理后页面必然变化，批次剩余动作作废
            break;
          }

          case 'switch_profile': {
            const r = await pool.switchTo(task.id, action.name, settings);
            if (r.ok && r.profile) {
              current = r.profile;
              this.recordStep(task, {
                type: 'navigate',
                description: `切换到 Profile「${current.name}」继续操作（原浏览器保持打开）`,
                pageStateHash: stateHash,
                success: true,
              });
            } else {
              this.recordStep(task, {
                type: 'error',
                description: `切换 Profile「${action.name}」失败`,
                pageStateHash: stateHash,
                success: false,
                errorMessage: r.error,
              });
            }
            recentHashes.length = 0;
            redecide = true; // 操作对象已变，剩余动作作废
            break;
          }

          case 'extract': {
            const text = await this.browsers.execute(current.id, action, snapshot.elements);
            result.fragments.push(`【${action.note}】\n${text}`);
            // 同步到 task.result，让下一轮 prompt 能看到已提取内容（避免重复 extract）
            task.result = { ...result };
            upsertTask(task);
            this.flowSteps.push({ action, note: `采集：${action.note}` });
            this.recordStep(task, {
              type: 'extract',
              description: `${action.note}（已收集 ${text.length} 字符）`,
              value: text.slice(0, 500),
              pageStateHash: stateHash,
              success: true,
            }, snapshot, current.id);
            break;
          }

          default: {
            try {
              await this.browsers.execute(current.id, action, snapshot.elements);
              // 录制可回放动作（元素级动作带上 xpath/tag/text，回放自愈用）
              const el =
                'idx' in action && typeof action.idx === 'number'
                  ? snapshot.elements.find((e) => e.idx === action.idx)
                  : undefined;
              this.flowSteps.push({
                action,
                xpath: el?.xpath,
                tag: el?.tag,
                text: el?.text?.slice(0, 80),
                note: describeAction(action),
              });
              this.recordStep(task, {
                type: action.type,
                description: describeAction(action),
                idx: 'idx' in action ? action.idx : undefined,
                value: 'text' in action ? action.text : undefined,
                pageStateHash: stateHash,
                success: true,
              }, snapshot, current.id);
              // navigate 之后页面必然变化，批次剩余动作大概率失效，直接重决策
              if (action.type === 'navigate') redecide = true;
              await sleep(400);
            } catch (err) {
              if (err instanceof ElementStaleError) {
                // §7.3：打标失效 → 重新序列化并让 LLM 重决策（不消耗步数预算）
                this.recordStep(task, {
                  type: 'error',
                  description: `元素 idx=${err.idx} 打标失效，重新感知页面`,
                  pageStateHash: stateHash,
                  success: false,
                  errorMessage: err.message,
                });
                recentHashes.length = 0;
                redecide = true;
                break;
              }
              this.recordStep(task, {
                type: action.type,
                description: describeAction(action),
                idx: 'idx' in action ? action.idx : undefined,
                pageStateHash: stateHash,
                success: false,
                errorMessage: (err as Error).message.slice(0, 500),
              }, snapshot, current.id);
              // 执行失败：中止本批剩余动作，让 LLM 带失败信息重决策（§8.2 语义）
              redecide = true;
              break;
            }
          }
        }
        if (redecide) break;
      }
    }
  }

  // ---------------------------------------------------------------- prompt

  /** §7.4 上下文管理：近期 N 步快照 + 远期压缩为一行摘要，总预算超限先砍远期。 */
  private buildPrompt(
    task: Task,
    snapshot: PageSnapshot,
    settings: Settings,
    pool: ProfilePool,
    current: Profile,
  ): ChatMessage[] {
    const steps = listTaskSteps(task.id);
    const windowSize = Math.max(1, settings.snapshotHistoryWindow);
    const recent = steps.slice(-windowSize);
    const older = steps.slice(0, Math.max(0, steps.length - windowSize));

    const parts: string[] = [];
    parts.push(`【任务目标】\n${task.name}`);

    // 多 Profile 池：LLM 据此决定何时用 switch_profile 切换操作对象
    const poolView = pool.listForPrompt(task, current.id);
    if (poolView.length > 0) {
      const lines = poolView.map((p) => `- ${p.name}${p.note ? `（${p.note}）` : ''}`);
      parts.push(
        `【浏览器 Profile 池】当前正在操作：「${current.name}」。可用 switch_profile 动作切换到池中其他 Profile（原浏览器保持打开，可随时切回）：\n${lines.join('\n')}`,
      );
    }
    if (task.result?.fragments?.length) {
      const notes = task.result.fragments
        .map((f, i) => `${i + 1}. ${f.split('\n')[0].slice(0, 80)}（含正文 ${f.length} 字符）`)
        .join('\n');
      parts.push(
        `【已提取的数据片段】\n${notes}\n` +
          `以上数据正文中很可能已包含答案：禁止重复 extract 同一内容，直接归纳后用 done 交付。`,
      );
    }

    if (older.length > 0) {
      const lines = older.map(
        (s) =>
          `step ${s.seq}: ${s.type}${s.idx !== undefined ? ` idx=${s.idx}` : ''} "${s.description.slice(0, 60)}" → ${s.success ? '成功' : `失败(${s.errorMessage?.slice(0, 60) ?? ''})`}`,
      );
      parts.push(`【远期历史摘要】\n${lines.join('\n')}`);
    }

    for (const s of recent) {
      let block = `step ${s.seq}: ${s.type}${s.idx !== undefined ? ` idx=${s.idx}` : ''} ${s.description} → ${s.success ? '成功' : `失败: ${s.errorMessage ?? ''}`}`;
      // 近期步骤的当步快照（截断）
      if (s.snapshotFile) {
        const snapText = readSnapshotSafe(s.snapshotFile, HISTORY_SNAPSHOT_MAX_CHARS);
        if (snapText) block += `\n当步快照（截断）：\n${snapText}`;
      }
      parts.push(`【近期历史】\n${block}`);
    }

    parts.push(`【当前页面快照】\n${snapshotToPromptText(snapshot, PROMPT_CHAR_BUDGET)}`);

    // 预算控制：超限先砍远期历史、再砍近期快照保留数
    let userContent = parts.join('\n\n');
    if (userContent.length > PROMPT_CHAR_BUDGET) {
      const withoutOlder = parts.filter((p) => !p.startsWith('【远期历史】')).join('\n\n');
      userContent = withoutOlder;
    }
    if (userContent.length > PROMPT_CHAR_BUDGET) {
      userContent = userContent.slice(-PROMPT_CHAR_BUDGET);
    }

    return [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ];
  }

  // ---------------------------------------------------------------- helpers

  private recordStep(
    task: Task,
    partial: Omit<TaskStep, 'id' | 'taskId' | 'seq' | 'timestamp'>,
    snapshot?: PageSnapshot,
    shotProfileId?: string,
  ): void {
    const step: TaskStep = {
      id: crypto.randomUUID(),
      taskId: task.id,
      seq: nextStepSeq(task.id),
      timestamp: new Date().toISOString(),
      ...partial,
    };

    // §7.4：快照只存 hash + 截断版入库，完整快照写 logs/{taskId}/{step}.txt
    if (snapshot) {
      try {
        const dir = getLogsDir(task.id);
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `step-${step.seq}.txt`);
        fs.writeFileSync(file, snapshotToPromptText(snapshot, PROMPT_CHAR_BUDGET), 'utf8');
        step.snapshotFile = file;
      } catch (err) {
        console.warn('[agent] 快照落盘失败:', err);
      }
    }

    // 每步截图存档（异步落盘，不阻塞记录；电商留凭证用）
    if (shotProfileId && this.screenshotEnabled) {
      const dir = getLogsDir(task.id);
      const file = path.join(dir, `step-${step.seq}.jpg`);
      void this.browsers
        .screenshot(shotProfileId)
        .then((b64) => {
          if (!b64) return;
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(file, Buffer.from(b64, 'base64'));
          step.screenshotFile = file;
          // 截图完成后补写 DB（addTaskStep 已先执行，这里用更新）
          updateStepScreenshot(step.id, file);
        })
        .catch(() => undefined);
    }

    addTaskStep(step);
    this.hooks.onStep(step);
  }

  private async askHuman(task: Task, profileId: string, reason: string): Promise<HumanConfirmChoice> {
    const fresh = getTask(task.id);
    if (fresh) {
      fresh.status = 'paused';
      upsertTask(fresh);
    }
    const steps = listTaskSteps(task.id).slice(-5);
    const screenshotBase64 = await this.browsers.screenshot(profileId);
    const choice = await this.hooks.requestHumanConfirm({
      taskId: task.id,
      taskName: task.name,
      reason,
      screenshotBase64,
      recentActions: steps.map((s) => ({ description: s.description })),
    });
    const after = getTask(task.id);
    if (after && after.status === 'paused') {
      after.status = 'running';
      upsertTask(after);
    }
    return choice;
  }

  /** §7.7：三路并行检测（误报成本仅为多弹一次窗，可接受） */
  private async detectCaptcha(profileId: string, snapshot: PageSnapshot): Promise<string | null> {
    // 1. 已知验证码指纹：iframe / script 域名匹配
    try {
      const page = await this.browsers.getPage(profileId);
      const patterns = ['recaptcha', 'hcaptcha', 'challenges.cloudflare.com', 'captcha', 'geetest'];
      for (const frame of page.frames()) {
        const url = frame.url().toLowerCase();
        if (patterns.some((p) => url.includes(p))) {
          return `检测到验证码组件（${new URL(url).hostname}），请人工处理后继续`;
        }
      }
    } catch {
      /* 页面可能已关闭，忽略 */
    }

    // 2. 关键词
    const text = `${snapshot.title}\n${snapshot.aria}`.toLowerCase();
    const keywords = ['captcha', 'verify you are human', '人机验证', '安全验证', '滑动验证', '点击验证'];
    if (keywords.some((k) => text.includes(k))) {
      return '页面出现人机验证关键词，请确认是否需要人工处理';
    }

    // 3. LLM 自主判断 → 由 LLM 返回 human_confirm 动作实现，无需额外代码
    return null;
  }
}

function describeAction(action: AgentAction): string {
  const r = action.reason ? `（${action.reason.slice(0, 80)}）` : '';
  switch (action.type) {
    case 'navigate':
      return `导航到 ${action.url}${r}`;
    case 'click':
      return `点击 idx=${action.idx}${r}`;
    case 'type':
      return `在 idx=${action.idx} 输入文本${r}`;
    case 'select':
      return `在 idx=${action.idx} 选择 "${action.value}"${r}`;
    case 'scroll':
      return `滚动页面（${action.direction}）${r}`;
    case 'wait':
      return `等待 ${action.ms}ms${r}`;
    default:
      return action.type;
  }
}

function readSnapshotSafe(file: string, maxChars: number): string {
  try {
    const content = fs.readFileSync(file, 'utf8');
    return content.length > maxChars ? content.slice(0, maxChars) + '\n...' : content;
  } catch {
    return '';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** §7.5 System Prompt（v1.0 基础上补充：只允许引用当前快照中存在的 idx；输出必须是单个 JSON 对象） */
const SYSTEM_PROMPT = `你是一个浏览器自动化 Agent，通过观察页面结构、决策并执行动作来完成用户任务。你的每一轮决策都有一次 LLM 调用的耗时，请在保证正确的前提下尽量合并动作、减少轮次。

【输入】每轮你会收到：任务目标、历史步骤摘要、当前页面快照（URL、标题、aria 结构、可交互元素索引表）。

【输出】返回一个 JSON 对象，两种格式二选一：
单动作：{"action": "<类型>", "params": {...}, "reason": "..."}
多动作（推荐）：{"actions": [{"action": ..., "params": ..., "reason": ...}, ...]}（最多 5 个，顺序执行）

可用动作：
- navigate  {"url": "https://..."}                    打开网址（必须带协议）。注意：navigate 之后的动作不会被本批执行
- click     {"idx": 3}                                点击元素
- type      {"idx": 5, "text": "...", "pressEnter": true|false}  在输入框输入文本
- select    {"idx": 7, "value": "选项文本"}            下拉框选择
- scroll    {"direction": "up"|"down"|"top"|"bottom"} 滚动页面
- extract   {"note": "提取什么"}                       把当前页面正文收集为一段数据
- wait      {"ms": 2000}                              等待页面加载（最多 15000）
- switch_profile {"name": "Profile名"}                 切换到另一个浏览器 Profile 操作（矩阵/多账号场景；原浏览器保持打开，之后可随时切回）
- human_confirm {"message": "需要人做什么"}            遇到验证码/支付确认/不确定的操作时暂停，请求人工处理
- done      {"result": "最终答案"}                     任务完成，result 为交付给用户的完整结果
- error     {"reason": "为什么无法继续"}               任务确定无法完成（慎用，优先尝试换路径）

【规则】
1. idx 只能引用"当前页面快照"的元素索引表中存在的编号，禁止臆造。
2. 多动作批次只能包含"作用于当前页面状态"的动作；一旦页面会跳转/刷新（如 navigate、点链接），其后不要再排动作。
3. 典型高效模式：输入搜索词可以直接合并——{"actions": [{"action":"type","params":{"idx":5,"text":"...","pressEnter":true}}, {"action":"wait","params":{"ms":2000}}]}。
4. 遇到登录页、验证码、支付确认等需要人介入的场景，返回 human_confirm。
5. 上一步失败时，分析原因并换一条路径，不要机械重复同一动作。
6. 需要向用户交付文字结果时：先用 extract 收集数据，最后用 done 归纳输出。【已提取的数据片段】中已有的内容禁止重复 extract。
7. 多账号任务：用 switch_profile 切换操作对象；每个 Profile 是相互隔离的独立浏览器（独立登录态/Cookie/指纹）。切换后原来的浏览器保持打开，可以来回切换。切换后请等待下一轮新快照再操作。
8. 只返回 JSON 本身：不要 markdown 围栏，不要解释性文字。`;
