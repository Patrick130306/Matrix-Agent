import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { ExtractTemplate, Flow, FlowStep, Profile, Schedule, ScheduleInput, TaskTemplate } from '@shared/types';
import { matrix } from '../api';
import { Button, Card, CheckCircle, EmptyState, Field, IconButton, Modal, PageHeader, Toggle, inputCls } from '../components/ui';
import { confirmDialog, promptDialog, toast } from '../components/feedback';

/** 自动化页：定时任务 + 流程复用（秒级回放 / 可视化编辑）+ 结构化采集 + 任务模板。 */
export function AutomationPage(props: { profiles: Profile[] }) {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [templates, setTemplates] = useState<TaskTemplate[]>([]);
  const [flows, setFlows] = useState<Flow[]>([]);
  const [editing, setEditing] = useState(false);
  const [runFlowFor, setRunFlowFor] = useState<Flow | null>(null);
  const [editFlowFor, setEditFlowFor] = useState<Flow | null>(null);
  const [collectOpen, setCollectOpen] = useState(false);

  const refresh = useCallback(() => {
    void matrix.schedules.list().then(setSchedules);
    void matrix.templates.list().then(setTemplates);
    void matrix.flows.list().then(setFlows);
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 10_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const profileName = (id: string) => props.profiles.find((p) => p.id === id)?.name ?? '?';

  const deleteSchedule = async (s: Schedule) => {
    const ok = await confirmDialog({ title: `删除定时任务「${s.name}」？`, danger: true, confirmText: '删除' });
    if (ok) void matrix.schedules.delete(s.id).then(refresh);
  };

  const deleteFlow = async (f: Flow) => {
    const ok = await confirmDialog({ title: `删除流程「${f.name}」？`, danger: true, confirmText: '删除' });
    if (ok) void matrix.flows.delete(f.id).then(refresh);
  };

  const deleteTemplate = async (t: TaskTemplate) => {
    const ok = await confirmDialog({ title: `删除模板「${t.name}」？`, danger: true, confirmText: '删除' });
    if (ok) void matrix.templates.delete(t.id).then(refresh);
  };

  return (
    <div>
      <PageHeader title="自动化" desc="定时任务 · 流程复用 · 结构化采集 · 任务模板——让 Agent 按你的节奏持续工作" />

      <div className="space-y-8">
        {/* ---------------- 定时任务 ---------------- */}
        <section>
          <SectionHeader
            title="定时任务"
            count={schedules.length}
            action={
              <Button variant="primary" size="sm" leftIcon="Add" onClick={() => setEditing(true)}>
                新建定时任务
              </Button>
            }
          />
          <Card>
            <table className="w-full">
              <thead>
                <tr className="border-b border-ink-600 text-left">
                  <th className="px-4 py-3 text-xs font-medium text-slate-500">名称</th>
                  <th className="px-4 py-3 text-xs font-medium text-slate-500">规则</th>
                  <th className="px-4 py-3 text-xs font-medium text-slate-500">Profile</th>
                  <th className="px-4 py-3 text-xs font-medium text-slate-500">上次运行</th>
                  <th className="px-4 py-3 text-xs font-medium text-slate-500">下次运行</th>
                  <th className="px-4 py-3 text-xs font-medium text-slate-500">启用</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-slate-500">操作</th>
                </tr>
              </thead>
              <tbody>
                {schedules.map((s) => (
                  <tr key={s.id} className="border-b border-[var(--line-1)] transition-colors last:border-0 hover:bg-[var(--fill-0)]">
                    <td className="max-w-52 truncate px-4 py-3 text-sm text-slate-200" title={s.instruction}>
                      {s.name}
                    </td>
                    <td className="px-4 py-3 text-[13px] text-slate-400">
                      {s.spec.kind === 'interval'
                        ? `每 ${s.spec.everyMin} 分钟`
                        : s.spec.kind === 'daily'
                          ? `每日 ${s.spec.hhmm}`
                          : <code className="font-mono">{s.spec.expr}</code>}
                      {s.enabled && s.nextRunAt && new Date(s.nextRunAt).getTime() < Date.now() - 2 * 60_000 && (
                        <span className="ml-1.5 rounded bg-warn-soft px-1.5 py-0.5 text-[11px] text-warn" title="预定时间已过（可能因关机错过），下次启动会自动补跑一次">
                          待补跑
                        </span>
                      )}
                    </td>
                    <td className="max-w-40 truncate px-4 py-3 text-[13px] text-slate-400">
                      {s.profileIds.length > 0 ? s.profileIds.map(profileName).join('、') : '自动分配'}
                      {s.profileIds.length > 1 && <span className="ml-1 text-info">(批量)</span>}
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-500">
                      {s.lastRunAt ? new Date(s.lastRunAt).toLocaleString() : '—'}
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-400">
                      {s.enabled && s.nextRunAt ? new Date(s.nextRunAt).toLocaleString() : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <Toggle size="sm" checked={s.enabled} onChange={(v) => void matrix.schedules.toggle(s.id, v).then(refresh)} />
                    </td>
                    <td className="px-4 py-3 text-right">
                      <IconButton name="Delete" title="删除" danger onClick={() => void deleteSchedule(s)} />
                    </td>
                  </tr>
                ))}
                {schedules.length === 0 && (
                  <tr>
                    <td colSpan={7}>
                      <EmptyState
                        icon="History"
                        title="还没有定时任务"
                        hint="比如：每日 9 点巡检所有店铺订单（选多个 Profile 自动批量执行）"
                      />
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </Card>
        </section>

        {/* ---------------- 流程复用 ---------------- */}
        <section>
          <SectionHeader
            title="流程复用"
            count={flows.length}
            hint="AI 探路一次 → 之后秒级回放，不调 LLM；页面改版自动接管修复"
          />
          <div className="grid grid-cols-2 gap-4">
            {flows.map((f) => (
              <Card key={f.id} className="p-4">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm font-medium text-slate-200">{f.name}</p>
                  <div className="flex items-center gap-1.5">
                    <Button size="sm" variant="primary" leftIcon="Play" onClick={() => setRunFlowFor(f)}>
                      回放
                    </Button>
                    <Button size="sm" variant="outline" leftIcon="Edit" onClick={() => setEditFlowFor(f)}>
                      编辑
                    </Button>
                    <IconButton name="Delete" title="删除流程" danger onClick={() => void deleteFlow(f)} />
                  </div>
                </div>
                <p className="mt-2 line-clamp-2 whitespace-pre-wrap text-[13px] leading-5 text-slate-400" title={f.instruction}>
                  {f.instruction}
                </p>
                <p className="mt-2.5 text-xs text-slate-500">
                  {f.steps.length} 步 · 已回放 {f.runCount} 次
                  {f.lastStatus && (
                    <span className={f.lastStatus === 'completed' ? 'text-ok' : 'text-danger'}>
                      {' '}· 上次{f.lastStatus === 'completed' ? '成功' : '失败'}
                    </span>
                  )}
                  {f.lastRunAt ? ` · ${new Date(f.lastRunAt).toLocaleString()}` : ''}
                </p>
              </Card>
            ))}
            {flows.length === 0 && (
              <Card className="col-span-2">
                <EmptyState
                  icon="Play"
                  title="暂无流程"
                  hint="在工作台下发任务时勾选「完成后存为流程」，成功后即可在这里一键回放"
                />
              </Card>
            )}
          </div>
        </section>

        {/* ---------------- 结构化采集 ---------------- */}
        <section>
          <SectionHeader
            title="结构化采集"
            action={
              <Button variant="primary" size="sm" leftIcon="Add" onClick={() => setCollectOpen(true)}>
                新建采集任务
              </Button>
            }
          />
          <Card className="p-4 text-[13px] leading-6 text-slate-400">
            定义要采的字段（如：标题、价格、销量），Agent 自动翻页采集并合并成表格；
            完成后到「任务历史 → 详情」查看表格并导出 CSV。配合「定时任务」即为竞品日报。
          </Card>
        </section>

        {/* ---------------- 任务模板 ---------------- */}
        <section>
          <SectionHeader title="任务模板" count={templates.length} />
          <div className="grid grid-cols-2 gap-4">
            {templates.map((t) => (
              <Card key={t.id} className="p-4">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm font-medium text-slate-200">{t.name}</p>
                  <IconButton name="Delete" title="删除模板" danger onClick={() => void deleteTemplate(t)} />
                </div>
                <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-[13px] leading-5 text-slate-400">{t.instruction}</p>
                <p className="mt-2.5 text-xs text-slate-500">
                  {t.requiresAuth ? '依赖登录态' : '匿名任务'} · 到工作台一键使用
                </p>
              </Card>
            ))}
            {templates.length === 0 && (
              <Card className="col-span-2">
                <EmptyState
                  icon="Document"
                  title="暂无模板"
                  hint="在工作台写好指令后点「存为模板」，以后一键下发"
                />
              </Card>
            )}
          </div>
        </section>
      </div>

      {editing && (
        <ScheduleForm
          profiles={props.profiles}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            refresh();
          }}
        />
      )}

      {runFlowFor && (
        <FlowRunModal
          flow={runFlowFor}
          profiles={props.profiles}
          onClose={() => setRunFlowFor(null)}
        />
      )}

      {editFlowFor && (
        <FlowEditModal
          flow={editFlowFor}
          onClose={() => setEditFlowFor(null)}
          onSaved={(f) => {
            setEditFlowFor(null);
            refresh();
          }}
        />
      )}

      {collectOpen && (
        <CollectorModal profiles={props.profiles} onClose={() => setCollectOpen(false)} />
      )}
    </div>
  );
}

// ------------------------------------------------------------------ 区块标题

function SectionHeader(props: { title: string; count?: number; hint?: string; action?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <h2 className="flex items-baseline gap-2 text-[15px] font-semibold text-slate-200">
        {props.title}
        {props.count !== undefined && <span className="text-[13px] font-normal text-slate-500">{props.count}</span>}
        {props.hint && <span className="text-xs font-normal text-slate-500">{props.hint}</span>}
      </h2>
      {props.action}
    </div>
  );
}

// ------------------------------------------------------------------ 流程回放

function FlowRunModal(props: { flow: Flow; profiles: Profile[]; onClose: () => void }) {
  const [profileId, setProfileId] = useState(props.profiles[0]?.id ?? '');
  const [running, setRunning] = useState(false);

  const run = async () => {
    if (!profileId) {
      toast.error('请选择 Profile');
      return;
    }
    setRunning(true);
    try {
      await matrix.flows.run(props.flow.id, profileId);
      props.onClose();
      toast.success(`流程「${props.flow.name}」已开始回放，到工作台查看实时进度`);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setRunning(false);
    }
  };

  return (
    <Modal
      title={`回放流程：${props.flow.name}`}
      onClose={props.onClose}
      footer={
        <>
          <Button onClick={props.onClose}>取消</Button>
          <Button variant="primary" leftIcon="Play" disabled={running || !profileId} onClick={() => void run()}>
            {running ? '启动中…' : '开始回放'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="max-h-40 space-y-1 overflow-auto rounded-[10px] bg-[var(--mask-strong)] p-3 font-mono text-xs leading-5 text-slate-400">
          {props.flow.steps.map((s, i) => (
            <p key={i}>
              <span className="text-slate-600">#{i + 1}</span> {s.note ?? s.action.type}
            </p>
          ))}
        </div>
        <Field label="在哪个 Profile 上回放">
          <select className={inputCls} value={profileId} onChange={(e) => setProfileId(e.target.value)}>
            {props.profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ 流程可视化编辑

/** 流程编辑器：查看/删除/调序/改参数（navigate url / type text / select value / wait ms） */
function FlowEditModal(props: { flow: Flow; onClose: () => void; onSaved: (f: Flow) => void }) {
  const [name, setName] = useState(props.flow.name);
  const [steps, setSteps] = useState<FlowStep[]>(() => props.flow.steps.map((s) => ({ ...s, action: { ...s.action } })));
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editValue, setEditValue] = useState('');
  const [saving, setSaving] = useState(false);

  const move = (idx: number, dir: -1 | 1) => {
    setSteps((s) => {
      const next = [...s];
      const j = idx + dir;
      if (j < 0 || j >= next.length) return s;
      [next[idx], next[j]] = [next[j], next[idx]];
      return next;
    });
  };

  const remove = (idx: number) => {
    setSteps((s) => s.filter((_, i) => i !== idx));
    setEditingIdx(null);
  };

  /** 获取某步可编辑的参数字段（返回字段名 + 当前值） */
  const editableField = (s: FlowStep): { key: string; value: string } | null => {
    switch (s.action.type) {
      case 'navigate':
        return { key: 'url', value: s.action.url };
      case 'type':
        return { key: 'text', value: s.action.text };
      case 'select':
        return { key: 'value', value: s.action.value };
      case 'wait':
        return { key: 'ms', value: String(s.action.ms) };
      default:
        return null;
    }
  };

  const startEdit = (idx: number) => {
    const f = editableField(steps[idx]);
    if (!f) return;
    setEditingIdx(idx);
    setEditValue(f.value);
  };

  const commitEdit = () => {
    if (editingIdx === null) return;
    setSteps((s) => {
      const next = [...s];
      const step = { ...next[editingIdx], action: { ...next[editingIdx].action } };
      switch (step.action.type) {
        case 'navigate':
          step.action = { ...step.action, url: editValue.trim() };
          break;
        case 'type':
          step.action = { ...step.action, text: editValue };
          break;
        case 'select':
          step.action = { ...step.action, value: editValue };
          break;
        case 'wait':
          step.action = { ...step.action, ms: Math.max(0, Number(editValue) || 0) };
          break;
      }
      next[editingIdx] = step;
      return next;
    });
    setEditingIdx(null);
  };

  const save = async () => {
    if (steps.length === 0) {
      toast.error('流程至少保留一步');
      return;
    }
    setSaving(true);
    try {
      const f = await matrix.flows.update(props.flow.id, { name: name.trim() || props.flow.name, steps });
      toast.success(`流程「${f.name}」已保存`);
      props.onSaved(f);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const actionDesc = (s: FlowStep): string => {
    switch (s.action.type) {
      case 'navigate':
        return s.action.url;
      case 'click':
        return `点击元素`;
      case 'type':
        return `输入「${s.action.text.slice(0, 40)}」`;
      case 'select':
        return `选择「${s.action.value}」`;
      case 'scroll':
        return `滚动（${s.action.direction}）`;
      case 'extract':
        return `采集：${s.action.note}`;
      case 'wait':
        return `等待 ${s.action.ms}ms`;
      default:
        return s.action.type;
    }
  };

  const typeLabel = (t: string) => {
    const map: Record<string, string> = {
      navigate: '导航',
      click: '点击',
      type: '输入',
      select: '选择',
      scroll: '滚动',
      extract: '采集',
      wait: '等待',
    };
    return map[t] ?? t;
  };

  return (
    <Modal
      title={`编辑流程：${props.flow.name}`}
      onClose={props.onClose}
      wide
      footer={
        <>
          <Button onClick={props.onClose}>取消</Button>
          <Button variant="primary" leftIcon="Save" disabled={saving} onClick={() => void save()}>
            {saving ? '保存中…' : '保存'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="流程名称">
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div>
          <p className="mb-2 text-[13px] text-slate-400">
            共 {steps.length} 步 · 点击「编辑」可改参数，拖到合适顺序后保存
          </p>
          <div className="max-h-96 space-y-1.5 overflow-auto rounded-[10px] bg-[var(--mask-strong)] p-3">
            {steps.map((s, i) => {
              const f = editableField(s);
              return (
                <div key={i} className="rounded-[10px] bg-[var(--fill-1)] px-3 py-2.5">
                  <div className="flex items-center gap-2">
                    <span className="shrink-0 font-mono text-xs text-slate-600">#{i + 1}</span>
                    <span className="shrink-0 rounded bg-info-soft px-1.5 py-0.5 text-[11px] font-medium text-info">
                      {typeLabel(s.action.type)}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[13px] text-slate-300" title={s.note}>
                      {s.note ?? actionDesc(s)}
                    </span>
                    <div className="flex shrink-0 items-center gap-0.5">
                      {f && editingIdx !== i && (
                        <Button size="sm" variant="outline" onClick={() => startEdit(i)}>
                          编辑
                        </Button>
                      )}
                      <IconButton name="Up" title="上移" onClick={() => move(i, -1)} disabled={i === 0} />
                      <IconButton name="Down" title="下移" onClick={() => move(i, 1)} disabled={i === steps.length - 1} />
                      <IconButton name="Delete" title="删除此步" danger onClick={() => void remove(i)} />
                    </div>
                  </div>
                  {f && editingIdx === i && (
                    <div className="mt-2 flex items-center gap-2">
                      <input
                        className={`${inputCls} !py-1.5 font-mono text-xs`}
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        autoFocus
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitEdit();
                          if (e.key === 'Escape') setEditingIdx(null);
                        }}
                      />
                      <Button size="sm" variant="primary" onClick={commitEdit}>
                        确定
                      </Button>
                      <Button size="sm" onClick={() => setEditingIdx(null)}>
                        取消
                      </Button>
                    </div>
                  )}
                </div>
              );
            })}
            {steps.length === 0 && (
              <p className="py-6 text-center text-xs text-slate-500">流程已为空（至少保留一步才能保存）</p>
            )}
          </div>
        </div>
        <p className="text-xs leading-4 text-slate-500">
          提示：删除会永久移除该步骤；调序会改变执行顺序。保存后回放按新顺序执行。
        </p>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ 结构化采集

function CollectorModal(props: { profiles: Profile[]; onClose: () => void }) {
  const [templates, setTemplates] = useState<ExtractTemplate[]>([]);
  const [url, setUrl] = useState('');
  const [fields, setFields] = useState('');
  const [extra, setExtra] = useState('');
  const [maxPages, setMaxPages] = useState(3);
  const [profileId, setProfileId] = useState(props.profiles[0]?.id ?? '');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    void matrix.extractTemplates.list().then(setTemplates);
  }, []);

  /** 套用模板：填充字段 + 附加指令 */
  const applyTemplate = (t: ExtractTemplate) => {
    setFields(t.fields.join('、'));
    setExtra(t.instruction);
  };

  const saveAsTemplate = async () => {
    const fieldList = fields.split(/[,，、]/).map((s) => s.trim()).filter(Boolean);
    if (fieldList.length === 0) {
      toast.error('先填采集字段再存模板');
      return;
    }
    const name = await promptDialog({ title: '存为采集模板', defaultValue: fieldList.join('/').slice(0, 20), placeholder: '模板名称' });
    if (!name) return;
    try {
      await matrix.extractTemplates.create({ name, category: '自定义', fields: fieldList, instruction: extra });
      setTemplates(await matrix.extractTemplates.list());
      toast.success('模板已保存，下次一键套用');
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const submit = async () => {
    const fieldList = fields.split(/[,，、]/).map((s) => s.trim()).filter(Boolean);
    if (!url.trim() || fieldList.length === 0) {
      toast.error('请填写起始页 URL 和采集字段');
      return;
    }
    setSubmitting(true);
    try {
      const instruction = [
        `结构化采集任务。`,
        `1. 先 navigate 到起始页：${url.trim()}（必须带协议）`,
        `2. 用 extract 收集当前页面的列表数据：把每个条目整理为 JSON 对象，字段为【${fieldList.join('、')}】，多个条目组成 JSON 数组，note 写「ROWS 第N页」`,
        `3. ${extra.trim() || '找到并点击「下一页」继续采集'};没有下一页或已采 ${maxPages} 页则结束`,
        `4. 最后用 done 交付，result 写「共采集 N 条」（系统会自动合并各页数据为表格）`,
      ].join('\n');
      await matrix.tasks.create({
        name: instruction,
        requiresAuth: true,
        profileId: profileId || undefined,
        collectFields: fieldList,
      });
      props.onClose();
      toast.success('采集任务已开始，完成后到「任务历史 → 详情」查看表格并导出 CSV');
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title="新建结构化采集任务"
      onClose={props.onClose}
      wide
      footer={
        <>
          <Button variant="outline" leftIcon="Save" onClick={() => void saveAsTemplate()}>存为模板</Button>
          <Button onClick={props.onClose}>取消</Button>
          <Button variant="primary" disabled={submitting} onClick={() => void submit()}>
            {submitting ? '提交中…' : '开始采集'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="套用模板（预置 + 自定义，选中即填充下方字段）">
          <select
            className={inputCls}
            value=""
            onChange={(e) => {
              const t = templates.find((x) => x.id === e.target.value);
              if (t) applyTemplate(t);
            }}
          >
            <option value="">选择模板…</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.category} · {t.name}（{t.fields.join('/')}）
              </option>
            ))}
          </select>
        </Field>
        <Field label="起始页 URL（列表页）">
          <input className={inputCls} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://shop.example.com/products" />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="采集字段（逗号分隔）" hint="例如：标题、价格、销量">
            <input className={inputCls} value={fields} onChange={(e) => setFields(e.target.value)} placeholder="标题, 价格, 销量" />
          </Field>
          <Field label="最多翻页数">
            <input type="number" min={1} max={20} className={inputCls} value={maxPages} onChange={(e) => setMaxPages(Math.max(1, Number(e.target.value)))} />
          </Field>
        </div>
        <Field label="采集规则（翻页/筛选策略，可选）" hint="例如：只采销量 > 100 的商品；翻页按钮是「下一页」">
          <textarea className={`${inputCls} h-16 resize-none`} value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="按列表页逐条整理，翻页直到没有下一页" />
        </Field>
        <Field label="使用 Profile">
          <select className={inputCls} value={profileId} onChange={(e) => setProfileId(e.target.value)}>
            {props.profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ 新建定时任务

function ScheduleForm(props: { profiles: Profile[]; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState('');
  const [instruction, setInstruction] = useState('');
  const [requiresAuth, setRequiresAuth] = useState(true);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [kind, setKind] = useState<'interval' | 'daily' | 'cron'>('daily');
  const [everyMin, setEveryMin] = useState(60);
  const [hhmm, setHhmm] = useState('09:00');
  const [cronExpr, setCronExpr] = useState('0 9 * * 1-5');

  const toggle = (id: string) =>
    setSelectedIds((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const save = async () => {
    if (!name.trim() || !instruction.trim()) {
      toast.error('请填写名称和指令');
      return;
    }
    const input: ScheduleInput = {
      name: name.trim(),
      instruction: instruction.trim(),
      requiresAuth,
      profileIds: selectedIds,
      spec:
        kind === 'interval'
          ? { kind, everyMin }
          : kind === 'daily'
            ? { kind, hhmm }
            : { kind, expr: cronExpr },
      enabled: true,
    };
    try {
      await matrix.schedules.create(input);
      props.onSaved();
      toast.success(`定时任务「${input.name}」已创建`);
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  return (
    <Modal
      title="新建定时任务"
      onClose={props.onClose}
      wide
      footer={
        <>
          <Button onClick={props.onClose}>取消</Button>
          <Button variant="primary" onClick={() => void save()}>
            创建
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <Field label="名称">
            <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="每日巡店" />
          </Field>
          <Field label="规则">
            <div className="flex gap-2">
              <select className={inputCls} value={kind} onChange={(e) => setKind(e.target.value as 'interval' | 'daily' | 'cron')}>
                <option value="daily">每日定点</option>
                <option value="interval">按间隔</option>
                <option value="cron">cron 表达式</option>
              </select>
              {kind === 'daily' ? (
                <input type="time" className={inputCls} value={hhmm} onChange={(e) => setHhmm(e.target.value)} />
              ) : kind === 'interval' ? (
                <div className="flex items-center gap-2">
                  <span className="shrink-0 text-xs text-slate-400">每</span>
                  <input
                    type="number"
                    min={1}
                    className={inputCls}
                    value={everyMin}
                    onChange={(e) => setEveryMin(Math.max(1, Number(e.target.value)))}
                  />
                  <span className="shrink-0 text-xs text-slate-400">分钟</span>
                </div>
              ) : (
                <input
                  className={`${inputCls} font-mono`}
                  value={cronExpr}
                  onChange={(e) => setCronExpr(e.target.value)}
                  placeholder="分 时 日 月 周，如 0 9 * * 1-5"
                  title="5 段 cron：分钟 小时 日 月 星期(0-6，0=周日)。支持 * / 数字 / a-b / a,b / */n"
                />
              )}
            </div>
            {kind === 'cron' && (
              <span className="mt-1.5 block text-xs leading-4 text-slate-500">
                5 段：分 时 日 月 周（0-6，0=周日）。示例：工作日早 9 点 <code className="font-mono">0 9 * * 1-5</code>；每 30 分钟 <code className="font-mono">*/30 * * * *</code>
              </span>
            )}
          </Field>
        </div>
        <Field label="任务指令">
          <textarea
            className={`${inputCls} h-24 resize-none`}
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            placeholder="打开店铺后台，提取今日订单数量和新消息数，汇总给我"
          />
        </Field>
        <Field label="Profile 池（选多个 = 批量任务，每个 Profile 各跑一遍并汇总）">
          <div className="flex flex-wrap gap-1.5">
            {props.profiles.map((p) => {
              const on = selectedIds.includes(p.id);
              return (
                <button
                  key={p.id}
                  className={`h-7 rounded-lg px-2.5 text-[13px] transition-colors duration-150 ${
                    on ? 'bg-accent-soft text-info' : 'bg-[var(--fill-1)] text-slate-400 hover:bg-[var(--fill-2)] hover:text-slate-200'
                  }`}
                  onClick={() => toggle(p.id)}
                >
                  {p.name}
                </button>
              );
            })}
          </div>
        </Field>
        <div
          className="flex cursor-pointer items-center gap-2 text-[13px] text-slate-400"
          onClick={() => setRequiresAuth(!requiresAuth)}
        >
          <CheckCircle size={16} checked={requiresAuth} />
          依赖登录态
        </div>
      </div>
    </Modal>
  );
}
