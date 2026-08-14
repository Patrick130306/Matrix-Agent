import { useEffect, type PropsWithChildren, type ReactNode } from 'react';
import type { TaskStatus } from '@shared/types';
import { Icon, type IconName } from './icons';

/* ================= Button（对齐 Kimi Web Button：26 / 32 / 44 三档） ================= */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'outline' | 'danger';
type ButtonSize = 'sm' | 'md' | 'lg';

const BTN_SIZE: Record<ButtonSize, string> = {
  sm: 'h-[26px] min-w-[52px] gap-1 rounded-lg px-2 text-xs font-medium',
  md: 'h-8 min-w-[62px] gap-1 rounded-[10px] px-2.5 text-sm font-medium',
  lg: 'h-11 min-w-[72px] gap-1.5 rounded-xl px-3.5 text-base font-medium',
};

const BTN_ICON_SIZE: Record<ButtonSize, number> = { sm: 16, md: 18, lg: 20 };

const BTN_VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-[var(--btn-primary-bg)] text-[var(--btn-primary-fg)] hover:opacity-90',
  secondary: 'bg-[var(--fill-1)] text-slate-200 hover:bg-[var(--fill-2)]',
  ghost: 'bg-[var(--fill-1)] text-slate-200 hover:bg-[var(--fill-2)]', // 兼容旧调用
  outline: 'border border-ink-600 bg-transparent text-slate-200 hover:bg-[var(--fill-1)]',
  danger: 'bg-danger-soft text-danger hover:bg-[var(--danger-soft-strong)]',
};

export function Button(props: {
  children: ReactNode;
  onClick?: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  leftIcon?: IconName;
  disabled?: boolean;
  className?: string;
  type?: 'button' | 'submit';
  title?: string;
}) {
  const size = props.size ?? 'md';
  return (
    <button
      type={props.type ?? 'button'}
      className={`inline-flex select-none items-center justify-center whitespace-nowrap transition-[background-color,border-color,color,transform] duration-150 ease-out active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40 disabled:active:scale-100 ${BTN_SIZE[size]} ${BTN_VARIANT[props.variant ?? 'secondary']} ${props.className ?? ''}`}
      onClick={props.onClick}
      disabled={props.disabled}
      title={props.title}
    >
      {props.leftIcon && <Icon name={props.leftIcon} size={BTN_ICON_SIZE[size]} />}
      {props.children}
    </button>
  );
}

/* ================= IconButton（工具行/行内图标动作） ================= */

export function IconButton(props: {
  name: IconName;
  onClick?: () => void;
  title: string; // 必填：图标按钮必须有无障碍名
  danger?: boolean;
  disabled?: boolean;
  size?: number;
  className?: string;
}) {
  return (
    <button
      type="button"
      title={props.title}
      aria-label={props.title}
      disabled={props.disabled}
      onClick={props.onClick}
      className={`inline-flex h-[26px] w-[26px] items-center justify-center rounded-md transition-[background-color,color,transform] duration-150 ease-out active:scale-95 disabled:cursor-not-allowed disabled:opacity-40 ${
        props.danger
          ? 'text-slate-400 hover:bg-danger-soft hover:text-danger'
          : 'text-slate-400 hover:bg-[var(--fill-2)] hover:text-slate-200'
      } ${props.className ?? ''}`}
    >
      <Icon name={props.name} size={props.size ?? 16} />
    </button>
  );
}

/* ================= Card ================= */

export function Card(props: PropsWithChildren<{ className?: string }>) {
  return (
    <div className={`rounded-xl border border-ink-600 bg-ink-800 ${props.className ?? ''}`}>
      {props.children}
    </div>
  );
}

/* ================= PageHeader（页面标题区） ================= */

export function PageHeader(props: { title: string; desc?: string; extra?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold leading-7 text-slate-200">{props.title}</h1>
        {props.desc && <p className="mt-1 text-[13px] leading-[18px] text-slate-500">{props.desc}</p>}
      </div>
      {props.extra && <div className="flex shrink-0 items-center gap-2">{props.extra}</div>}
    </div>
  );
}

/* ================= StatusBadge（任务状态徽章，语义色） ================= */

const STATUS_STYLE: Record<TaskStatus, { label: string; cls: string }> = {
  pending: { label: '排队中', cls: 'bg-[var(--fill-2)] text-slate-400' },
  running: { label: '运行中', cls: 'bg-info-soft text-info' },
  paused: { label: '等待人工', cls: 'bg-warn-soft text-warn' },
  interrupted: { label: '已中断', cls: 'bg-violet-soft text-violet' },
  completed: { label: '已完成', cls: 'bg-ok-soft text-ok' },
  failed: { label: '失败', cls: 'bg-danger-soft text-danger' },
};

export function StatusBadge({ status }: { status: TaskStatus }) {
  const s = STATUS_STYLE[status] ?? STATUS_STYLE.pending;
  return (
    <span className={`inline-flex h-[22px] items-center gap-1 rounded-md px-1.5 text-xs font-medium ${s.cls}`}>
      {status === 'running' && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-info" />}
      {s.label}
    </span>
  );
}

/* ================= Field / inputCls（表单） ================= */

export function Field(props: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[13px] leading-[18px] text-slate-400">{props.label}</span>
      {props.children}
      {props.hint && <span className="mt-1.5 block text-xs leading-4 text-slate-500">{props.hint}</span>}
    </label>
  );
}

export const inputCls =
  'w-full rounded-xl border border-transparent bg-[var(--fill-1)] px-3 py-2.5 text-sm leading-5 text-slate-200 placeholder:text-slate-500 transition-colors duration-150 hover:bg-[var(--fill-1)] focus:border-ink-600 focus:bg-[var(--fill-1)] focus:outline-none disabled:opacity-50';

/* ================= Modal（z-800/810，150-200ms ease-out 入场） ================= */

export function Modal(props: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  footer?: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props.onClose]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      className="fixed inset-0 z-[800] flex items-center justify-center bg-[var(--mask)] p-6 animate-fade-in"
      onClick={props.onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        className={`flex max-h-[85vh] w-full ${props.wide ? 'max-w-[720px]' : 'max-w-[560px]'} flex-col rounded-2xl bg-ink-700 shadow-2xl animate-modal-in`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex h-6 items-center justify-between px-6 pt-6">
          <h3 className="text-base font-medium leading-6 text-slate-200">{props.title}</h3>
          <IconButton name="Close" title="关闭" onClick={props.onClose} className="-mr-1.5" />
        </div>
        <div className="flex-1 overflow-auto px-6 pb-6 pt-4">{props.children}</div>
        {props.footer && (
          <div className="flex items-center justify-end gap-2 border-t border-ink-600 px-6 py-4">
            {props.footer}
          </div>
        )}
      </div>
    </div>
  );
}

/* ================= Toggle（开关：lg 44×24 / sm 32×18，圆形滑块） ================= */

export function Toggle(props: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  size?: 'lg' | 'sm';
}) {
  const lg = props.size !== 'sm';
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
      className={`relative shrink-0 rounded-full transition-colors duration-150 ease-out disabled:cursor-not-allowed disabled:opacity-40 ${
        lg ? 'h-6 w-11' : 'h-[18px] w-8'
      } ${props.checked ? 'bg-[var(--toggle-on-bg)]' : 'bg-[var(--fill-3)] hover:bg-[var(--ink-500)]'}`}
    >
      <span
        className={`absolute left-[2px] top-[2px] rounded-full transition-transform duration-200 ease-out ${
          lg ? 'h-5 w-5' : 'h-[14px] w-[14px]'
        } ${props.checked ? 'bg-[var(--toggle-on-knob)]' : 'bg-[var(--knob-off)]'}`}
        style={{
          transform: props.checked ? `translateX(${lg ? 20 : 14}px)` : 'translateX(0)',
        }}
      />
    </button>
  );
}

/* ================= CheckCircle（圆形选择控件，checkbox/radio 统一形态） ================= */

export function CheckCircle(props: {
  checked: boolean;
  onChange?: (v: boolean) => void;
  size?: 16 | 20;
  disabled?: boolean;
  className?: string;
}) {
  const s = props.size ?? 20;
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={props.checked}
      disabled={props.disabled}
      onClick={() => props.onChange?.(!props.checked)}
      className={`inline-flex shrink-0 items-center justify-center rounded-full transition-colors duration-150 ease-out disabled:cursor-not-allowed disabled:opacity-40 ${
        props.checked
          ? 'bg-[var(--check-on-bg)]'
          : 'border-[1.8px] border-[var(--line-2)] bg-transparent hover:border-[var(--ink-500)]'
      } ${props.className ?? ''}`}
      style={{ width: s, height: s }}
    >
      {props.checked && (
        <svg width={s * 0.6} height={s * 0.6} viewBox="0 0 12 12" fill="none">
          <path
            d="M2.2 6.2L4.8 8.8L9.8 3.4"
            style={{ stroke: 'var(--check-on-fg)' }}
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </button>
  );
}

/* ================= Segmented（分段选择器：筛选/模式切换） ================= */

export function Segmented<T extends string>(props: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <div className={`inline-flex items-center gap-0.5 rounded-[10px] bg-[var(--fill-1)] p-[3px] ${props.className ?? ''}`}>
      {props.options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => props.onChange(o.value)}
          className={`h-[26px] whitespace-nowrap rounded-lg px-3 text-[13px] font-medium transition-colors duration-150 ease-out ${
            props.value === o.value ? 'bg-ink-700 text-slate-200' : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ================= EmptyState（空状态） ================= */

export function EmptyState(props: { icon: IconName; title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--fill-1)] text-slate-500">
        <Icon name={props.icon} size={24} />
      </div>
      <p className="mt-4 text-sm font-medium text-slate-300">{props.title}</p>
      {props.hint && <p className="mt-1 max-w-[320px] text-[13px] leading-[18px] text-slate-500">{props.hint}</p>}
      {props.action && <div className="mt-5">{props.action}</div>}
    </div>
  );
}
