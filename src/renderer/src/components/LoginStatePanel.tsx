import { useEffect, useState } from 'react';
import type { LoginCheck, Profile } from '@shared/types';
import { matrix } from '../api';
import { Button, Field, IconButton, Modal, inputCls } from './ui';
import { confirmDialog, toast } from './feedback';

/**
 * 登录态管理面板（矩阵运营防掉号）：
 * - 检测项：打开检测页找「已登录标识」（CSS 选择器 / 页面关键词），在线/掉线一目了然；
 * - Cookie 迁移：导出 / 导入该 Profile 的全部 Cookie（换机器、买号迁移场景）。
 */
export function LoginStatePanel(props: { profile: Profile; onClose: () => void }) {
  const { profile } = props;
  const [checks, setChecks] = useState<LoginCheck[]>([]);
  const [runningId, setRunningId] = useState<string>('');
  const [form, setForm] = useState({ name: '', url: '', mode: 'keyword' as 'selector' | 'keyword', target: '' });
  const [cookieMsg, setCookieMsg] = useState('');

  const refresh = () => void matrix.loginChecks.list(profile.id).then(setChecks);
  useEffect(refresh, [profile.id]);

  const add = async () => {
    if (!form.name.trim() || !form.url.trim() || !form.target.trim()) {
      toast.error('名称、检测页 URL、检测目标都必填');
      return;
    }
    try {
      await matrix.loginChecks.create({
        profileId: profile.id,
        name: form.name.trim(),
        url: form.url.trim(),
        mode: form.mode,
        target: form.target.trim(),
      });
      setForm({ name: '', url: '', mode: 'keyword', target: '' });
      refresh();
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const run = async (id: string) => {
    setRunningId(id);
    try {
      await matrix.loginChecks.run(id);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setRunningId('');
      refresh();
    }
  };

  const remove = async (c: LoginCheck) => {
    const ok = await confirmDialog({ title: `删除检测项「${c.name}」？`, danger: true, confirmText: '删除' });
    if (ok) void matrix.loginChecks.delete(c.id).then(refresh);
  };

  const exportCookies = async () => {
    setCookieMsg('导出中…（浏览器未启动会自动启动）');
    try {
      const r = await matrix.profiles.exportCookies(profile.id);
      setCookieMsg(r.cancelled ? '已取消' : `✓ 已导出 ${r.count} 条 Cookie`);
    } catch (err) {
      setCookieMsg(`✗ ${(err as Error).message}`);
    }
  };

  const importCookies = async () => {
    const ok = await confirmDialog({
      title: '导入 Cookie？',
      body: '导入会写入该 Profile 的浏览器环境，同名 Cookie 被覆盖。',
      confirmText: '导入',
    });
    if (!ok) return;
    setCookieMsg('导入中…');
    try {
      const r = await matrix.profiles.importCookies(profile.id);
      setCookieMsg(r.cancelled ? '已取消' : `✓ 已导入 ${r.count} 条 Cookie（刷新页面后生效）`);
    } catch (err) {
      setCookieMsg(`✗ ${(err as Error).message}`);
    }
  };

  return (
    <Modal title={`登录态管理：${profile.name}`} onClose={props.onClose} wide>
      <div className="space-y-5">
        {/* 检测项列表 */}
        <div>
          <p className="mb-2 text-[13px] font-medium text-slate-300">
            登录检测项（打开检测页，能找到「已登录标识」即视为在线）
          </p>
          <div className="space-y-2">
            {checks.map((c) => (
              <div key={c.id} className="flex items-center gap-3 rounded-[10px] bg-[var(--fill-1)] px-3 py-2.5">
                <span
                  className={`inline-flex shrink-0 items-center gap-1.5 text-xs ${
                    c.status === 'online' ? 'text-ok' : c.status === 'offline' ? 'text-danger' : 'text-slate-500'
                  }`}
                  title={c.detail}
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      c.status === 'online' ? 'bg-ok' : c.status === 'offline' ? 'bg-danger' : 'bg-[var(--fill-3)]'
                    }`}
                  />
                  {c.status === 'online' ? '在线' : c.status === 'offline' ? '掉线' : '未检测'}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-200">{c.name}</p>
                  <p className="truncate text-xs text-slate-500">
                    {c.url} · {c.mode === 'selector' ? `选择器 ${c.target}` : `关键词「${c.target}」`}
                    {c.lastCheckedAt ? ` · ${new Date(c.lastCheckedAt).toLocaleString()}` : ''}
                  </p>
                </div>
                <Button size="sm" disabled={runningId === c.id} onClick={() => void run(c.id)}>
                  {runningId === c.id ? '检测中…' : '检测'}
                </Button>
                <IconButton name="Delete" title="删除检测项" danger onClick={() => void remove(c)} />
              </div>
            ))}
            {checks.length === 0 && (
              <p className="rounded-[10px] border border-dashed border-[var(--line-2)] px-3 py-6 text-center text-xs text-slate-500">
                还没有检测项。示例：抖音小店 → URL 填抖店后台首页，关键词填「退出登录」
              </p>
            )}
          </div>

          {/* 新建检测项 */}
          <div className="mt-3 grid grid-cols-2 gap-3 rounded-[10px] bg-[var(--fill-1)] p-4">
            <Field label="平台名称">
              <input className={inputCls} value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="抖音小店" />
            </Field>
            <Field label="检测页 URL（登录后才能看到的页面）">
              <input className={inputCls} value={form.url} onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))} placeholder="https://fxg.jinritemai.com/..." />
            </Field>
            <Field label="判定方式">
              <select className={inputCls} value={form.mode} onChange={(e) => setForm((f) => ({ ...f, mode: e.target.value as 'selector' | 'keyword' }))}>
                <option value="keyword">页面包含关键词</option>
                <option value="selector">存在 CSS 选择器</option>
              </select>
            </Field>
            <Field label={form.mode === 'keyword' ? '已登录时页面应有的文本' : '已登录时页面存在的 CSS 选择器'}>
              <input className={inputCls} value={form.target} onChange={(e) => setForm((f) => ({ ...f, target: e.target.value }))} placeholder={form.mode === 'keyword' ? '退出登录' : '.user-avatar'} />
            </Field>
            <div className="col-span-2 flex justify-end">
              <Button variant="primary" leftIcon="Add" onClick={() => void add()}>添加检测项</Button>
            </div>
          </div>
        </div>

        {/* Cookie 迁移 */}
        <div className="border-t border-[var(--line-1)] pt-4">
          <p className="mb-2.5 text-[13px] font-medium text-slate-300">Cookie 迁移（登录态备份 / 买号导入）</p>
          <div className="flex items-center gap-2">
            <Button variant="outline" leftIcon="Download" onClick={() => void exportCookies()}>导出 Cookie</Button>
            <Button variant="outline" leftIcon="Upload" onClick={() => void importCookies()}>导入 Cookie</Button>
            {cookieMsg && (
              <span className={`text-xs ${cookieMsg.startsWith('✓') ? 'text-ok' : cookieMsg.startsWith('✗') ? 'text-danger' : 'text-slate-400'}`}>
                {cookieMsg}
              </span>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
