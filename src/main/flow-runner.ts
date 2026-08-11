/**
 * 流程回放器（流程复用的执行引擎）。
 *
 * AI 探路一次后，之后回放完全不调 LLM：
 * - navigate / wait / scroll / extract：直接确定性执行；
 * - click / type / select：先按录制时的 xpath 定位 → 失败则重新序列化页面，
 *   按 tag + 文本模糊匹配找到「同一个元素」并回写新 xpath（自愈）；
 * - 自愈也找不到 → 抛 FlowStepError，由调度器交给 LLM 从当前页面接管修复。
 *
 * 回放过程照常写 TaskStep（含截图），UI 执行日志与普通任务一致。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from 'playwright-core';
import type {
  AgentAction,
  Flow,
  Profile,
  Settings,
  TaskResult,
  TaskStep,
} from '@shared/types';
import { addTaskStep, getLogsDir, getTask, nextStepSeq, updateStepScreenshot, upsertFlow, upsertTask } from './db';
import { locateByIdx, serializePage } from './serializer';
import { TaskCancelledError, type AgentHooks } from './agent-core';
import type { BrowserManager } from './browser-manager';
import type { ElementInfo } from '@shared/types';

/** 回放中某一步彻底失败（xpath 与自愈都找不到元素 / 动作执行报错） */
export class FlowStepError extends Error {
  constructor(
    public readonly stepIndex: number,
    note: string,
    cause: string,
  ) {
    super(`流程第 ${stepIndex + 1} 步「${note}」失败：${cause}`);
    this.name = 'FlowStepError';
  }
}

export interface FlowRunOutcome {
  result: TaskResult;
}

export async function runFlow(
  browsers: BrowserManager,
  hooks: AgentHooks,
  taskId: string,
  flow: Flow,
  profile: Profile,
  settings: Settings,
): Promise<FlowRunOutcome> {
  const page = await browsers.getPage(profile.id);
  const fragments: string[] = [];
  let healed = false;
  let humanRetriedAt = -1; // 人机验证重试去重（同一一步只人工接管重试一次）

  const record = (
    partial: Omit<TaskStep, 'id' | 'taskId' | 'seq' | 'timestamp'>,
    shot = false,
  ): void => {
    const step: TaskStep = {
      id: crypto.randomUUID(),
      taskId,
      seq: nextStepSeq(taskId),
      timestamp: new Date().toISOString(),
      ...partial,
    };
    addTaskStep(step);
    hooks.onStep(step);
    if (shot && settings.screenshotOnStep !== false) {
      const file = path.join(getLogsDir(taskId), `step-${step.seq}.jpg`);
      void browsers
        .screenshot(profile.id)
        .then((b64) => {
          if (!b64) return;
          fs.mkdirSync(getLogsDir(taskId), { recursive: true });
          fs.writeFileSync(file, Buffer.from(b64, 'base64'));
          updateStepScreenshot(step.id, file);
        })
        .catch(() => undefined);
    }
  };

  for (let i = 0; i < flow.steps.length; i++) {
    if (hooks.isCancelled(taskId)) throw new TaskCancelledError();
    const s = flow.steps[i];
    const a = s.action;
    const note = s.note ?? a.type;

    try {
      switch (a.type) {
        case 'navigate':
          await page.goto(a.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
          await page.waitForTimeout(800);
          // 导航后立刻查验证码：有则暂停等真人处理，处理完继续回放
          await ensureHumanPass(page, browsers, hooks, taskId, flow.name, profile.id);
          record({ type: 'navigate', description: `导航到 ${a.url}`, pageStateHash: '', success: true }, true);
          break;

        case 'wait':
          await page.waitForTimeout(Math.min(a.ms, 15_000));
          record({ type: 'wait', description: `等待 ${a.ms}ms`, pageStateHash: '', success: true });
          break;

        case 'scroll':
          await scrollPage(page, a.direction);
          record({ type: 'scroll', description: `滚动页面（${a.direction}）`, pageStateHash: '', success: true }, true);
          break;

        case 'extract': {
          const text = await page.evaluate(() => document.body?.innerText?.slice(0, 3000) ?? '');
          fragments.push(`【${a.note}】\n${text}`);
          record(
            { type: 'extract', description: `${a.note}（已收集 ${text.length} 字符）`, value: text.slice(0, 500), pageStateHash: '', success: true },
            true,
          );
          break;
        }

        case 'click':
        case 'type':
        case 'select': {
          const healedNote = await runElementAction(page, s);
          if (healedNote === null) throw new Error('元素定位失败（xpath 失效且页面中找不到相似元素）');
          if (healedNote) healed = true; // 发生了自愈（xpath 已回写到 s）
          record(
            { type: a.type, description: `${note}${healedNote ? '（已自愈）' : ''}`, value: 'text' in a ? a.text : undefined, pageStateHash: '', success: true },
            true,
          );
          break;
        }

        default:
          // done / switch_profile / human_confirm 等不入流程，跳过
          break;
      }
      await sleep(500); // 动作间隔，给页面喘息
    } catch (err) {
      if (err instanceof TaskCancelledError) throw err;
      // 步骤失败先查是不是人机验证：是则暂停等真人处理，处理完重试本步（每步限一次，防死循环）
      if (humanRetriedAt !== i) {
        const reason = await captchaReason(page);
        if (reason) {
          humanRetriedAt = i;
          await ensureHumanPass(page, browsers, hooks, taskId, flow.name, profile.id, reason);
          i--; // 重试本步
          continue;
        }
      }
      const cause = (err as Error).message.slice(0, 200);
      record({
        type: 'error',
        description: `回放失败：${note}`,
        pageStateHash: '',
        success: false,
        errorMessage: cause,
      });
      throw new FlowStepError(i, note, cause);
    }
  }

  if (healed) upsertFlow(flow); // 自愈后的 xpath 持久化
  return { result: { fragments, final: fragments.join('\n\n') || '流程回放完成' } };
}

/**
 * 元素级动作：xpath 直找 → 自愈匹配。返回 null=失败；''=直接命中；否则为自愈说明。
 */
async function runElementAction(
  page: Page,
  s: { action: AgentAction; xpath?: string; tag?: string; text?: string },
): Promise<string | null> {
  const a = s.action;
  // 1. xpath 直找
  if (s.xpath) {
    try {
      const loc = page.locator(`xpath=${s.xpath}`).first();
      if ((await loc.count()) > 0) {
        await doElementAction(loc, a);
        return '';
      }
    } catch {
      /* xpath 找到但不可交互等，落入自愈 */
    }
  }
  // 2. 自愈：重新序列化，按 tag + 文本找同一元素
  try {
    const snap = await serializePage(page);
    const cand = matchElement(snap.elements, s.tag, s.text);
    if (!cand) return null;
    const el = await locateByIdx(page, snap.elements, cand.idx);
    await doElementAction(el, a);
    s.xpath = cand.xpath;
    s.text = cand.text?.slice(0, 80);
    return `原定位失效，已按「${cand.text.slice(0, 20)}」重新匹配`;
  } catch {
    return null;
  }
}

async function doElementAction(el: Locator, a: AgentAction): Promise<void> {
  switch (a.type) {
    case 'click':
      await el.click({ timeout: 5000 });
      break;
    case 'type':
      await el.click({ timeout: 5000 });
      await el.fill('');
      await el.pressSequentially(a.text, { delay: 30 });
      if (a.pressEnter) await el.press('Enter');
      break;
    case 'select':
      await el.selectOption({ label: a.value }).catch(() => el.selectOption(a.value));
      break;
  }
}

/** 自愈匹配：同 tag 优先，文本完全相等 > 互相包含；文本为空时仅靠 tag+类型不可靠，放弃 */
function matchElement(elements: ElementInfo[], tag?: string, text?: string): ElementInfo | null {
  const norm = (s?: string) => (s ?? '').replace(/\s+/g, ' ').trim();
  const wantText = norm(text);
  if (!wantText) return null;
  const pool = elements.filter((e) => !tag || e.tag === tag);
  return (
    pool.find((e) => norm(e.text) === wantText) ??
    pool.find((e) => {
      const t = norm(e.text);
      return t.length > 0 && (t.includes(wantText) || wantText.includes(t));
    }) ??
    null
  );
}

async function scrollPage(page: Page, direction: 'up' | 'down' | 'top' | 'bottom'): Promise<void> {
  switch (direction) {
    case 'top':
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior }));
      break;
    case 'bottom':
      await page.evaluate(() =>
        window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' as ScrollBehavior }),
      );
      break;
    default:
      await page.mouse.wheel(0, direction === 'up' ? -600 : 600);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 人机验证检测（回放路径的确定性两路：验证码组件域名 + 页面关键词，同 §7.7） */
async function captchaReason(page: Page): Promise<string | null> {
  try {
    const patterns = ['recaptcha', 'hcaptcha', 'challenges.cloudflare.com', 'captcha', 'geetest', 'punish'];
    for (const frame of page.frames()) {
      const url = frame.url().toLowerCase();
      if (patterns.some((p) => url.includes(p))) {
        let host = url.slice(0, 60);
        try {
          host = new URL(url).hostname;
        } catch {
          /* 用截断 url 兜底 */
        }
        return `检测到验证码组件（${host}）`;
      }
    }
    const text = (await page.evaluate(() => document.body?.innerText?.slice(0, 3000) ?? '')).toLowerCase();
    const keywords = ['captcha', 'verify you are human', '人机验证', '安全验证', '滑动验证', '点击验证', '请完成安全验证'];
    if (keywords.some((k) => text.includes(k))) return '页面出现人机验证内容';
  } catch {
    /* 页面跳转中/已关闭，视为无验证 */
  }
  return null;
}

/**
 * 人机验证接管：弹窗（带实时截图）请真人到对应浏览器窗口完成验证；
 * 点"继续"后复检，最多 5 轮；点"终止"抛 TaskCancelledError。
 */
async function ensureHumanPass(
  page: Page,
  browsers: BrowserManager,
  hooks: AgentHooks,
  taskId: string,
  flowName: string,
  profileId: string,
  knownReason?: string,
): Promise<void> {
  for (let round = 0; round < 5; round++) {
    const reason = round === 0 && knownReason ? knownReason : await captchaReason(page);
    if (!reason) return;

    const task = getTask(taskId);
    if (task) {
      task.status = 'paused';
      upsertTask(task);
    }
    const screenshotBase64 = await browsers.screenshot(profileId);
    const choice = await hooks.requestHumanConfirm({
      taskId,
      taskName: flowName,
      reason: `流程回放遇到人机验证：${reason}。请到该 Profile 的浏览器窗口完成验证，然后点"继续"。`,
      screenshotBase64,
      recentActions: [],
    });
    const after = getTask(taskId);
    if (after && after.status === 'paused') {
      after.status = 'running';
      upsertTask(after);
    }
    if (choice === 'terminate') throw new TaskCancelledError();
    await page.waitForTimeout(1000); // 等验证跳转收敛，下一轮复检
  }
  // 5 轮仍未通过：返回后由上层按步骤失败处理（LLM 接管 / 失败）
}
