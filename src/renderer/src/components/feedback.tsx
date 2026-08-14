import { useEffect, useRef, useState } from 'react';
import { Icon } from './icons';
import { Button, inputCls } from './ui';

/**
 * 应用内反馈体系：toast + confirmDialog + promptDialog。
 * 全局单例（FeedbackHost 挂载在 App 根部），业务侧直接调函数，替代原生 alert/confirm/prompt。
 */

/* ================= Toast ================= */

type ToastKind = 'success' | 'error' | 'info';
interface ToastItem {
  id: number;
  kind: ToastKind;
  text: string;
}

let nextToastId = 1;
const toastListeners = new Set<(t: ToastItem) => void>();

function emitToast(kind: ToastKind, text: string) {
  const item: ToastItem = { id: nextToastId++, kind, text };
  toastListeners.forEach((l) => l(item));
}

export const toast = {
  success: (text: string) => emitToast('success', text),
  error: (text: string) => emitToast('error', text),
  info: (text: string) => emitToast('info', text),
};

const TOAST_ICON: Record<ToastKind, { name: 'Check' | 'Error' | 'Info'; cls: string }> = {
  success: { name: 'Check', cls: 'text-ok' },
  error: { name: 'Error', cls: 'text-danger' },
  info: { name: 'Info', cls: 'text-info' },
};

/* ================= Confirm / Prompt ================= */

interface ConfirmOptions {
  title: string;
  body?: string;
  danger?: boolean;
  confirmText?: string;
  cancelText?: string;
}

interface PromptOptions {
  title: string;
  defaultValue?: string;
  placeholder?: string;
  confirmText?: string;
}

type DialogState =
  | ({ kind: 'confirm'; resolve: (v: boolean) => void } & ConfirmOptions)
  | ({ kind: 'prompt'; resolve: (v: string | null) => void } & PromptOptions);

const dialogListeners = new Set<(d: DialogState) => void>();

/** 确认对话框：确认 → resolve(true)；取消/遮罩/ESC → resolve(false) */
export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    dialogListeners.forEach((l) => l({ kind: 'confirm', resolve, ...opts }));
  });
}

/** 输入对话框：确认 → resolve(文本)；取消 → resolve(null) */
export function promptDialog(opts: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => {
    dialogListeners.forEach((l) => l({ kind: 'prompt', resolve, ...opts }));
  });
}

/* ================= Host（挂载一次即可） ================= */

export function FeedbackHost() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [dialog, setDialog] = useState<DialogState | null>(null);

  useEffect(() => {
    const tl = (t: ToastItem) => {
      setToasts((s) => [...s.slice(-4), t]); // 最多同时 5 条
      const ttl = t.kind === 'error' ? 5000 : 3200;
      setTimeout(() => setToasts((s) => s.filter((x) => x.id !== t.id)), ttl);
    };
    const dl = (d: DialogState) => setDialog(d);
    toastListeners.add(tl);
    dialogListeners.add(dl);
    return () => {
      toastListeners.delete(tl);
      dialogListeners.delete(dl);
    };
  }, []);

  return (
    <>
      {/* Toast 堆栈：右下，z-1000 */}
      <div className="pointer-events-none fixed bottom-5 right-5 z-[1000] flex w-[340px] flex-col items-end gap-2">
        {toasts.map((t) => {
          const icon = TOAST_ICON[t.kind];
          return (
            <div
              key={t.id}
              className="pointer-events-auto flex w-full items-start gap-2.5 rounded-xl border border-ink-600 bg-ink-700 px-3.5 py-3 shadow-xl animate-toast-in"
              onClick={() => setToasts((s) => s.filter((x) => x.id !== t.id))}
            >
              <Icon name={icon.name} size={18} className={`mt-px shrink-0 ${icon.cls}`} />
              <p className="min-w-0 flex-1 text-[13px] leading-5 text-slate-200">{t.text}</p>
            </div>
          );
        })}
      </div>

      {dialog && <FeedbackDialog dialog={dialog} close={(v) => {
        if (dialog.kind === 'confirm') dialog.resolve(Boolean(v));
        else dialog.resolve(typeof v === 'string' ? v : null);
        setDialog(null);
      }} />}
    </>
  );
}

function FeedbackDialog(props: { dialog: DialogState; close: (v: boolean | string) => void }) {
  const { dialog, close } = props;
  const [value, setValue] = useState(dialog.kind === 'prompt' ? (dialog.defaultValue ?? '') : '');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(false);
      if (e.key === 'Enter') {
        if (dialog.kind === 'prompt') close(value);
        else close(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dialog, value]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      className="fixed inset-0 z-[950] flex items-center justify-center bg-[var(--mask)] p-6 animate-fade-in"
      onClick={() => close(false)}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={dialog.title}
        className="w-full max-w-[360px] rounded-2xl bg-ink-700 p-6 shadow-2xl animate-modal-in"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-base font-medium leading-6 text-slate-200">{dialog.title}</h3>
        {dialog.kind === 'confirm' && dialog.body && (
          <p className="mt-2 text-[13px] leading-5 text-slate-400">{dialog.body}</p>
        )}
        {dialog.kind === 'prompt' && (
          <input
            ref={inputRef}
            className={`${inputCls} mt-4`}
            value={value}
            placeholder={dialog.placeholder}
            onChange={(e) => setValue(e.target.value)}
          />
        )}
        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={() => close(false)}>{dialog.kind === 'confirm' ? (dialog.cancelText ?? '取消') : '取消'}</Button>
          <Button
            variant={dialog.kind === 'confirm' && dialog.danger ? 'danger' : 'primary'}
            onClick={() => (dialog.kind === 'prompt' ? close(value) : close(true))}
          >
            {dialog.confirmText ?? '确认'}
          </Button>
        </div>
      </div>
    </div>
  );
}
