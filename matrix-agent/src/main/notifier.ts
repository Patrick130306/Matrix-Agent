/**
 * 任务终态通知：桌面通知 + Webhook 回调（钉钉/企微/自建服务）。
 *
 * 触发点：调度器 onStatus 回压到主进程后，任务到达 completed / failed。
 * 批量子任务不单独通知（避免 N 个 Profile 刷 N 条），父任务聚合完成时统一通知。
 */
import { Notification } from 'electron';
import type { Settings, Task } from '@shared/types';

const WEBHOOK_TIMEOUT_MS = 8_000;

/** 任务到达终态时调用（内部自行过滤非终态与子任务）。 */
export function notifyTaskTerminal(task: Task, settings: Settings): void {
  if (task.status !== 'completed' && task.status !== 'failed') return;
  if (task.parentId) return; // 批量子任务不单独通知，父任务聚合时统一发

  const ok = task.status === 'completed';
  const title = `${ok ? '✅ 任务完成' : '❌ 任务失败'}：${task.name.slice(0, 40)}`;
  const excerpt = (ok ? task.result?.final : task.errorMessage) ?? '';
  const body = excerpt.replace(/\s+/g, ' ').slice(0, 120) || (ok ? '（无文本结果）' : '未知错误');

  // 桌面通知
  if (settings.notifyDesktop && Notification.isSupported()) {
    try {
      new Notification({ title, body }).show();
    } catch (err) {
      console.warn('[notify] 桌面通知失败:', err);
    }
  }

  // Webhook
  if (settings.webhookUrl && (settings.webhookEvents === 'all' || !ok)) {
    void postWebhook(settings.webhookUrl, {
      msgtype: 'text',
      text: { content: `${title}\n${body}` },
      // 通用字段，自建服务/钉钉/企微各取所需
      source: 'matrix-agent',
      task: {
        id: task.id,
        name: task.name,
        type: task.type,
        status: task.status,
        error: task.errorMessage,
        result: task.result?.final?.slice(0, 2000),
        createdAt: task.createdAt,
        completedAt: task.completedAt,
      },
    });
  }
}

/** 设置页「测试 Webhook」按钮 */
export async function testWebhook(
  url: string,
): Promise<{ ok: boolean; status?: number; error?: string }> {
  if (!url.trim()) return { ok: false, error: 'Webhook 地址为空' };
  try {
    const res = await postWebhook(url, {
      msgtype: 'text',
      text: { content: 'Matrix Agent Webhook 测试消息 ✅' },
      source: 'matrix-agent',
      task: { type: 'test' },
    });
    return { ok: res.ok, status: res.status, error: res.ok ? undefined : `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, error: (err as Error).message.slice(0, 200) };
  }
}

async function postWebhook(url: string, payload: Record<string, unknown>): Promise<Response> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
  });
  if (!res.ok) console.warn(`[notify] Webhook 返回 HTTP ${res.status}`);
  return res;
}
