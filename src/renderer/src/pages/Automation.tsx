import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { Flow, Profile, Schedule, ScheduleInput, TaskTemplate } from '@shared/types';
import { matrix } from '../api';
import { Button, Card, CheckCircle, EmptyState, Field, IconButton, Modal, PageHeader, Toggle, inputCls } from '../components/ui';
import { confirmDialog, toast } from '../components/feedback';

/** 自动化页：定时任务 + 流程复用（秒级回放）+ 结构化采集 + 任务模板。 */
export function AutomationPage(props: { profiles: Profile[] }) {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [templates, setTemplates] = useState<TaskTemplate[]>([]);
  const [flows, setFlows] = useState<Flow[]>([]);
  const [editing, setEditing] = useState(false);
  const [runFlowFor, setRunFlowFor] = useState<Flow | null>(null);
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
                  <tr key={s.id} className="border-b border-white/5 transition-colors last:border-0 hover:bg-white/[0.03]">
                    <td className="max-w-52 truncate px-4 py-3 text-sm text-slate-200" title={s.instruction}>
                      {s.name}
                    </td>
                    <td className="px-4 py-3 text-[13px] text-slate-400">
                      {s.spec.kind === 'interval' ? `每 ${s.spec.everyMin} 分钟` : `每日 ${s.spec.hhmm}`}
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
        <div className="max-h-40 space-y-1 overflow-auto rounded-[10px] bg-black/30 p-3 font-mono text-xs leading-5 text-slate-400">
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

// ------------------------------------------------------------------ 结构化采集

function CollectorModal(props: { profiles: Profile[]; onClose: () => void }) {
  const [url, setUrl] = useState('');
  const [fields, setFields] = useState('');
  const [maxPages, setMaxPages] = useState(3);
  const [profileId, setProfileId] = useState(props.profiles[0]?.id ?? '');
  const [submitting, setSubmitting] = useState(false);

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
        `3. 找到并点击「下一页」继续采集；没有下一页或已采 ${maxPages} 页则结束`,
        `4. 最后用 done 交付，result 写「共采集 N 条」（系统会自动合并各页数据为表格）`,
      ].join('\n');
      await matrix.tasks.create({
        name: `[采集] ${url.trim().slice(0, 40)} · ${fieldList.join('/')}`,
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
          <Button onClick={props.onClose}>取消</Button>
          <Button variant="primary" disabled={submitting} onClick={() => void submit()}>
            {submitting ? '提交中…' : '开始采集'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
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
  const [kind, setKind] = useState<'interval' | 'daily'>('daily');
  const [everyMin, setEveryMin] = useState(60);
  const [hhmm, setHhmm] = useState('09:00');

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
      spec: kind === 'interval' ? { kind, everyMin } : { kind, hhmm },
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
              <select className={inputCls} value={kind} onChange={(e) => setKind(e.target.value as 'interval' | 'daily')}>
                <option value="daily">每日定点</option>
                <option value="interval">按间隔</option>
              </select>
              {kind === 'daily' ? (
                <input type="time" className={inputCls} value={hhmm} onChange={(e) => setHhmm(e.target.value)} />
              ) : (
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
              )}
            </div>
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
                    on ? 'bg-accent-soft text-info' : 'bg-white/5 text-slate-400 hover:bg-white/10 hover:text-slate-200'
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
