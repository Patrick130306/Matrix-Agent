import { useMemo, useState } from 'react';
import type { Profile, ProfileGroup, ProfileInput } from '@shared/types';
import { OS_PRESET_LIST } from '@shared/presets';
import { DEFAULT_PROFILE_TUNABLES } from '@shared/constants';
import { matrix } from '../api';
import { Button, Card, EmptyState, Field, IconButton, Modal, PageHeader, inputCls } from '../components/ui';
import { Icon } from '../components/icons';
import { confirmDialog, promptDialog, toast } from '../components/feedback';
import { LoginStatePanel } from '../components/LoginStatePanel';

/** §12 Profile 管理页：列表 + 分组 + 整组批量操作 + 创建/编辑弹窗。 */
export function ProfilesPage(props: { profiles: Profile[]; groups: ProfileGroup[]; refresh: () => void }) {
  const [editing, setEditing] = useState<Profile | 'new' | null>(null);
  const [importing, setImporting] = useState(false);
  const [loginPanelFor, setLoginPanelFor] = useState<Profile | null>(null);
  const [groupFilter, setGroupFilter] = useState(''); // '' = 全部；'__none__' = 未分组；其余 = 分组 id
  const [managingGroups, setManagingGroups] = useState(false);
  const [batchTaskFor, setBatchTaskFor] = useState<ProfileGroup | null>(null);
  const [batchBusy, setBatchBusy] = useState('');

  const groupName = (id?: string) => props.groups.find((g) => g.id === id)?.name;

  const filtered = useMemo(
    () =>
      props.profiles.filter((p) => {
        if (!groupFilter) return true;
        if (groupFilter === '__none__') return !p.groupId;
        return p.groupId === groupFilter;
      }),
    [props.profiles, groupFilter],
  );

  const selectedGroup = props.groups.find((g) => g.id === groupFilter) ?? null;

  const doExport = async (id: string, name: string) => {
    const json = await matrix.profiles.export(id);
    const blob = new Blob([json], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `matrix-profile-${name}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast.success(`已导出「${name}」`);
  };

  const doImport = async (file: File) => {
    try {
      await matrix.profiles.import(await file.text());
      props.refresh();
      toast.success('导入成功');
    } catch (err) {
      toast.error(`导入失败：${(err as Error).message}`);
    }
    setImporting(false);
  };

  /** 整组批量操作（逐个执行，失败不中断） */
  const batchRun = async (label: string, fn: (p: Profile) => Promise<unknown>) => {
    if (!selectedGroup) return;
    const members = filtered;
    if (members.length === 0) return;
    setBatchBusy(label);
    try {
      for (const p of members) {
        setBatchBusy(`${label} ${p.name}…`);
        await fn(p).catch((err) => console.warn(`[batch] ${label} ${p.name} 失败:`, err));
      }
    } finally {
      setBatchBusy('');
      props.refresh();
    }
  };

  const launchGroup = async () => {
    const ok = await confirmDialog({
      title: `整组打开 ${filtered.length} 个 Profile？`,
      body: '将依次打开多个浏览器窗口，机器可能明显变卡。',
      confirmText: '继续打开',
    });
    if (ok) void batchRun('打开', (p) => matrix.profiles.launch(p.id));
  };

  const removeProfile = async (p: Profile) => {
    const ok = await confirmDialog({
      title: `删除「${p.name}」？`,
      body: '其浏览器数据（含登录态）将一并清除，不可恢复。',
      danger: true,
      confirmText: '删除',
    });
    if (!ok) return;
    await matrix.profiles.delete(p.id);
    toast.success(`已删除「${p.name}」`);
    props.refresh();
  };

  return (
    <div>
      <PageHeader
        title="Profile 管理"
        desc={`共 ${props.profiles.length} 个 · 每个 Profile 是相互隔离的指纹浏览器环境（独立 Cookie / 代理 / 指纹）`}
        extra={
          <>
            <Button variant="outline" leftIcon="Upload" onClick={() => setImporting(true)}>
              导入
            </Button>
            <Button variant="primary" leftIcon="Add" onClick={() => setEditing('new')}>
              新建 Profile
            </Button>
          </>
        }
      />

      {/* 工具行：分组筛选 + 分组管理 */}
      <div className="mb-4 flex items-center gap-2">
        <select
          className={`${inputCls} !w-auto !py-2 text-[13px]`}
          value={groupFilter}
          onChange={(e) => setGroupFilter(e.target.value)}
        >
          <option value="">全部分组</option>
          <option value="__none__">未分组</option>
          {props.groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
        <Button variant="outline" size="sm" leftIcon="Folder" className="!h-9" onClick={() => setManagingGroups(true)}>
          分组管理
        </Button>
        <span className="ml-auto text-xs text-slate-500">
          {filtered.length} / {props.profiles.length} 个 Profile
        </span>
      </div>

      {/* 整组批量操作栏（选中具体分组时出现） */}
      {selectedGroup && (
        <Card className="mb-4 flex flex-wrap items-center gap-2 px-4 py-3">
          <span className="text-[13px] text-slate-300">
            分组「<span className="font-medium text-slate-200">{selectedGroup.name}</span>」· {filtered.length} 个
          </span>
          <Button size="sm" disabled={Boolean(batchBusy)} onClick={() => void launchGroup()}>
            整组打开
          </Button>
          <Button size="sm" disabled={Boolean(batchBusy)} onClick={() => void batchRun('关闭', (p) => matrix.profiles.stop(p.id))}>
            整组关闭
          </Button>
          <Button
            size="sm"
            disabled={Boolean(batchBusy)}
            onClick={() => void batchRun('检测代理', (p) => matrix.profiles.checkProxy(p.id))}
          >
            整组检测代理
          </Button>
          <Button size="sm" variant="primary" leftIcon="Send_b" disabled={Boolean(batchBusy)} onClick={() => setBatchTaskFor(selectedGroup)}>
            整组发任务
          </Button>
          {batchBusy && <span className="text-xs text-warn">{batchBusy}</span>}
        </Card>
      )}

      <Card>
        <table className="w-full">
          <thead>
            <tr className="border-b border-ink-600 text-left">
              <th className="px-4 py-3 text-xs font-medium text-slate-500">名称</th>
              <th className="px-4 py-3 text-xs font-medium text-slate-500">分组</th>
              <th className="px-4 py-3 text-xs font-medium text-slate-500">指纹预设</th>
              <th className="px-4 py-3 text-xs font-medium text-slate-500">时区 / 语言</th>
              <th className="px-4 py-3 text-xs font-medium text-slate-500">代理</th>
              <th className="px-4 py-3 text-xs font-medium text-slate-500">状态</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-slate-500">操作</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((p) => (
              <tr key={p.id} className="border-b border-white/5 transition-colors last:border-0 hover:bg-white/[0.03]">
                <td className="px-4 py-3 text-sm font-medium text-slate-200">{p.name}</td>
                <td className="px-4 py-3">
                  {groupName(p.groupId) ? (
                    <span className="rounded bg-accent-soft px-1.5 py-0.5 text-[11px] font-medium text-info">
                      {groupName(p.groupId)}
                    </span>
                  ) : (
                    <span className="text-xs text-slate-600">未分组</span>
                  )}
                </td>
                <td className="px-4 py-3 text-[13px] text-slate-400">
                  {OS_PRESET_LIST.find((o) => o.id === p.osPreset)?.label ?? p.osPreset}
                </td>
                <td className="px-4 py-3 text-[13px] text-slate-400">
                  {p.timezone} · {p.locale}
                </td>
                <td className="px-4 py-3">
                  <ProxyCell profile={p} onChecked={props.refresh} />
                </td>
                <td className="px-4 py-3">
                  {p.status === 'running' ? (
                    <span className="inline-flex items-center gap-1.5 text-xs text-info">
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-info" />
                      运行中
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 text-xs text-slate-500">
                      <span className="h-1.5 w-1.5 rounded-full bg-white/20" />
                      空闲
                    </span>
                  )}
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center justify-end gap-1.5">
                    {p.status !== 'running' ? (
                      <Button size="sm" leftIcon="Play" onClick={() => void matrix.profiles.launch(p.id).then(props.refresh).catch((e) => toast.error((e as Error).message))}>
                        打开
                      </Button>
                    ) : (
                      <Button size="sm" leftIcon="Stop" onClick={() => void matrix.profiles.stop(p.id).then(props.refresh)}>
                        关闭
                      </Button>
                    )}
                    <Button size="sm" onClick={() => setLoginPanelFor(p)}>登录态</Button>
                    <Button size="sm" onClick={() => setEditing(p)}>编辑</Button>
                    <IconButton name="Scan" title="指纹自测" onClick={() => void matrix.profiles.selfTest(p.id).catch((e) => toast.error((e as Error).message))} />
                    <IconButton name="Copy" title="克隆" onClick={() => void matrix.profiles.clone(p.id).then(props.refresh)} />
                    <IconButton name="Download" title="导出" onClick={() => void doExport(p.id, p.name)} />
                    <IconButton name="Delete" title="删除" danger onClick={() => void removeProfile(p)} />
                  </div>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={7}>
                  <EmptyState
                    icon="Profile"
                    title={props.profiles.length === 0 ? '还没有 Profile' : '该分组下暂无 Profile'}
                    hint={props.profiles.length === 0 ? '点击右上角「新建 Profile」，创建第一个隔离浏览器环境' : undefined}
                  />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>

      {editing && (
        <ProfileForm
          profile={editing === 'new' ? null : editing}
          groups={props.groups}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            props.refresh();
          }}
        />
      )}

      {importing && (
        <Modal title="导入 Profile" onClose={() => setImporting(false)}>
          <p className="mb-3 text-[13px] text-slate-400">选择之前导出的 Profile JSON 文件，指纹与代理配置会一并恢复。</p>
          <input
            type="file"
            accept="application/json"
            className="text-sm text-slate-400 file:mr-3 file:h-8 file:rounded-[10px] file:border-0 file:bg-white/5 file:px-3 file:text-sm file:font-medium file:text-slate-200 hover:file:bg-white/10"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void doImport(f);
            }}
          />
        </Modal>
      )}

      {loginPanelFor && (
        <LoginStatePanel profile={loginPanelFor} onClose={() => setLoginPanelFor(null)} />
      )}

      {managingGroups && (
        <GroupManageModal groups={props.groups} onClose={() => setManagingGroups(false)} refresh={props.refresh} />
      )}

      {batchTaskFor && (
        <BatchTaskModal
          group={batchTaskFor}
          members={props.profiles.filter((p) => p.groupId === batchTaskFor.id)}
          onClose={() => setBatchTaskFor(null)}
          onSubmitted={() => {
            setBatchTaskFor(null);
            props.refresh();
          }}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------------ 代理单元格（含出口检测）

function ProxyCell(props: { profile: Profile; onChecked: () => void }) {
  const { profile: p } = props;
  const [checking, setChecking] = useState(false);
  const c = p.proxyCheck;

  const check = async () => {
    setChecking(true);
    try {
      await matrix.profiles.checkProxy(p.id);
      props.onChecked();
    } catch (err) {
      toast.error(`代理检测失败：${(err as Error).message}`);
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="space-y-0.5">
      <div className="flex items-center gap-2">
        <span className="text-[13px] text-slate-400">
          {p.proxyType === 'none' ? '直连' : `${p.proxyType}://${p.proxyHost}:${p.proxyPort}`}
        </span>
        <button
          className="h-[22px] rounded-md bg-white/5 px-1.5 text-[11px] text-slate-400 transition-colors hover:bg-white/10 hover:text-slate-200 disabled:opacity-50"
          disabled={checking}
          onClick={() => void check()}
          title="检测代理可用性 + 出口 IP"
        >
          {checking ? '…' : '检测'}
        </button>
      </div>
      {c && (
        <div className="text-[11px] leading-4" title={c.error ?? c.checkedAt}>
          {c.ok ? (
            <>
              <p className="text-ok">✓ 出口 {c.ip} · {c.latencyMs}ms</p>
              <p className={c.webrtcLeak ? 'text-danger' : 'text-ok'}>
                {c.webrtcLeak
                  ? `⚠ WebRTC 泄露：${c.webrtcIps?.join(', ') ?? ''}`
                  : c.webrtcIps && c.webrtcIps.length > 0
                    ? '✓ WebRTC 无泄露'
                    : '✓ WebRTC 未发现候选 IP'}
              </p>
            </>
          ) : (
            <p className="text-danger">✗ {(c.error ?? '失败').slice(0, 40)}</p>
          )}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ 分组管理弹窗

function GroupManageModal(props: { groups: ProfileGroup[]; onClose: () => void; refresh: () => void }) {
  const [newName, setNewName] = useState('');

  const create = async () => {
    if (!newName.trim()) return;
    try {
      await matrix.groups.create(newName.trim());
      setNewName('');
      props.refresh();
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const rename = async (g: ProfileGroup) => {
    const name = await promptDialog({ title: '重命名分组', defaultValue: g.name });
    if (!name?.trim()) return;
    try {
      await matrix.groups.rename(g.id, name.trim());
      props.refresh();
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const remove = async (g: ProfileGroup) => {
    const ok = await confirmDialog({
      title: `删除分组「${g.name}」？`,
      body: '组内 Profile 会落到「未分组」，Profile 本身不受影响。',
      danger: true,
      confirmText: '删除',
    });
    if (ok) void matrix.groups.delete(g.id).then(props.refresh);
  };

  return (
    <Modal title="分组管理" onClose={props.onClose}>
      <div className="space-y-2">
        {props.groups.map((g) => (
          <div key={g.id} className="flex items-center gap-2 rounded-[10px] bg-white/[0.04] px-3 py-2.5">
            <Icon name="Folder" size={16} className="text-slate-500" />
            <span className="flex-1 text-sm text-slate-200">{g.name}</span>
            <Button size="sm" onClick={() => void rename(g)}>
              重命名
            </Button>
            <Button size="sm" variant="danger" onClick={() => void remove(g)}>
              删除
            </Button>
          </div>
        ))}
        {props.groups.length === 0 && (
          <p className="rounded-[10px] border border-dashed border-white/10 px-3 py-6 text-center text-xs text-slate-500">
            还没有分组。按店铺 / 平台建组，例如「抖音小店」「TikTok 美区」。
          </p>
        )}
        <div className="flex gap-2 border-t border-white/5 pt-4">
          <input
            className={inputCls}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="新分组名称"
            onKeyDown={(e) => {
              if (e.key === 'Enter') void create();
            }}
          />
          <Button variant="primary" leftIcon="Add" onClick={() => void create()}>
            创建
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ 整组发任务弹窗

function BatchTaskModal(props: {
  group: ProfileGroup;
  members: Profile[];
  onClose: () => void;
  onSubmitted: () => void;
}) {
  const [instruction, setInstruction] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (!instruction.trim() || submitting) return;
    setSubmitting(true);
    try {
      await matrix.tasks.createBatch({
        name: instruction.trim(),
        requiresAuth: true, // 矩阵任务几乎都依赖登录态；匿名需求请到工作台下发
        profileIds: props.members.map((p) => p.id),
      });
      props.onSubmitted();
      toast.success(`已派发到「${props.group.name}」的 ${props.members.length} 个 Profile，到工作台或任务历史查看进度`);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title={`整组发任务：${props.group.name}（${props.members.length} 个 Profile）`}
      onClose={props.onClose}
      wide
      footer={
        <>
          <Button onClick={props.onClose}>取消</Button>
          <Button variant="primary" leftIcon="Send_b" disabled={!instruction.trim() || submitting || props.members.length === 0} onClick={() => void submit()}>
            {submitting ? '派发中…' : `批量执行（${props.members.length} 个 Profile）`}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-[13px] leading-5 text-slate-400">
          同一条指令会派发给组内每个 Profile 各自执行（批量任务），结果自动汇总。成员：
          {props.members.map((p) => p.name).join('、') || '（空）'}
        </p>
        <textarea
          className={`${inputCls} h-28 resize-none`}
          placeholder="例如：打开店铺后台，把今天的待发货订单数提取给我"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
        />
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ 表单

function ProfileForm(props: { profile: Profile | null; groups: ProfileGroup[]; onClose: () => void; onSaved: () => void }) {
  const p = props.profile;
  const [form, setForm] = useState({
    name: p?.name ?? '',
    groupId: p?.groupId ?? '',
    osPreset: p?.osPreset ?? 'win11-chrome',
    screenWidth: p?.screenWidth ?? DEFAULT_PROFILE_TUNABLES.screenWidth,
    screenHeight: p?.screenHeight ?? DEFAULT_PROFILE_TUNABLES.screenHeight,
    timezone: p?.timezone ?? DEFAULT_PROFILE_TUNABLES.timezone,
    locale: p?.locale ?? DEFAULT_PROFILE_TUNABLES.locale,
    languages: (p?.languages ?? [...DEFAULT_PROFILE_TUNABLES.languages]).join(', '),
    hardwareConcurrency: p?.hardwareConcurrency ?? DEFAULT_PROFILE_TUNABLES.hardwareConcurrency,
    deviceMemory: p?.deviceMemory ?? DEFAULT_PROFILE_TUNABLES.deviceMemory,
    proxyType: p?.proxyType ?? 'none',
    proxyHost: p?.proxyHost ?? '',
    proxyPort: p?.proxyPort ?? 0,
    proxyUsername: p?.proxyUsername ?? '',
    proxyPassword: '', // 编辑时留空表示不改动
  });
  const [saving, setSaving] = useState(false);
  const [fpBusy, setFpBusy] = useState(false);
  const [fpHint, setFpHint] = useState('');

  const set = (k: keyof typeof form, v: string | number) => setForm((f) => ({ ...f, [k]: v }));

  /** 根据代理出口 IP 自动生成时区/语言指纹（回填表单，保存时入库） */
  const autoFingerprint = async () => {
    if (form.proxyType === 'none' || !form.proxyHost.trim() || !form.proxyPort) {
      toast.error('请先填写代理类型 / 主机 / 端口');
      return;
    }
    setFpBusy(true);
    setFpHint('');
    try {
      const s = await matrix.profiles.autoFingerprint({
        type: form.proxyType as ProfileInput['proxyType'],
        host: form.proxyHost.trim(),
        port: Number(form.proxyPort),
        username: form.proxyUsername.trim() || undefined,
        password: form.proxyPassword || undefined,
      });
      set('timezone', s.timezone);
      set('locale', s.locale);
      set('languages', s.languages.join(', '));
      setFpHint(
        `已根据出口 IP ${s.ip}（${s.country}${s.city ? ' · ' + s.city : ''}）生成：时区 ${s.timezone}，语言 ${s.languages.join(', ')}`,
      );
    } catch (err) {
      toast.error(`生成失败：${(err as Error).message}`);
    } finally {
      setFpBusy(false);
    }
  };

  const save = async () => {
    if (!form.name.trim()) {
      toast.error('请填写名称');
      return;
    }
    setSaving(true);
    try {
      const base: ProfileInput = {
        name: form.name.trim(),
        groupId: form.groupId || undefined,
        osPreset: form.osPreset as ProfileInput['osPreset'],
        screenWidth: Number(form.screenWidth),
        screenHeight: Number(form.screenHeight),
        timezone: form.timezone.trim(),
        locale: form.locale.trim(),
        languages: form.languages.split(',').map((s) => s.trim()).filter(Boolean),
        hardwareConcurrency: Number(form.hardwareConcurrency),
        deviceMemory: Number(form.deviceMemory),
        proxyType: form.proxyType as ProfileInput['proxyType'],
        proxyHost: form.proxyHost || undefined,
        proxyPort: form.proxyPort ? Number(form.proxyPort) : undefined,
        proxyUsername: form.proxyUsername || undefined,
        proxyPasswordEnc: p?.proxyPasswordEnc,
      };

      if (p) {
        await matrix.profiles.update(p.id, base);
        // 代理密码单独更新（留空 = 不改动）
        if (form.proxyPassword) {
          // 经主进程加密
          await matrix.profiles.update(p.id, { proxyPasswordEnc: `__encrypt__:${form.proxyPassword}` });
        }
      } else {
        const created = await matrix.profiles.create(base);
        if (form.proxyPassword) {
          await matrix.profiles.update(created.id, { proxyPasswordEnc: `__encrypt__:${form.proxyPassword}` });
        }
      }
      props.onSaved();
      toast.success(p ? '已保存' : `已创建「${form.name.trim()}」`);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={p ? `编辑 Profile：${p.name}` : '新建 Profile'}
      onClose={props.onClose}
      wide
      footer={
        <>
          <Button onClick={props.onClose}>取消</Button>
          <Button variant="primary" disabled={saving} onClick={() => void save()}>
            {saving ? '保存中…' : '保存'}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-4">
        <Field label="名称">
          <input className={inputCls} value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="店铺A-美国" />
        </Field>
        <Field label="分组">
          <select className={inputCls} value={form.groupId} onChange={(e) => set('groupId', e.target.value)}>
            <option value="">未分组</option>
            {props.groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="操作系统预设包（§6.2）" hint="UA / UA-CH / platform / WebGL / 触点数由预设派生，保证一致性">
          <select className={inputCls} value={form.osPreset} onChange={(e) => set('osPreset', e.target.value)}>
            {OS_PRESET_LIST.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="时区">
          <input className={inputCls} value={form.timezone} onChange={(e) => set('timezone', e.target.value)} placeholder="America/New_York" />
        </Field>
        <Field label="Locale">
          <input className={inputCls} value={form.locale} onChange={(e) => set('locale', e.target.value)} placeholder="en-US" />
        </Field>
        <Field label="语言列表（逗号分隔）">
          <input className={inputCls} value={form.languages} onChange={(e) => set('languages', e.target.value)} placeholder="en-US, en" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="屏幕宽度">
            <input type="number" className={inputCls} value={form.screenWidth} onChange={(e) => set('screenWidth', e.target.value)} />
          </Field>
          <Field label="屏幕高度">
            <input type="number" className={inputCls} value={form.screenHeight} onChange={(e) => set('screenHeight', e.target.value)} />
          </Field>
        </div>
        <Field label="CPU 核心数（2–16）">
          <input type="number" min={2} max={16} className={inputCls} value={form.hardwareConcurrency} onChange={(e) => set('hardwareConcurrency', Number(e.target.value))} />
        </Field>
        <Field label="设备内存 GB（2 / 4 / 8）">
          <select className={inputCls} value={form.deviceMemory} onChange={(e) => set('deviceMemory', Number(e.target.value))}>
            {[2, 4, 8].map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </Field>

        <div className="col-span-2 mt-2 border-t border-white/5 pt-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <p className="text-[13px] font-medium text-slate-300">代理设置（代理几乎都需要认证，已原生支持，§ADR-1）</p>
            <Button size="sm" leftIcon="Scan" disabled={fpBusy} onClick={() => void autoFingerprint()}>
              {fpBusy ? '生成中…' : '根据出口 IP 生成指纹'}
            </Button>
          </div>
          {fpHint && <p className="mb-2 text-[12px] leading-5 text-ok">{fpHint}</p>}
          <div className="grid grid-cols-4 gap-3">
            <Field label="类型">
              <select className={inputCls} value={form.proxyType} onChange={(e) => set('proxyType', e.target.value)}>
                <option value="none">直连</option>
                <option value="http">HTTP</option>
                <option value="https">HTTPS</option>
                <option value="socks5">SOCKS5</option>
              </select>
            </Field>
            <Field label="主机">
              <input className={inputCls} value={form.proxyHost} onChange={(e) => set('proxyHost', e.target.value)} placeholder="1.2.3.4" />
            </Field>
            <Field label="端口">
              <input type="number" className={inputCls} value={form.proxyPort || ''} onChange={(e) => set('proxyPort', e.target.value)} />
            </Field>
            <Field label="用户名">
              <input className={inputCls} value={form.proxyUsername} onChange={(e) => set('proxyUsername', e.target.value)} />
            </Field>
            <Field label={p ? '密码（留空 = 不改动）' : '密码'}>
              <input type="password" className={inputCls} value={form.proxyPassword} onChange={(e) => set('proxyPassword', e.target.value)} />
            </Field>
          </div>
        </div>
      </div>
    </Modal>
  );
}
