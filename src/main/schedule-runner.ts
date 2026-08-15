/**
 * 定时任务引擎：每 30s 扫描到点的 Schedule，按 Profile 配置下发单任务或批量任务。
 * 规则类型（ScheduleSpec）：
 *   - interval：每 N 分钟
 *   - daily：每日 HH:MM（本地时间）
 *   - cron：5 段 cron 表达式（分 时 日 月 周，本地时间），支持 * / 数字 / 范围 a-b / 列表 a,b / 步长（星号斜杠 n）
 * 错过补跑：应用启动时若发现已过 nextRunAt 且超过 2 分钟（说明关机/离线错过），补触发一次再顺延。
 */
import type { Schedule, ScheduleSpec } from '@shared/types';
import { listDueSchedules, listSchedules, upsertSchedule } from './db';

// ---------------------------------------------------------------- cron 解析

function parseCronField(field: string, min: number, max: number): Set<number> | null {
  const values = new Set<number>();
  for (const part of field.split(',')) {
    const stepMatch = part.match(/^(\*|\d+)(?:\/(\d+))?$/);
    if (!stepMatch) return null; // 不支持的语法（如 ? L W），按不匹配处理
    const base = stepMatch[1] === '*' ? min : Number(stepMatch[1]);
    const step = stepMatch[2] ? Number(stepMatch[2]) : 1;
    if (!Number.isFinite(base) || !Number.isFinite(step) || step < 1) return null;

    const rangeMatch = part.match(/^(\d+)-(\d+)(?:\/(\d+))?$/);
    if (rangeMatch) {
      const a = Number(rangeMatch[1]);
      const b = Number(rangeMatch[2]);
      const s = rangeMatch[3] ? Number(rangeMatch[3]) : 1;
      if (a > b || s < 1) return null;
      for (let v = a; v <= b; v += s) values.add(v);
    } else if (stepMatch[1] === '*') {
      for (let v = min; v <= max; v += step) values.add(v);
    } else {
      values.add(base);
    }
  }
  return values;
}

interface CronParts {
  minutes: Set<number> | null;
  hours: Set<number> | null;
  days: Set<number> | null;
  months: Set<number> | null;
  weekdays: Set<number> | null;
}

function parseCron(expr: string): CronParts | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [min, hour, day, month, weekday] = fields;
  return {
    minutes: parseCronField(min, 0, 59),
    hours: parseCronField(hour, 0, 23),
    days: parseCronField(day, 1, 31),
    months: parseCronField(month, 1, 12),
    weekdays: parseCronField(weekday, 0, 6), // 0 = 周日
  };
}

function matches(parts: CronParts, d: Date): boolean {
  if (parts.minutes && !parts.minutes.has(d.getMinutes())) return false;
  if (parts.hours && !parts.hours.has(d.getHours())) return false;
  if (parts.months && !parts.months.has(d.getMonth() + 1)) return false;
  if (parts.days && !parts.days.has(d.getDate())) return false;
  if (parts.weekdays && !parts.weekdays.has(d.getDay())) return false;
  return true;
}

/** 从 from 之后找下一个匹配分钟（最多往后扫 3 年，防表达式无解时死循环） */
export function nextCronTime(expr: string, from: Date): Date | null {
  const parts = parseCron(expr);
  if (!parts) return null;
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1); // 从下一分钟开始
  const limit = from.getTime() + 3 * 366 * 24 * 60 * 60_000;
  while (d.getTime() <= limit) {
    if (matches(parts, d)) return d;
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

// ---------------------------------------------------------------- 下次运行时间

export function computeNextRun(spec: ScheduleSpec, from: Date = new Date()): string {
  if (spec.kind === 'interval') {
    return new Date(from.getTime() + Math.max(1, spec.everyMin) * 60_000).toISOString();
  }
  if (spec.kind === 'cron') {
    const next = nextCronTime(spec.expr, from);
    return (next ?? new Date(from.getTime() + 24 * 60 * 60_000)).toISOString();
  }
  // daily：下一个本地 HH:MM
  const [hh, mm] = spec.hhmm.split(':').map((s) => parseInt(s, 10));
  const next = new Date(from);
  next.setHours(Number.isFinite(hh) ? hh : 9, Number.isFinite(mm) ? mm : 0, 0, 0);
  if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1);
  return next.toISOString();
}

/** 描述规则（UI 展示用） */
export function describeSpec(spec: ScheduleSpec): string {
  switch (spec.kind) {
    case 'interval':
      return `每 ${spec.everyMin} 分钟`;
    case 'daily':
      return `每日 ${spec.hhmm}`;
    case 'cron':
      return `cron ${spec.expr}`;
  }
}

// ---------------------------------------------------------------- 引擎

export interface ScheduleDispatch {
  /** 按 schedule 的 Profile 配置下发任务 */
  dispatch(s: Schedule): void;
}

/** 错过补跑阈值：nextRunAt 已过超过该时长才视为"错过"（避免刚触发还没更新的抖动） */
const MISS_THRESHOLD_MS = 2 * 60_000;

export function startScheduleRunner(dispatch: ScheduleDispatch['dispatch']): () => void {
  const trigger = (s: Schedule, at: Date) => {
    try {
      dispatch(s);
      s.lastRunAt = at.toISOString();
    } catch (err) {
      console.error(`[schedule] 触发失败 ${s.name}:`, err);
    }
    s.nextRunAt = computeNextRun(s.spec, at);
    upsertSchedule(s);
    console.log(`[schedule] 已触发「${s.name}」，下次：${s.nextRunAt}`);
  };

  const tick = () => {
    const now = new Date();
    let due: Schedule[];
    try {
      due = listDueSchedules(now.toISOString());
    } catch (err) {
      console.error('[schedule] 扫描失败:', err);
      return;
    }
    for (const s of due) trigger(s, now);
  };

  // 启动即检查：错过补跑 + 到期触发
  const onStart = () => {
    const now = new Date();
    let all: Schedule[];
    try {
      all = listSchedules();
    } catch {
      return;
    }
    for (const s of all) {
      if (!s.enabled || !s.nextRunAt) continue;
      const next = new Date(s.nextRunAt).getTime();
      // 已过 nextRunAt 且超过阈值 = 关机/离线错过 → 补触发一次（每个调度只补一次，避免积压风暴）
      if (now.getTime() - next > MISS_THRESHOLD_MS) {
        console.log(`[schedule]「${s.name}」错过预定时间（原 ${s.nextRunAt}），补跑一次`);
        trigger(s, now);
      }
    }
    tick();
  };

  const timer = setInterval(tick, 30_000);
  onStart();
  return () => clearInterval(timer);
}
