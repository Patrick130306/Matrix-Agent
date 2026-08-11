import { useEffect, useMemo, useRef, useState } from 'react';
import type { Profile, ProfileGroup, Task, TaskStep, TaskTemplate } from '@shared/types';
import { matrix } from '../api';
import { Button, Card, CheckCircle, EmptyState, PageHeader, Segmented, StatusBadge, inputCls } from '../components/ui';
import { Icon } from '../components/icons';
import { promptDialog, toast } from '../components/feedback';

interface TaskRow extends Task {
  steps?: TaskStep[];
}

/** 主窗口：任务输入 + 执行日志（§12 / §13 基础 UI）。 */
export function Dashboard(props: { tasks: TaskRow[]; profiles: Profile[]; groups: ProfileGroup[]; refresh: () => void }) {
  // 任务列表与日志区联动：点击卡片 → 右侧显示完整历史
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const runningCount = props.tasks.filter((t) => t.status === 'running').length;

  return (
    <div>
      <PageHeader
        title="工作台"
        desc="用自然语言描述任务，Agent 会打开浏览器自主完成"
        extra={
          runningCount > 0 ? (
            <span className="inline-flex h-[26px] items-center gap-1.5 rounded-lg bg-info-soft px-2.5 text-[13px] font-medium text-info">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-info" />
              {runningCount} 个任务运行中
            </span>
          ) : undefined
        }
      />
      <div className="grid grid-cols-5 gap-6">
        <div className="col-span-2 space-y-6">
          <TaskComposer profiles={props.profiles} groups={props.groups} onCreated={props.refresh} />
          <ActiveTasks
            tasks={props.tasks}
            refresh={props.refresh}
            selectedId={selectedId}
            onSelect={(id) => setSelectedId(id)}
          />
        </div>
        <div className="col-span-3">
          <TaskLog tasks={props.tasks} selectedId={selectedId} onSelect={setSelectedId} />
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ 任务输入

function TaskComposer(props: { profiles: Profile[]; groups: ProfileGroup[]; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [requiresAuth, setRequiresAuth] = useState(true);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [batchMode, setBatchMode] = useState(false); // 多选 Profile 时：批量（各跑一遍）vs 协同（单任务切换）
  const [saveFlow, setSaveFlow] = useState(false); // 完成后把动作序列存为可回放流程
  const [templates, setTemplates] = useState<TaskTemplate[]>([]);

  useEffect(() => {
    void matrix.templates.list().then(setTemplates);
  }, []);

  const toggle = (id: string) =>
    setSelectedIds((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  /** 分组快捷选择：全选该组；已全选则取消该组 */
  const toggleGroup = (groupId: string) => {
    const memberIds = props.profiles.filter((p) => p.groupId === groupId).map((p) => p.id);
    if (memberIds.length === 0) return;
    setSelectedIds((s) =>
      memberIds.every((id) => s.includes(id))
        ? s.filter((id) => !memberIds.includes(id))
        : [...new Set([...s, ...memberIds])],
    );
  };

  const submit = async () => {
    if (!name.trim() || submitting) return;
    setSubmitting(true);
    try {
      if (batchMode && selectedIds.length > 1) {
        // 批量任务：一条指令 × N 个 Profile，结果自动汇总
        await matrix.tasks.createBatch({ name: name.trim(), requiresAuth, profileIds: selectedIds });
        toast.success(`已派发到 ${selectedIds.length} 个 Profile，结果自动汇总`);
      } else {
        await matrix.tasks.create({
          name: name.trim(),
          requiresAuth,
          // 勾选 1 个 = 指定；勾选多个 = Profile 池（Agent 可 switch_profile 切换）；不勾 = 自动分配
          profileId: selectedIds.length === 1 ? selectedIds[0] : undefined,
          profileIds: selectedIds.length > 1 ? selectedIds : undefined,
          // 流程复用：成功后把动作序列存为流程（批量任务不存，避免 N 份雷同流程）
          saveFlowAs: saveFlow && selectedIds.length <= 1 ? name.trim().slice(0, 30) : undefined,
        });
        toast.success('任务已提交，Agent 开始执行');
      }
      setName('');
      props.onCreated();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const saveAsTemplate = async () => {
    if (!name.trim()) return;
    const tplName = await promptDialog({
      title: '存为模板',
      defaultValue: name.trim().slice(0, 20),
      placeholder: '模板名称',
    });
    if (!tplName) return;
    try {
      await matrix.templates.create({ name: tplName, instruction: name.trim(), requiresAuth });
      setTemplates(await matrix.templates.list());
      toast.success('已存为模板，下次在输入区一键使用');
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  return (
    <Card className="p-5">
      <h2 className="mb-4 text-[15px] font-semibold text-slate-200">新任务</h2>
      <div className="space-y-4">
        {templates.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-slate-500">模板</span>
            {templates.slice(0, 6).map((t) => (
              <button
                key={t.id}
                className="h-[26px] rounded-lg bg-white/5 px-2 text-xs text-slate-400 transition-colors duration-150 hover:bg-white/10 hover:text-slate-200"
                title={t.instruction}
                onClick={() => {
                  setName(t.instruction);
                  setRequiresAuth(t.requiresAuth);
                }}
              >
                {t.name}
              </button>
            ))}
          </div>
        )}
        <textarea
          className={`${inputCls} h-28 resize-none`}
          placeholder={
            '用自然语言描述任务，例如：\n· 打开 bing，搜索 "AI Agent"，提取前 3 个标题\n· 多账号：先用「店铺A」查看订单，再切到「店铺B」查看订单，汇总给我'
          }
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit();
          }}
        />
        <div>
          <p className="mb-2 text-[13px] text-slate-400">
            Profile 池（勾选多个则 Agent 可在它们之间切换；不勾 = 自动分配）
          </p>
          {props.groups.length > 0 && (
            <div className="mb-2 flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-slate-500">按组快选</span>
              {props.groups.map((g) => {
                const memberIds = props.profiles.filter((p) => p.groupId === g.id).map((p) => p.id);
                const allOn = memberIds.length > 0 && memberIds.every((id) => selectedIds.includes(id));
                return (
                  <button
                    key={g.id}
                    className={`inline-flex h-[26px] items-center gap-1 rounded-lg px-2 text-xs transition-colors duration-150 ${
                      allOn
                        ? 'bg-accent-soft text-info'
                        : 'bg-white/5 text-slate-500 hover:bg-white/10 hover:text-slate-300'
                    }`}
                    title={`${memberIds.length} 个 Profile`}
                    onClick={() => toggleGroup(g.id)}
                  >
                    <Icon name="Folder" size={14} />
                    {g.name}（{memberIds.length}）
                  </button>
                );
              })}
            </div>
          )}
          <div className="flex flex-wrap gap-1.5">
            {props.profiles.map((p) => {
              const on = selectedIds.includes(p.id);
              return (
                <button
                  key={p.id}
                  className={`h-7 rounded-lg px-2.5 text-[13px] transition-colors duration-150 ${
                    on
                      ? 'bg-accent-soft text-info'
                      : 'bg-white/5 text-slate-400 hover:bg-white/10 hover:text-slate-200'
                  }`}
                  onClick={() => toggle(p.id)}
                >
                  {p.name}
                </button>
              );
            })}
            {props.profiles.length === 0 && <span className="text-xs text-slate-600">暂无 Profile</span>}
          </div>
        </div>
        <div
          className="flex cursor-pointer items-center gap-2 text-[13px] text-slate-400"
          onClick={() => setRequiresAuth(!requiresAuth)}
        >
          <CheckCircle size={16} checked={requiresAuth} />
          依赖登录态（勾选后重试时不换 Profile）
        </div>
        <div
          className="flex cursor-pointer items-center gap-2 text-[13px] text-slate-400"
          title="AI 探路成功后固化动作序列，之后在「自动化」页一键秒级回放（不调 LLM）"
          onClick={() => setSaveFlow(!saveFlow)}
        >
          <CheckCircle size={16} checked={saveFlow} />
          完成后存为流程（下次回放不调 LLM，页面改版自动接管修复）
        </div>
        {selectedIds.length > 1 && (
          <div className="flex items-center gap-3 rounded-[10px] bg-white/[0.04] px-3 py-2.5">
            <span className="text-xs text-slate-500">已选 {selectedIds.length} 个</span>
            <Segmented
              options={[
                { value: 'coop', label: '协同 · Agent 切换操作' },
                { value: 'batch', label: '批量 · 各跑一遍并汇总' },
              ]}
              value={batchMode ? 'batch' : 'coop'}
              onChange={(v) => setBatchMode(v === 'batch')}
            />
          </div>
        )}
        <div className="flex items-center gap-2 pt-1">
          <Button
            variant="primary"
            size="lg"
            leftIcon="Send_b"
            className="flex-1"
            onClick={() => void submit()}
            disabled={submitting || !name.trim()}
          >
            {submitting
              ? '提交中…'
              : batchMode && selectedIds.length > 1
                ? `批量执行（${selectedIds.length} 个 Profile）`
                : '开始执行（Ctrl+Enter）'}
          </Button>
          <Button variant="outline" leftIcon="Save" onClick={() => void saveAsTemplate()} disabled={!name.trim()} title="把当前指令存为模板">
            存为模板
          </Button>
        </div>
        {props.profiles.length === 0 && (
          <p className="flex items-center gap-1.5 text-[13px] text-warn">
            <Icon name="Warning" size={14} />
            还没有 Profile，请先到「Profile 管理」创建一个
          </p>
        )}
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------ 活动任务

function ActiveTasks(props: {
  tasks: TaskRow[];
  refresh: () => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [showFinished, setShowFinished] = useState(true);
  const active = props.tasks.filter((t) =>
    ['pending', 'running', 'paused', 'interrupted'].includes(t.status),
  );
  // 已结束的任务保留展示（执行完不消失），默认显示最近几条
  const finished = props.tasks.filter((t) => ['completed', 'failed'].includes(t.status));

  const renderRow = (t: TaskRow) => (
    <li
      key={t.id}
      onClick={() => props.onSelect(t.id)}
      className={`cursor-pointer rounded-[10px] p-3 transition-colors duration-150 ${
        props.selectedId === t.id ? 'bg-accent-soft' : 'bg-white/[0.03] hover:bg-white/[0.06]'
      }`}
      title="点击查看完整执行历史"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-sm text-slate-200">{t.name}</p>
        <StatusBadge status={t.status} />
      </div>
      {t.errorMessage && <p className="mt-1 truncate text-xs text-danger">{t.errorMessage}</p>}
      {t.status === 'completed' && t.result?.final && (
        <p className="mt-1 truncate text-xs text-ok/80">{t.result.final.slice(0, 80)}</p>
      )}
      <div className="mt-2.5 flex gap-1.5">
        {(t.status === 'running' || t.status === 'paused') && (
          <>
            <Button size="sm" leftIcon="Camera" onClick={() => void matrix.tasks.liveView(t.id).catch((e) => toast.error((e as Error).message))}>
              实时查看
            </Button>
            <Button size="sm" variant="danger" leftIcon="Stop" onClick={() => void matrix.tasks.cancel(t.id).then(props.refresh)}>
              终止
            </Button>
          </>
        )}
        {t.status === 'interrupted' && (
          <>
            <Button
              size="sm"
              variant="primary"
              leftIcon="Play"
              onClick={() => void matrix.tasks.resolveInterrupted(t.id, 'resume').then(props.refresh)}
            >
              恢复执行
            </Button>
            <Button
              size="sm"
              variant="danger"
              onClick={() => void matrix.tasks.resolveInterrupted(t.id, 'discard').then(props.refresh)}
            >
              放弃
            </Button>
          </>
        )}
        {t.status === 'pending' && (
          <Button size="sm" variant="danger" onClick={() => void matrix.tasks.cancel(t.id).then(props.refresh)}>
            取消排队
          </Button>
        )}
        {(t.status === 'completed' || t.status === 'failed') && (
          <Button size="sm" leftIcon="Refresh" onClick={() => void matrix.tasks.retry(t.id).then(props.refresh)}>
            重跑
          </Button>
        )}
      </div>
    </li>
  );

  return (
    <Card className="p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-[15px] font-semibold text-slate-200">
          任务列表
          <span className="ml-2 text-[13px] font-normal text-slate-500">{active.length} 个进行中</span>
        </h2>
        {finished.length > 0 && (
          <button
            className="text-[13px] text-slate-500 transition-colors hover:text-slate-300"
            onClick={() => setShowFinished((v) => !v)}
          >
            {showFinished ? '收起已结束' : `展开已结束（${finished.length}）`}
          </button>
        )}
      </div>
      {active.length === 0 && finished.length === 0 ? (
        <EmptyState icon="List" title="暂无任务" hint="在上方输入任务指令，Agent 会立即开始执行" />
      ) : (
        <ul className="space-y-2">
          {active.map(renderRow)}
          {showFinished && finished.slice(0, 10).map(renderRow)}
        </ul>
      )}
    </Card>
  );
}

// ------------------------------------------------------------------ 执行日志

function TaskLog(props: {
  tasks: TaskRow[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const running = props.tasks.find((t) => t.status === 'running' || t.status === 'paused');
  const [detail, setDetail] = useState<TaskRow | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // 优先显示用户在列表里点选的任务；否则跟随正在运行的任务
  const targetId = props.selectedId ?? running?.id ?? null;

  useEffect(() => {
    if (!targetId) {
      setDetail(null);
      return;
    }
    let alive = true;
    const load = () =>
      matrix.tasks.get(targetId).then((t) => {
        if (alive) setDetail(t as TaskRow | null);
      });
    void load();
    const timer = setInterval(load, 1500);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [targetId, props.tasks]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [detail?.steps?.length]);

  const candidates = useMemo(
    () => props.tasks.filter((t) => t.status !== 'pending').slice(0, 20),
    [props.tasks],
  );

  return (
    <Card className="flex h-[calc(100vh-9rem)] flex-col p-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="shrink-0 text-[15px] font-semibold text-slate-200">执行日志</h2>
        <select
          className={`${inputCls} !w-64 !py-1.5 text-xs`}
          value={targetId ?? ''}
          onChange={(e) => props.onSelect(e.target.value || null)}
        >
          <option value="">选择任务…</option>
          {candidates.map((t) => (
            <option key={t.id} value={t.id}>
              [{t.status}] {t.name.slice(0, 30)}
            </option>
          ))}
        </select>
      </div>

      {!detail && (
        <EmptyState
          icon="Robot"
          title="暂无运行中的任务"
          hint="从右上角选择历史任务，可回看完整的执行步骤与结果"
        />
      )}

      {detail && (
        <>
          <div className="mb-3 flex items-center gap-2">
            <StatusBadge status={detail.status} />
            <span className="truncate text-[13px] text-slate-400">{detail.name}</span>
            <span className="ml-auto shrink-0 text-xs text-slate-500">
              {detail.steps?.length ?? 0} / {detail.maxSteps} 步
            </span>
          </div>
          <div className="flex-1 space-y-1.5 overflow-auto rounded-[10px] bg-black/30 p-3 font-mono text-xs leading-5">
            {(detail.steps ?? []).map((s) => (
              <div key={s.id} className="flex gap-2">
                <span className="shrink-0 text-slate-600">#{s.seq}</span>
                <span className={`shrink-0 ${s.success ? 'text-ok' : 'text-danger'}`}>{s.success ? '✓' : '✗'}</span>
                <span className="text-slate-300">
                  <span className="text-slate-500">[{s.type}]</span> {s.description}
                  {s.errorMessage && <span className="text-danger"> — {s.errorMessage}</span>}
                </span>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>
          {detail.result?.final && (
            <div className="mt-3 rounded-[10px] bg-ok-soft p-3">
              <p className="mb-1 text-xs font-semibold text-ok">任务结果</p>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap text-xs leading-5 text-slate-200">{detail.result.final}</pre>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
