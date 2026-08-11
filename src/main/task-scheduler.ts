/**
 * §8 任务调度器。
 *
 * §8.1 并发模型（双信号量）：
 *   - 浏览器并发信号量 maxConcurrentProfiles（默认 3）——保护用户机器性能；
 *   - LLM 并发信号量 llmConcurrency（默认 3，在 LLMClient 内）——保护 API key rate limit。
 *   每个 Profile 一把互斥锁，同一 Profile 同一时刻只被一个任务操作。
 *
 * §8.2 重试策略：默认同 Profile 重试（登录态绑定在 userDataDir 中，换 Profile 必然失败）；
 *   仅匿名任务（requiresAuth === false）允许重试时换 Profile；
 *   LLM 上下文（DB 中的步骤历史）天然保留，prompt 中已带失败信息。
 *
 * 多 Profile 切换（矩阵/电商场景）：任务可携带 Profile 池（profileIds），
 * Agent 执行中经 switch_profile 动作切换操作对象；ProfilePool 负责锁的获取/释放。
 * 任务结束后浏览器实例保持打开（用户可检查页面/继续人工操作），下次任务直接复用。
 */
import crypto from 'node:crypto';
import type { Profile, Settings, Task, TaskResult } from '@shared/types';
import { RETRY_BASE_DELAY_MS, TASK_MAX_RETRIES } from '@shared/constants';
import {
  getFlow,
  getProfile,
  getSettings,
  getTask,
  listChildTasks,
  listProfiles,
  listTasks,
  upsertFlow,
  upsertTask,
} from './db';
import { Semaphore } from './semaphore';
import { AgentCore, TaskCancelledError, type AgentHooks, type ProfilePool } from './agent-core';
import { FlowStepError, runFlow } from './flow-runner';
import type { BrowserManager } from './browser-manager';
import type { LLMClient } from './llm-client';

export interface SchedulerEvents {
  onStatus(taskId: string, status: Task['status'], errorMessage?: string): void;
}

export class TaskScheduler implements ProfilePool {
  private readonly browserSem: Semaphore;
  private readonly busyProfiles = new Set<string>(); // Profile 互斥锁
  private readonly taskProfiles = new Map<string, Set<string>>(); // 任务持有的锁
  private readonly cancelled = new Set<string>();
  private readonly queue: string[] = [];
  private pumping = false;

  constructor(
    private readonly browsers: BrowserManager,
    private readonly llm: LLMClient,
    private readonly agentHooks: AgentHooks,
    private readonly events: SchedulerEvents,
    browserConcurrency: number,
  ) {
    this.browserSem = new Semaphore(browserConcurrency);
  }

  setBrowserConcurrency(n: number): void {
    this.browserSem.setMax(n);
  }

  /** 创建任务并入队。profileId 单个指定；profileIds 多 Profile 池（可切换）；parentId 批量子任务。 */
  submit(
    name: string,
    requiresAuth: boolean,
    profileId?: string,
    profileIds?: string[],
    parentId?: string,
    extra?: { flowId?: string; saveFlowAs?: string; collectFields?: string[] },
  ): Task {
    const task: Task = {
      id: crypto.randomUUID(),
      name,
      type: 'single',
      requiresAuth,
      status: 'pending',
      profileId: profileId || undefined,
      profileIds: profileIds?.length ? profileIds : undefined,
      parentId,
      flowId: extra?.flowId,
      saveFlowAs: extra?.saveFlowAs,
      collectFields: extra?.collectFields,
      retryCount: 0,
      maxSteps: getSettings().maxStepsPerTask,
      createdAt: new Date().toISOString(),
    };
    upsertTask(task);
    this.enqueue(task.id);
    return task;
  }

  /** 流程回放任务：确定性执行，不调 LLM（回放失败才由 LLM 接管修复）。 */
  submitFlow(flowId: string, profileId: string): Task {
    const flow = getFlow(flowId);
    if (!flow) throw new Error('流程不存在');
    return this.submit(`[流程] ${flow.name}`, flow.requiresAuth, profileId, undefined, undefined, { flowId });
  }

  /**
   * 批量任务（矩阵核心）：一条指令 × N 个 Profile。
   * 父任务负责聚合展示；每个 Profile 一个子任务独立排队执行（受并发信号量约束）。
   */
  submitBatch(name: string, requiresAuth: boolean, profileIds: string[]): Task {
    const now = new Date().toISOString();
    const parent: Task = {
      id: crypto.randomUUID(),
      name,
      type: 'batch',
      requiresAuth,
      status: 'running',
      profileIds,
      retryCount: 0,
      maxSteps: 0, // 父任务不消耗步数，步数在子任务上
      createdAt: now,
      startedAt: now,
    };
    upsertTask(parent);

    for (const pid of profileIds) {
      const p = getProfile(pid);
      if (!p) continue;
      this.submit(name, requiresAuth, pid, undefined, parent.id);
    }
    this.events.onStatus(parent.id, 'running');
    return parent;
  }

  /** 子任务到达终态 → 全部子任务结束后聚合结果到父任务。 */
  private onChildTerminal(task: Task): void {
    if (!task.parentId) return;
    const parent = getTask(task.parentId);
    if (!parent || parent.status !== 'running') return;

    const children = listChildTasks(parent.id);
    const terminal = children.filter((c) => ['completed', 'failed'].includes(c.status));
    if (terminal.length < children.length) return; // 还有在跑的

    const ok = children.filter((c) => c.status === 'completed');
    const sections = children.map((c) => {
      const profileName = getProfile(c.profileId ?? '')?.name ?? '未知 Profile';
      if (c.status === 'completed') {
        return `### ✅ ${profileName}\n${(c.result?.final ?? '（无文本结果）').slice(0, 1500)}`;
      }
      return `### ❌ ${profileName}\n失败：${c.errorMessage ?? '未知原因'}`;
    });

    parent.status = ok.length > 0 ? 'completed' : 'failed';
    parent.result = {
      fragments: [],
      final: `批量任务完成：${ok.length} 成功 / ${children.length - ok.length} 失败\n\n${sections.join('\n\n')}`,
    };
    parent.errorMessage = ok.length > 0 ? undefined : '全部子任务失败';
    parent.completedAt = new Date().toISOString();
    upsertTask(parent);
    this.events.onStatus(parent.id, parent.status, parent.errorMessage);
  }

  /** §8.3-4：启动时把 pending 任务重新入队。 */
  recoverPending(): number {
    const pending = listTasks(500).filter((t) => t.status === 'pending');
    for (const t of pending) this.enqueue(t.id);
    return pending.length;
  }

  /** 手动重试（failed / interrupted 任务）。 */
  retry(taskId: string): boolean {
    const task = getTask(taskId);
    if (!task || task.status === 'running' || task.status === 'pending') return false;
    task.status = 'pending';
    task.retryCount = 0;
    task.errorMessage = undefined;
    upsertTask(task);
    this.enqueue(taskId);
    return true;
  }

  /** interrupted 任务处置：resume 重新入队；discard 标记失败。 */
  resolveInterrupted(taskId: string, action: 'resume' | 'discard'): void {
    const task = getTask(taskId);
    if (!task || task.status !== 'interrupted') return;
    if (action === 'resume') {
      task.status = 'pending';
      upsertTask(task);
      this.enqueue(taskId);
    } else {
      task.status = 'failed';
      task.errorMessage = '上次运行被中断，用户选择放弃';
      task.completedAt = new Date().toISOString();
      upsertTask(task);
    }
    this.events.onStatus(taskId, getTask(taskId)!.status);
  }

  cancel(taskId: string): void {
    const task = getTask(taskId);
    if (!task) return;
    if (task.status === 'pending') {
      task.status = 'failed';
      task.errorMessage = '排队中被用户取消';
      task.completedAt = new Date().toISOString();
      upsertTask(task);
      this.events.onStatus(taskId, 'failed', task.errorMessage);
      this.onChildTerminal(task);
      return;
    }
    this.cancelled.add(taskId);
  }

  isCancelled(taskId: string): boolean {
    return this.cancelled.has(taskId);
  }

  // ---------------------------------------------------------------- ProfilePool（多 Profile 切换）

  /** 给 prompt 用的 Profile 池视图（含占用状态）。 */
  listForPrompt(task: Task, currentId: string): { name: string; note: string }[] {
    const inPool = task.profileIds?.length ? new Set(task.profileIds) : null;
    return listProfiles()
      .filter((p) => (inPool ? inPool.has(p.id) : true))
      .map((p) => {
        const notes: string[] = [];
        if (p.id === currentId) notes.push('当前操作中');
        else if (this.busyProfiles.has(p.id)) notes.push('被其他任务占用');
        else if (this.browsers.isRunning(p.id)) notes.push('浏览器已打开');
        return { name: p.name, note: notes.join('，') };
      });
  }

  /** switch_profile 动作的执行入口：按名称找 Profile → 加锁 → 确保浏览器已启动。 */
  async switchTo(
    taskId: string,
    name: string,
    settings: Settings,
  ): Promise<{ ok: boolean; profile?: Profile; error?: string }> {
    const task = getTask(taskId);
    const inPool = task?.profileIds?.length ? new Set(task.profileIds) : null;
    const target = listProfiles().find(
      (p) =>
        (!inPool || inPool.has(p.id)) &&
        (p.name === name || p.name.toLowerCase().includes(name.toLowerCase())),
    );
    if (!target) return { ok: false, error: `找不到名为「${name}」的 Profile（不在本任务池内或不存在）` };
    if (this.busyProfiles.has(target.id) && !this.taskProfiles.get(taskId)?.has(target.id)) {
      return { ok: false, error: `Profile「${target.name}」正被其他任务占用，稍后再试或换一个` };
    }

    // 加锁 + 登记到任务持有集合
    this.busyProfiles.add(target.id);
    let held = this.taskProfiles.get(taskId);
    if (!held) {
      held = new Set();
      this.taskProfiles.set(taskId, held);
    }
    held.add(target.id);

    try {
      await this.browsers.launch(target, settings); // 已打开则直接复用（切换不关闭原浏览器）
      return { ok: true, profile: target };
    } catch (err) {
      return { ok: false, error: `Profile「${target.name}」浏览器启动失败：${(err as Error).message.slice(0, 200)}` };
    }
  }

  /** 任务结束：释放它持有的所有 Profile 锁（浏览器保持打开）。 */
  private releaseAll(taskId: string): void {
    const held = this.taskProfiles.get(taskId);
    if (held) {
      for (const pid of held) this.busyProfiles.delete(pid);
      this.taskProfiles.delete(taskId);
    }
  }

  /** 流程回放执行 + LLM 接管修复 + Flow 运行统计回写。 */
  private async runFlowTask(task: Task, profile: Profile, settings: Settings): Promise<TaskResult> {
    const flow = getFlow(task.flowId!);
    if (!flow) throw new Error('流程不存在（可能已被删除）');
    try {
      const outcome = await runFlow(this.browsers, this.agentHooks, task.id, flow, profile, settings);
      flow.runCount++;
      flow.lastRunAt = new Date().toISOString();
      flow.lastStatus = 'completed';
      upsertFlow(flow);
      return outcome.result;
    } catch (err) {
      if (err instanceof FlowStepError) {
        // 回放中断：LLM 从当前页面接管，完成剩余目标（步骤记录连续保留在同一任务里）
        const repairTask: Task = {
          ...task,
          name:
            `你在接续一个浏览器自动化流程「${flow.name}」。${err.message}（页面可能已改版）。` +
            `请从当前页面状态继续，完成原始目标：${flow.instruction}。已完成的步骤不要重复。`,
        };
        const agent = new AgentCore(this.browsers, this.llm, this.agentHooks);
        const result = await agent.run(repairTask, profile, settings, this);
        flow.runCount++;
        flow.lastRunAt = new Date().toISOString();
        flow.lastStatus = 'completed';
        upsertFlow(flow);
        return result;
      }
      flow.lastRunAt = new Date().toISOString();
      flow.lastStatus = 'failed';
      upsertFlow(flow);
      throw err;
    }
  }

  // ---------------------------------------------------------------- 队列

  private enqueue(taskId: string): void {
    if (!this.queue.includes(taskId)) this.queue.push(taskId);
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length > 0) {
        const taskId = this.queue.shift()!;
        const task = getTask(taskId);
        if (!task || task.status !== 'pending') continue;
        // 不等待执行完成，并发由信号量控制
        void this.runTask(task).catch((err) => console.error('[scheduler] 未捕获异常:', err));
      }
    } finally {
      this.pumping = false;
    }
  }

  /**
   * 分配初始 Profile：指定优先；其次任务池内空闲的；最后全局空闲的。
   * 已打开但未锁定的浏览器可直接复用（任务结束不再关闭实例）。
   */
  private allocateProfile(task: Task, attempted: Set<string>): Profile | null {
    if (task.profileId) {
      const p = getProfile(task.profileId);
      if (p && !this.busyProfiles.has(p.id)) return p;
      return null;
    }
    const all = listProfiles().filter((p) => !this.busyProfiles.has(p.id) && !attempted.has(p.id));
    if (task.profileIds?.length) {
      const inPool = all.filter((p) => task.profileIds!.includes(p.id));
      if (inPool.length > 0) return inPool[0];
    }
    return all[0] ?? null;
  }

  private async runTask(task: Task): Promise<void> {
    const settings = getSettings();
    const maxRetries = settings.taskMaxRetries ?? TASK_MAX_RETRIES;
    const attemptedProfiles = new Set<string>();

    // 指定的 Profile 不存在属于配置错误，直接判失败，不进重试
    if (task.profileId && !getProfile(task.profileId)) {
      task.status = 'failed';
      task.errorMessage = '指定的 Profile 不存在';
      task.completedAt = new Date().toISOString();
      upsertTask(task);
      this.events.onStatus(task.id, 'failed', task.errorMessage);
      return;
    }

    // ---- 重试循环（§8.2） ----
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (this.cancelled.has(task.id)) break;

      const profile = this.allocateProfile(task, attemptedProfiles);
      if (!profile) {
        // 一个 Profile 都不存在：配置问题，直接失败并给出指引
        if (listProfiles().length === 0) {
          task.status = 'failed';
          task.errorMessage = '没有可用的 Profile：请先到「Profile 管理」创建一个';
          task.completedAt = new Date().toISOString();
          upsertTask(task);
          this.events.onStatus(task.id, 'failed', task.errorMessage);
          return;
        }
        // 有 Profile 但都在忙：排队等待，把原因显示在任务卡片上（不进重试计数）
        if (task.errorMessage !== '等待空闲 Profile…') {
          task.status = 'pending';
          task.errorMessage = '等待空闲 Profile…';
          upsertTask(task);
          this.events.onStatus(task.id, 'pending', task.errorMessage);
        }
        await sleep(3000);
        attempt--;
        continue;
      }
      if (task.errorMessage === '等待空闲 Profile…') {
        task.errorMessage = undefined;
        upsertTask(task);
      }
      attemptedProfiles.add(profile.id);

      // Profile 互斥锁 + 浏览器并发信号量
      this.busyProfiles.add(profile.id);
      let held = this.taskProfiles.get(task.id);
      if (!held) {
        held = new Set();
        this.taskProfiles.set(task.id, held);
      }
      held.add(profile.id);

      await this.browserSem.acquire();
      try {
        task.status = 'running';
        task.profileId = profile.id;
        task.startedAt = task.startedAt ?? new Date().toISOString();
        upsertTask(task);
        this.events.onStatus(task.id, 'running');

        await this.browsers.launch(profile, settings);
        // §6.6 任务录像：开启时开始录制任务页
        if (settings.recordTasks) await this.browsers.startTaskRecording(profile.id);

        let result: TaskResult;
        if (task.flowId) {
          // 流程回放：确定性执行；步骤失败由 LLM 从当前页面接管修复
          result = await this.runFlowTask(task, profile, settings);
        } else {
          const agent = new AgentCore(this.browsers, this.llm, this.agentHooks);
          result = await agent.run(getTask(task.id) ?? task, profile, settings, this);

          // 存为流程：把本次录制的动作序列固化，之后可秒级回放
          if (task.saveFlowAs) {
            const steps = agent.getRecordedSteps();
            if (steps.length >= 2) {
              upsertFlow({
                id: crypto.randomUUID(),
                name: task.saveFlowAs,
                instruction: task.name,
                steps,
                requiresAuth: task.requiresAuth,
                runCount: 0,
                createdAt: new Date().toISOString(),
              });
            }
          }
        }

        // 结构化采集：把各片段中的 JSON 行合并去重，产出干净表格数据
        if (task.collectFields?.length) {
          const rows = mergeCollectRows(result);
          if (rows.length > 0) {
            result = { ...result, final: JSON.stringify(rows) };
          }
        }

        task.status = 'completed';
        task.result = result;
        task.completedAt = new Date().toISOString();
        upsertTask(task);
        this.events.onStatus(task.id, 'completed');
        this.onChildTerminal(task);
        return;
      } catch (err) {
        if (err instanceof TaskCancelledError || this.cancelled.has(task.id)) {
          task.status = 'failed';
          task.errorMessage = '已被用户终止';
          task.completedAt = new Date().toISOString();
          upsertTask(task);
          this.events.onStatus(task.id, 'failed', task.errorMessage);
          this.onChildTerminal(task);
          return;
        }

        const message = (err as Error).message.slice(0, 500);
        task.retryCount = attempt + 1;
        console.warn(`[scheduler] 任务 ${task.id} 第 ${task.retryCount} 次失败: ${message}`);

        if (attempt < maxRetries) {
          // §8.2：默认同 Profile 重试；仅匿名任务允许换 Profile
          if (!task.requiresAuth) task.profileId = undefined;
          task.status = 'pending';
          task.errorMessage = `第 ${task.retryCount} 次失败：${message}（将重试）`;
          upsertTask(task);
          this.events.onStatus(task.id, 'pending', task.errorMessage);
          await sleep(RETRY_BASE_DELAY_MS * Math.pow(2, attempt)); // 指数退避
          continue;
        }

        task.status = 'failed';
        task.errorMessage = `重试 ${maxRetries} 次后仍失败：${message}`;
        task.completedAt = new Date().toISOString();
        upsertTask(task);
        this.events.onStatus(task.id, 'failed', task.errorMessage);
        this.onChildTerminal(task);
        return;
      } finally {
        // §6.6 录像收尾：关闭任务页 finalize 视频并回写任务记录
        try {
          if (settings.recordTasks) {
            const rec = await this.browsers.stopTaskRecording(profile.id, task.id);
            if (rec) {
              const t = getTask(task.id);
              if (t) {
                t.recordingFile = rec;
                upsertTask(t);
              }
            }
          }
        } catch (err) {
          console.warn('[scheduler] 录像收尾失败:', err);
        }
        this.browserSem.release();
        this.cancelled.delete(task.id);
        this.releaseAll(task.id);
        // 注意：任务结束后浏览器实例保持打开（用户可检查页面/继续操作），
        // 下次任务直接复用；要关闭请到 Profile 管理页手动操作。
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 结构化采集后处理：从所有数据片段（含 done 结果）中抽出 JSON 数组，合并去重为行集合。 */
function mergeCollectRows(result: TaskResult): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  const pushFrom = (text?: string): void => {
    if (!text) return;
    const matches = text.match(/\[[\s\S]*?\]/g) ?? [];
    for (const m of matches) {
      try {
        const arr = JSON.parse(m) as unknown;
        if (!Array.isArray(arr)) continue;
        for (const item of arr) {
          if (item && typeof item === 'object' && !Array.isArray(item)) {
            const key = JSON.stringify(item);
            if (!seen.has(key)) {
              seen.add(key);
              rows.push(item as Record<string, unknown>);
            }
          }
        }
      } catch {
        /* 非 JSON 片段跳过 */
      }
    }
  };
  for (const f of result.fragments) pushFrom(f);
  pushFrom(result.final);
  return rows.slice(0, 1000);
}
