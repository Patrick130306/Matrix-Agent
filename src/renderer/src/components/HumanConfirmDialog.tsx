import { useEffect, useState } from 'react';
import type { HumanConfirmRequest } from '@shared/types';
import { matrix } from '../api';
import { Button } from './ui';
import { Icon } from './icons';

/**
 * §9 Human-in-the-Loop 弹窗：
 * 当前页面截图 + Agent 的推理过程（最近几步）+ "我已处理，继续" / "终止任务"。
 * 关键操作：不响应遮罩点击，必须显式选择。
 */
export function HumanConfirmDialog() {
  const [queue, setQueue] = useState<HumanConfirmRequest[]>([]);

  useEffect(() => {
    return matrix.events.onHumanConfirm((req) => setQueue((q) => [...q, req]));
  }, []);

  const current = queue[0];
  if (!current) return null;

  const respond = (choice: 'continue' | 'terminate') => {
    void matrix.humanConfirm.respond(current.requestId, choice);
    setQueue((q) => q.slice(1));
  };

  return (
    <div className="fixed inset-0 z-[900] flex items-center justify-center bg-[var(--mask)] p-6 animate-fade-in">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label="任务暂停，等待人工处理"
        className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-ink-700 shadow-2xl animate-modal-in"
      >
        <div className="border-b border-warn/20 bg-warn-soft px-6 py-4">
          <h3 className="flex items-center gap-2 text-base font-medium text-warn">
            <Icon name="Warning" size={20} />
            任务暂停，等待人工处理
          </h3>
          <p className="mt-1 truncate text-xs text-slate-400">任务：{current.taskName}</p>
        </div>

        <div className="flex-1 space-y-4 overflow-auto p-6">
          <div className="rounded-[10px] bg-[var(--fill-1)] p-3.5 text-sm leading-6 text-slate-200">
            {current.reason}
          </div>

          {current.screenshotBase64 && (
            <img
              src={`data:image/jpeg;base64,${current.screenshotBase64}`}
              alt="当前页面截图"
              className="w-full rounded-[10px] border border-ink-600"
            />
          )}

          {current.recentActions.length > 0 && (
            <div>
              <p className="mb-1.5 text-xs text-slate-500">Agent 最近的动作：</p>
              <ul className="space-y-1 text-xs text-slate-400">
                {current.recentActions.map((a, i) => (
                  <li key={i} className="rounded-md bg-[var(--mask-strong)] px-2.5 py-1.5 font-mono">
                    {a.description}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <p className="text-xs leading-5 text-slate-500">
            请到对应的 Chrome 窗口完成人工操作（如通过验证码、确认订单），完成后回来点击「继续」。
          </p>
        </div>

        <div className="flex justify-end gap-2 border-t border-ink-600 px-6 py-4">
          <Button variant="danger" onClick={() => respond('terminate')}>
            终止任务
          </Button>
          <Button variant="primary" leftIcon="Play" onClick={() => respond('continue')}>
            我已处理，继续
          </Button>
        </div>
      </div>
    </div>
  );
}
