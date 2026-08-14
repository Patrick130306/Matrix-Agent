/**
 * §11.3 LLM Client。
 * - 封装 OpenAI 兼容 chat completions 调用（Node 18+ 原生 fetch，不引入 axios）；
 * - JSON mode 探测与缓存（按 BaseURL）；
 * - 三级兜底解析（§7.5，action-protocol 协作）；
 * - 接入 LLM 并发信号量（§8.1）+ 429 退避重试。
 */
import type { AgentAction, Settings } from '@shared/types';
import { LLM_PARSE_MAX_RETRIES } from '@shared/constants';
import { buildRetryMessage, parseAction } from './action-protocol';
import type { Semaphore } from './semaphore';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** LLM 调用返回：内容 + token 用量（仪表盘成本估算用） */
export interface ChatResult {
  content: string;
  usage: { promptTokens: number; completionTokens: number };
}

export class LLMError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'LLMError';
  }
}

export class LLMParseFailedError extends Error {
  constructor(public readonly lastRaw: string) {
    super('LLM 输出多次解析失败');
    this.name = 'LLMParseFailedError';
  }
}

const REQUEST_TIMEOUT_MS = 90_000;
const RATE_LIMIT_MAX_RETRIES = 3;

export class LLMClient {
  /** JSON mode 支持探测缓存（按 BaseURL） */
  private readonly jsonModeSupport = new Map<string, boolean>();

  constructor(private readonly semaphore: Semaphore) {}

  /** §8.1：所有 LLM 请求都经过并发信号量。 */
  private async rawChat(
    settings: Pick<Settings, 'llmBaseUrl' | 'llmModel' | 'llmMaxTokens' | 'llmTemperature'>,
    apiKey: string,
    messages: ChatMessage[],
    useJsonMode: boolean,
  ): Promise<ChatResult> {
    const url = `${settings.llmBaseUrl.replace(/\/+$/, '')}/chat/completions`;
    const body: Record<string, unknown> = {
      model: settings.llmModel,
      messages,
      max_tokens: settings.llmMaxTokens,
      temperature: settings.llmTemperature,
      stream: false,
    };
    if (useJsonMode) body.response_format = { type: 'json_object' };

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (res.status === 429) throw new LLMError('LLM 限流（429）', 429);

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      // JSON mode 不被支持的典型特征
      if (useJsonMode && res.status === 400 && /response_format|json/i.test(text)) {
        throw new LLMError('__JSON_MODE_UNSUPPORTED__', 400);
      }
      throw new LLMError(`LLM 请求失败 HTTP ${res.status}: ${text.slice(0, 500)}`, res.status);
    }

    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.length === 0) {
      throw new LLMError('LLM 返回了空内容');
    }
    return {
      content,
      usage: {
        promptTokens: data.usage?.prompt_tokens ?? 0,
        completionTokens: data.usage?.completion_tokens ?? 0,
      },
    };
  }

  /** 带 JSON mode 探测缓存与 429 退避的对话调用。 */
  async chat(
    settings: Pick<Settings, 'llmBaseUrl' | 'llmModel' | 'llmMaxTokens' | 'llmTemperature'>,
    apiKey: string,
    messages: ChatMessage[],
  ): Promise<ChatResult> {
    return this.semaphore.use(async () => {
      const baseUrl = settings.llmBaseUrl;
      let useJsonMode = this.jsonModeSupport.get(baseUrl) !== false;

      let lastError: Error | null = null;
      for (let attempt = 0; attempt <= RATE_LIMIT_MAX_RETRIES; attempt++) {
        try {
          return await this.rawChat(settings, apiKey, messages, useJsonMode);
        } catch (err) {
          if (err instanceof LLMError && err.message === '__JSON_MODE_UNSUPPORTED__') {
            // 探测结论：不支持 JSON mode，按 BaseURL 缓存并重试一次（§7.5 第一级）
            this.jsonModeSupport.set(baseUrl, false);
            useJsonMode = false;
            continue;
          }
          if (err instanceof LLMError && err.status === 429 && attempt < RATE_LIMIT_MAX_RETRIES) {
            // §17：429 退避重试
            await sleep(2000 * Math.pow(2, attempt));
            continue;
          }
          lastError = err as Error;
          break;
        }
      }
      // 成功的 JSON mode 调用也缓存结论
      if (useJsonMode && !lastError) this.jsonModeSupport.set(baseUrl, true);
      throw lastError ?? new LLMError('LLM 请求失败');
    });
  }

  /**
   * §7.5 决策调用：JSON 三级兜底。
   * 解析失败时携带错误重试（最多 LLM_PARSE_MAX_RETRIES 次）；仍失败抛 LLMParseFailedError，
   * 由上层转 human_confirm，不直接判任务失败。
   * 返回动作 + 本次决策累计的 token 用量（多次重试累加）。
   */
  async decideAction(
    settings: Pick<Settings, 'llmBaseUrl' | 'llmModel' | 'llmMaxTokens' | 'llmTemperature'>,
    apiKey: string,
    messages: ChatMessage[],
  ): Promise<{ actions: AgentAction[]; usage: { promptTokens: number; completionTokens: number } }> {
    const history = [...messages];
    let lastRaw = '';
    let lastError = '';
    const usage = { promptTokens: 0, completionTokens: 0 };

    for (let attempt = 0; attempt <= LLM_PARSE_MAX_RETRIES; attempt++) {
      const res = await this.chat(settings, apiKey, history);
      lastRaw = res.content;
      usage.promptTokens += res.usage.promptTokens;
      usage.completionTokens += res.usage.completionTokens;
      const parsed = parseAction(res.content);
      if (parsed.ok && parsed.actions?.length) return { actions: parsed.actions, usage };

      lastError = parsed.error ?? '未知解析错误';
      // 第三级：原样回传非法输出 + 错误信息
      history.push({ role: 'assistant', content: res.content });
      history.push({ role: 'user', content: buildRetryMessage(res.content, lastError) });
    }

    throw new LLMParseFailedError(lastRaw);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
