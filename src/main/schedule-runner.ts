/**
 * 定时任务引擎：每 30s 扫描到点的 Schedule，按 Profile 配置下发单任务或批量任务。
 * 规则类型（ScheduleSpec）：
 *   - interval：每 N 分钟
 *   - daily：每日 HH:MM（本地时间）
 */
import type { Schedule, ScheduleSpec } from '@shared/types';
import { listDueSchedules, upsertSchedule } from './db';

export function computeNextRun(spec: ScheduleSpec, from: Date = new Date()): string {
  if (spec.kind === 'interval') {
    return new Date(from.getTime() + Math.max(1, spec.everyMin) * 60_000).toISOString();
  }
  // daily：下一个本地 HH:MM
  const [hh, mm] = spec.hhmm.split(':').map((s) => parseInt(s, 10));
  const next = new Date(from);
  next.setHours(Number.isFinite(hh) ? hh : 9, Number.isFinite(mm) ? mm : 0, 0, 0);
  if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1);
  return next.toISOString();
}

export interface ScheduleDispatch {
  /** 按 schedule 的 Profile 配置下发任务 */
  dispatch(s: Schedule): void;
}

export function startScheduleRunner(dispatch: ScheduleDispatch['dispatch']): () => void {
  const tick = () => {
    const now = new Date();
    let due: Schedule[];
    try {
      due = listDueSchedules(now.toISOString());
    } catch (err) {
      console.error('[schedule] 扫描失败:', err);
      return;
    }
    for (const s of due) {
      try {
        dispatch(s);
        s.lastRunAt = now.toISOString();
      } catch (err) {
        console.error(`[schedule] 触发失败 ${s.name}:`, err);
      }
      s.nextRunAt = computeNextRun(s.spec, now);
      upsertSchedule(s);
      console.log(`[schedule] 已触发「${s.name}」，下次：${s.nextRunAt}`);
    }
  };

  const timer = setInterval(tick, 30_000);
  tick(); // 启动即检查一次（补发停机期间错过的？不补发，只推未来）
  return () => clearInterval(timer);
}
