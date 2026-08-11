/**
 * §7.5 LLM 输出协议与 JSON 健壮性。
 *
 * 线协议：LLM 输出单个 JSON 对象 { "action": "...", "params": {...}, "reason": "..." }
 * 三级兜底（替代 v1.0 的 "retry + fallback prompt"）：
 *   1. JSON mode（llm-client 探测并按 BaseURL 缓存）
 *   2. 修复解析：剥 markdown 围栏 → 截取首个完整 {...} 块 → jsonrepair → zod 校验
 *   3. 携带错误的重试（见 llm-client），仍失败转 human_confirm
 */
import { z } from 'zod';
import { jsonrepair } from 'jsonrepair';
import type { AgentAction } from '@shared/types';

const reason = z.string().default('');

const actionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('navigate'), params: z.object({ url: z.string().min(1) }), reason }),
  z.object({ action: z.literal('click'), params: z.object({ idx: z.number().int().nonnegative() }), reason }),
  z.object({
    action: z.literal('type'),
    params: z.object({
      idx: z.number().int().nonnegative(),
      text: z.string(),
      pressEnter: z.boolean().optional(),
    }),
    reason,
  }),
  z.object({
    action: z.literal('select'),
    params: z.object({ idx: z.number().int().nonnegative(), value: z.string() }),
    reason,
  }),
  z.object({
    action: z.literal('scroll'),
    params: z.object({ direction: z.enum(['up', 'down', 'top', 'bottom']) }),
    reason,
  }),
  z.object({
    action: z.literal('extract'),
    params: z.object({ note: z.string().default('提取页面数据') }),
    reason,
  }),
  z.object({
    action: z.literal('wait'),
    params: z.object({ ms: z.number().int().positive().max(15_000) }),
    reason,
  }),
  z.object({
    action: z.literal('switch_profile'),
    params: z.object({ name: z.string().min(1) }),
    reason,
  }),
  z.object({
    action: z.literal('human_confirm'),
    params: z.object({ message: z.string().optional() }).default({}),
    reason,
  }),
  z.object({ action: z.literal('done'), params: z.object({ result: z.string() }), reason }),
  z.object({ action: z.literal('error'), params: z.object({ reason: z.string() }).partial().default({}), reason }),
]);

type WireAction = z.infer<typeof actionSchema>;

export interface ParseResult {
  ok: boolean;
  /** 一次决策可包含多个动作（批量执行，减少 LLM 往返）；单动作也是长度为 1 的数组 */
  actions?: AgentAction[];
  error?: string;
}

/** 线协议 → 内部 AgentAction */
function toInternal(w: WireAction): AgentAction {
  switch (w.action) {
    case 'navigate':
      return { type: 'navigate', url: w.params.url, reason: w.reason };
    case 'click':
      return { type: 'click', idx: w.params.idx, reason: w.reason };
    case 'type':
      return { type: 'type', idx: w.params.idx, text: w.params.text, pressEnter: w.params.pressEnter, reason: w.reason };
    case 'select':
      return { type: 'select', idx: w.params.idx, value: w.params.value, reason: w.reason };
    case 'scroll':
      return { type: 'scroll', direction: w.params.direction, reason: w.reason };
    case 'extract':
      return { type: 'extract', note: w.params.note, reason: w.reason };
    case 'wait':
      return { type: 'wait', ms: w.params.ms, reason: w.reason };
    case 'switch_profile':
      return { type: 'switch_profile', name: w.params.name, reason: w.reason };
    case 'human_confirm':
      return { type: 'human_confirm', reason: w.reason, message: w.params.message };
    case 'done':
      return { type: 'done', result: w.params.result, reason: w.reason };
    case 'error':
      return { type: 'error', reason: w.params.reason ?? w.reason ?? 'LLM 报告错误' };
  }
}

/** 截取首个括号配平的 {...} 块 */
function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

const batchSchema = z.object({ actions: z.array(actionSchema).min(1).max(5) });

/** 三级兜底之第二级：修复解析。支持单动作对象或 {"actions": [...]} 批量格式。 */
export function parseAction(raw: string): ParseResult {
  // 剥 markdown 围栏
  let text = raw.trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  const candidate = extractFirstJsonObject(text);
  if (!candidate) return { ok: false, error: '输出中找不到 JSON 对象' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    try {
      parsed = JSON.parse(jsonrepair(candidate));
    } catch (err) {
      return { ok: false, error: `JSON 修复失败: ${(err as Error).message}` };
    }
  }

  // 批量格式优先
  if (typeof parsed === 'object' && parsed !== null && 'actions' in parsed) {
    const batch = batchSchema.safeParse(parsed);
    if (batch.success) {
      return { ok: true, actions: batch.data.actions.map(toInternal) };
    }
    return {
      ok: false,
      error: `批量 actions 校验失败: ${batch.error.issues[0]?.message ?? '未知'}`,
    };
  }

  const result = actionSchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, error: `action schema 校验失败: ${result.error.issues[0]?.message ?? '未知'}` };
  }
  return { ok: true, actions: [toInternal(result.data)] };
}

/** 三级兜底之第三级：携带错误的重试提示。 */
export function buildRetryMessage(badOutput: string, error: string): string {
  return (
    `你上次返回了无法解析的输出：\n"""\n${badOutput.slice(0, 2000)}\n"""\n` +
    `解析错误：${error}\n` +
    `请仅返回一个合法的 JSON 对象，不要输出任何其他文字、解释或 markdown 围栏。`
  );
}
