import { useCallback, useEffect, useState } from 'react';
import type { ProxyPoolEntry } from '@shared/types';
import { matrix } from '../api';
import { Button, EmptyState, IconButton, inputCls } from './ui';
import { confirmDialog, toast } from './feedback';

/**
 * 代理池面板（设置页）：批量导入 → 一键验证 → 列表管理。
 * Profile 编辑页可引用「使用代理池」让浏览器启动时自动从池中取可用代理。
 */
export function ProxyPoolPanel() {
  const [entries, setEntries] = useState<ProxyPoolEntry[]>([]);
  const [importText, setImportText] = useState('');
  const [checking, setChecking] = useState(false);

  const refresh = useCallback(() => {
    void matrix.proxyPool.list().then(setEntries);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const doImport = async () => {
    if (!importText.trim()) return;
    try {
      const r = await matrix.proxyPool.add(importText);
      setImportText('');
      refresh();
      const extra = r.skipped > 0 ? `，${r.skipped} 行格式错误已跳过${r.skippedSamples.length ? `（如 ${r.skippedSamples[0]}）` : ''}` : '';
      toast.success(`已导入 ${r.added} 条代理${extra}`);
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const doCheckAll = async () => {
    if (entries.length === 0) return;
    setChecking(true);
    try {
      const r = await matrix.proxyPool.checkAll();
      setEntries(r.list);
      toast.success(`验证完成：${r.ok} 可用 / ${r.fail} 失败 / 共 ${r.total}`);
    } catch (err) {
      toast.error(`验证失败：${(err as Error).message}`);
    } finally {
      setChecking(false);
    }
  };

  const doClear = async () => {
    const ok = await confirmDialog({
      title: '清空代理池？',
      body: `将删除全部 ${entries.length} 条代理记录，正在使用该池的 Profile 会回退为直连。`,
      danger: true,
      confirmText: '清空',
    });
    if (!ok) return;
    await matrix.proxyPool.clear();
    refresh();
    toast.success('代理池已清空');
  };

  const doDelete = async (e: ProxyPoolEntry) => {
    await matrix.proxyPool.delete(e.id);
    refresh();
  };

  const okCount = entries.filter((e) => e.status === 'ok').length;
  const failCount = entries.filter((e) => e.status === 'fail').length;

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <textarea
          className={`${inputCls} h-24 resize-none font-mono text-xs leading-5`}
          placeholder={'每行一条代理，支持格式：\nhost:port\nhost:port:user:pass\nhttp://host:port:user:pass'}
          value={importText}
          onChange={(e) => setImportText(e.target.value)}
        />
        <div className="flex items-center gap-2">
          <Button size="sm" leftIcon="Add" disabled={!importText.trim()} onClick={() => void doImport()}>
            导入
          </Button>
          <Button
            size="sm"
            variant="outline"
            leftIcon="Scan"
            disabled={entries.length === 0 || checking}
            onClick={() => void doCheckAll()}
          >
            {checking ? '验证中…' : `一键验证（${entries.length} 条）`}
          </Button>
          {entries.length > 0 && (
            <Button size="sm" variant="danger" onClick={() => void doClear()}>
              清空
            </Button>
          )}
          <span className="ml-auto text-xs text-slate-500">
            共 {entries.length} 条 · <span className="text-ok">{okCount} 可用</span> ·{' '}
            <span className="text-danger">{failCount} 失败</span>
          </span>
        </div>
      </div>

      {entries.length === 0 ? (
        <EmptyState icon="Link" title="代理池为空" hint="粘贴批量代理文本导入，之后到 Profile 编辑里选择「使用代理池」" />
      ) : (
        <div className="max-h-72 overflow-auto rounded-[10px] border border-ink-600">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-ink-700">
              <tr className="border-b border-ink-600 text-left">
                <th className="px-3 py-2 font-medium text-slate-500">代理</th>
                <th className="px-3 py-2 font-medium text-slate-500">状态</th>
                <th className="px-3 py-2 font-medium text-slate-500">出口 IP</th>
                <th className="px-3 py-2 font-medium text-slate-500">延迟</th>
                <th className="px-3 py-2 text-right font-medium text-slate-500">操作</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id} className="border-b border-[var(--line-1)] last:border-0">
                  <td className="max-w-56 truncate px-3 py-2 font-mono text-slate-300" title={e.username ? `${e.host}:${e.port} (${e.username})` : `${e.host}:${e.port}`}>
                    {e.type}://{e.host}:{e.port}
                    {e.username ? ` (${e.username})` : ''}
                  </td>
                  <td className="px-3 py-2">
                    {e.status === 'ok' && <span className="text-ok">✓ 可用</span>}
                    {e.status === 'fail' && <span className="text-danger" title={e.lastError}>✗ 失败</span>}
                    {e.status === 'unknown' && <span className="text-slate-500">未验证</span>}
                  </td>
                  <td className="max-w-32 truncate px-3 py-2 font-mono text-slate-400" title={e.lastError ?? ''}>
                    {e.ip ?? '—'}
                  </td>
                  <td className="px-3 py-2 text-slate-400">{e.latencyMs ? `${e.latencyMs}ms` : '—'}</td>
                  <td className="px-3 py-2">
                    <div className="flex justify-end">
                      <IconButton name="Delete" title="删除" danger onClick={() => void doDelete(e)} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
