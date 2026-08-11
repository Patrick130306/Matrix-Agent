import { useEffect, useMemo, useState } from 'react';
import type { Profile, Task, TaskStep } from '@shared/types';
import { matrix } from '../api';
import { Button, Card, EmptyState, Modal, PageHeader, StatusBadge, inputCls } from '../components/ui';
import { Icon } from '../components/icons';

interface TaskRow extends Task {
  steps?: TaskStep[];
}

/** 任务历史：全量列表 + 详情抽屉（步骤 / 结果 / 快照查看）+ 按 Profile / 状态 / 关键词筛选。 */
export function TasksPage(props: { tasks: TaskRow[]; profiles: Profile[]; refresh: () => void }) {
  const [detail, setDetail] = useState<TaskRow | null>(null);
  const [snapshot, setSnapshot] = useState<{ file: string; content: string } | null>(null);
  const [keyword, setKeyword] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [profileFilter, setProfileFilter] = useState('');

  const openDetail = async (id: string) => {
    const t = await matrix.tasks.get(id);
    setDetail(t as TaskRow | null);
  };

  const openSnapshot = async (file: string) => {
    const content = await matrix.tasks.readSnapshot(file);
    setSnapshot({ file, content });
  };

  const profileName = (id?: string) => props.profiles.find((p) => p.id === id)?.name ?? '—';

  const filtered = useMemo(
    () =>
      props.tasks.filter((t) => {
        if (t.parentId) return false; // 批量子任务折叠进父任务详情，主列表不展示
        if (keyword && !t.name.toLowerCase().includes(keyword.toLowerCase())) return false;
        if (statusFilter && t.status !== statusFilter) return false;
        if (profileFilter) {
          const hit = t.profileId === profileFilter || t.profileIds?.includes(profileFilter);
          if (!hit) return false;
        }
        return true;
      }),
    [props.tasks, keyword, statusFilter, profileFilter],
  );

  /** 导出筛选结果为 CSV（Excel 可直接打开） */
  const exportCsv = () => {
    const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const rows = [
      ['任务', '类型', 'Profile', '状态', '步数', '结果摘要', '创建时间', '完成时间'].join(','),
      ...filtered.map((t) =>
        [
          esc(t.name),
          t.type === 'batch' ? '批量' : '单任务',
          esc(profileName(t.profileId)),
          t.status,
          String(t.steps?.length ?? 0),
          esc((t.result?.final ?? t.errorMessage ?? '').slice(0, 300).replace(/\s+/g, ' ')),
          t.createdAt,
          t.completedAt ?? '',
        ].join(','),
      ),
    ];
    const blob = new Blob(['﻿' + rows.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `matrix-tasks-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div>
      <PageHeader
        title="任务历史"
        desc={`共 ${props.tasks.length} 条记录，当前筛选出 ${filtered.length} 条`}
        extra={
          <Button variant="outline" leftIcon="Download" onClick={exportCsv} disabled={filtered.length === 0}>
            导出 CSV
          </Button>
        }
      />

      {/* 筛选工具行 */}
      <div className="mb-4 flex items-center gap-2">
        <div className="relative w-64">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500">
            <Icon name="Search" size={16} />
          </span>
          <input
            className={`${inputCls} !py-2 pl-9 text-[13px]`}
            placeholder="搜索任务关键词…"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
        </div>
        <select
          className={`${inputCls} !w-auto !py-2 text-[13px]`}
          value={profileFilter}
          onChange={(e) => setProfileFilter(e.target.value)}
        >
          <option value="">全部 Profile</option>
          {props.profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <select
          className={`${inputCls} !w-auto !py-2 text-[13px]`}
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
        >
          <option value="">全部状态</option>
          <option value="running">运行中</option>
          <option value="paused">等待人工</option>
          <option value="interrupted">已中断</option>
          <option value="completed">已完成</option>
          <option value="failed">失败</option>
        </select>
      </div>

      <Card>
        <table className="w-full">
          <thead>
            <tr className="border-b border-ink-600 text-left">
              <th className="px-4 py-3 text-xs font-medium text-slate-500">任务</th>
              <th className="px-4 py-3 text-xs font-medium text-slate-500">Profile</th>
              <th className="px-4 py-3 text-xs font-medium text-slate-500">状态</th>
              <th className="px-4 py-3 text-xs font-medium text-slate-500">步数</th>
              <th className="px-4 py-3 text-xs font-medium text-slate-500">创建时间</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-slate-500">操作</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((t) => (
              <tr key={t.id} className="border-b border-white/5 transition-colors last:border-0 hover:bg-white/[0.03]">
                <td className="max-w-md truncate px-4 py-3 text-sm text-slate-200">
                  {t.type === 'batch' && (
                    <span className="mr-1.5 rounded bg-info-soft px-1.5 py-0.5 text-[11px] font-medium text-info">
                      批量
                    </span>
                  )}
                  {t.flowId && (
                    <span className="mr-1.5 rounded bg-warn-soft px-1.5 py-0.5 text-[11px] font-medium text-warn">
                      流程
                    </span>
                  )}
                  {t.collectFields?.length ? (
                    <span className="mr-1.5 rounded bg-ok-soft px-1.5 py-0.5 text-[11px] font-medium text-ok">
                      采集
                    </span>
                  ) : null}
                  {t.name}
                </td>
                <td className="px-4 py-3 text-[13px] text-slate-400">{profileName(t.profileId)}</td>
                <td className="px-4 py-3">
                  <StatusBadge status={t.status} />
                </td>
                <td className="px-4 py-3 text-[13px] text-slate-400">
                  {t.steps?.length ?? '—'} / {t.maxSteps}
                </td>
                <td className="px-4 py-3 text-[13px] text-slate-400">{new Date(t.createdAt).toLocaleString()}</td>
                <td className="px-4 py-3">
                  <div className="flex justify-end gap-1.5">
                    <Button size="sm" onClick={() => void openDetail(t.id)}>详情</Button>
                    {(t.status === 'failed' || t.status === 'completed') && (
                      <Button size="sm" variant="outline" leftIcon="Refresh" onClick={() => void matrix.tasks.retry(t.id).then(props.refresh)}>
                        重跑
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={6}>
                  <EmptyState
                    icon="List"
                    title={props.tasks.length === 0 ? '暂无任务记录' : '没有符合筛选条件的任务'}
                    hint={props.tasks.length === 0 ? '到「工作台」提交你的第一个任务' : '试试调整关键词或筛选条件'}
                  />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>

      {detail && (
        <Modal title="任务详情" onClose={() => setDetail(null)} wide>
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <StatusBadge status={detail.status} />
              <span className="text-sm text-slate-200">{detail.name}</span>
            </div>
            {detail.errorMessage && (
              <p className="rounded-[10px] bg-danger-soft p-3 text-[13px] text-danger">{detail.errorMessage}</p>
            )}
            <div className="max-h-80 space-y-1.5 overflow-auto rounded-[10px] bg-black/30 p-3 font-mono text-xs leading-5">
              {(detail.steps ?? []).map((s) => (
                <div key={s.id} className="flex items-start gap-2">
                  <span className="shrink-0 text-slate-600">#{s.seq}</span>
                  <span className={`shrink-0 ${s.success ? 'text-ok' : 'text-danger'}`}>{s.success ? '✓' : '✗'}</span>
                  <span className="text-slate-300">
                    <span className="text-slate-500">[{s.type}]</span> {s.description}
                  </span>
                  {s.snapshotFile && (
                    <button
                      className="ml-auto inline-flex shrink-0 items-center gap-1 text-info hover:underline"
                      onClick={() => void openSnapshot(s.snapshotFile!)}
                    >
                      <Icon name="Document" size={14} />
                      快照
                    </button>
                  )}
                  {s.screenshotFile && <StepShot file={s.screenshotFile} />}
                </div>
              ))}
              {(detail.steps ?? []).length === 0 && <p className="text-slate-500">暂无步骤记录</p>}
            </div>
            {detail.type === 'batch' && (
              <div className="space-y-1.5">
                <p className="text-[13px] font-medium text-slate-300">子任务明细</p>
                {props.tasks
                  .filter((c) => c.parentId === detail.id)
                  .map((c) => (
                    <div key={c.id} className="flex items-center gap-2 rounded-[10px] bg-white/[0.04] px-3 py-2 text-xs">
                      <StatusBadge status={c.status} />
                      <span className="text-slate-300">{profileName(c.profileId)}</span>
                      <span className="truncate text-slate-500">
                        {c.result?.final?.slice(0, 60) ?? c.errorMessage ?? ''}
                      </span>
                    </div>
                  ))}
              </div>
            )}
            {detail.result?.final && <CollectResultView final={detail.result.final} />}
            {detail.result && detail.result.fragments.length > 0 && (
              <details className="rounded-[10px] border border-ink-600 p-3 text-xs">
                <summary className="cursor-pointer text-slate-400">
                  提取的原始片段（{detail.result.fragments.length}）
                </summary>
                <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap leading-5 text-slate-400">
                  {detail.result.fragments.join('\n\n---\n\n')}
                </pre>
              </details>
            )}
          </div>
        </Modal>
      )}

      {snapshot && (
        <Modal title="页面快照" onClose={() => setSnapshot(null)} wide>
          <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-[10px] bg-black/30 p-3 font-mono text-xs leading-5 text-slate-300">
            {snapshot.content}
          </pre>
        </Modal>
      )}
    </div>
  );
}

/** 步骤截图：懒加载缩略按钮，点击展开大图（再点收起） */
function StepShot(props: { file: string }) {
  const [img, setImg] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  const toggle = async () => {
    if (open) {
      setOpen(false);
      return;
    }
    if (!img) {
      setLoading(true);
      try {
        setImg(await matrix.tasks.readScreenshot(props.file));
      } finally {
        setLoading(false);
      }
    }
    setOpen(true);
  };

  return (
    <span className="shrink-0">
      <button className="inline-flex items-center gap-1 text-info hover:underline" onClick={() => void toggle()}>
        <Icon name="Camera" size={14} />
        {loading ? '…' : open ? '收起截图' : '截图'}
      </button>
      {open && img && (
        <div className="mt-1">
          <img src={img} alt="步骤截图" className="max-h-72 rounded-[10px] border border-ink-600" />
        </div>
      )}
      {open && !img && !loading && <span className="ml-1 text-slate-600">（截图文件缺失）</span>}
    </span>
  );
}

/**
 * 任务结果渲染：采集任务的 final 是 JSON 对象数组 → 渲染为表格 + 导出 CSV；
 * 普通任务按原文本展示。
 */
function CollectResultView(props: { final: string }) {
  const rows = useMemo(() => {
    try {
      const parsed = JSON.parse(props.final) as unknown;
      if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((r) => r && typeof r === 'object' && !Array.isArray(r))) {
        return parsed as Record<string, unknown>[];
      }
    } catch {
      /* 非 JSON，按文本展示 */
    }
    return null;
  }, [props.final]);

  if (!rows) {
    return (
      <div className="rounded-[10px] bg-ok-soft p-4">
        <p className="mb-1.5 text-[13px] font-semibold text-ok">任务结果</p>
        <pre className="max-h-60 overflow-auto whitespace-pre-wrap text-xs leading-5 text-slate-200">{props.final}</pre>
      </div>
    );
  }

  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))].slice(0, 8);

  const exportRows = () => {
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = [columns.map(esc).join(','), ...rows.map((r) => columns.map((c) => esc(r[c])).join(','))].join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `collect-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="rounded-[10px] bg-ok-soft p-4">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-[13px] font-semibold text-ok">采集结果（{rows.length} 行 × {columns.length} 列）</p>
        <Button size="sm" variant="outline" leftIcon="Download" onClick={exportRows}>
          导出 CSV
        </Button>
      </div>
      <div className="max-h-72 overflow-auto rounded-lg">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-white/10 text-left">
              {columns.map((c) => (
                <th key={c} className="px-2 py-1.5 font-medium text-slate-400">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-b border-white/5 last:border-0">
                {columns.map((c) => (
                  <td key={c} className="max-w-52 truncate px-2 py-1.5 text-slate-300" title={String(r[c] ?? '')}>
                    {String(r[c] ?? '')}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
