import { useCallback, useEffect, useRef, useState } from 'react';
import { matrix } from '../api';
import { Button, EmptyState } from './ui';
import { confirmDialog, toast } from './feedback';

type ChromiumView = {
  version: string;
  label: string;
  sizeMB: number;
  status:
    | { installed: true; executable: string }
    | { installed: false; downloading?: { received: number; total: number; status: string; error?: string } };
  active: boolean;
};

/**
 * Chromium 内核管理（设置 → 浏览器）：按需下载/删除，用户可选版本。
 * 安装包不内置内核；无系统 Chrome 时在这里一键下载（Google 官方源直连）。
 */
export function ChromiumManagerPanel() {
  const [items, setItems] = useState<ChromiumView[]>([]);
  const [downloading, setDownloading] = useState<string | null>(null); // 正在下载的版本
  const [refreshing, setRefreshing] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await matrix.chromium.list();
      setItems(list);
      const dl = list.find((i) => i.status.installed === false && i.status.downloading);
      setDownloading(dl ? dl.version : null);
    } catch {
      /* 静默 */
    }
  }, []);

  useEffect(() => {
    void refresh();
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [refresh]);

  // 下载进行中：轮询进度（2s）
  useEffect(() => {
    if (downloading) {
      if (!timerRef.current) {
        timerRef.current = setInterval(() => void refresh(), 2000);
      }
    } else if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, [downloading, refresh]);

  const doDownload = async (v: ChromiumView) => {
    setDownloading(v.version);
    toast.info(`开始下载 ${v.label}（约 ${v.sizeMB}MB），完成后自动解压…`);
    try {
      const r = await matrix.chromium.download(v.version);
      if (r.ok) {
        toast.success(`${v.label} 已就绪，可直接使用`);
      }
    } catch (err) {
      toast.error(`下载失败：${(err as Error).message}`);
    } finally {
      await refresh();
    }
  };

  const doRemove = async (v: ChromiumView) => {
    const ok = await confirmDialog({
      title: `删除内核 ${v.version}？`,
      body: `将释放约 ${v.sizeMB}MB 磁盘空间。删除后该版本不再可用（可随时重新下载）。`,
      danger: true,
      confirmText: '删除',
    });
    if (!ok) return;
    await matrix.chromium.remove(v.version);
    await refresh();
    toast.success(`已删除 ${v.version}`);
  };

  return (
    <div className="space-y-2">
      {items.map((v) => {
        const installed = v.status.installed;
        const dl = !installed ? v.status.downloading : undefined;
        const pct = dl && dl.total > 0 ? Math.min(100, Math.round((dl.received / dl.total) * 100)) : 0;
        return (
          <div key={v.version} className="flex items-center gap-3 rounded-[10px] bg-[var(--fill-1)] px-3.5 py-3">
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-2 text-[13px] text-slate-300">
                {v.label}
                {installed && (
                  <span className="rounded bg-ok-soft px-1.5 py-0.5 text-[11px] font-medium text-ok">已安装</span>
                )}
                {v.active && (
                  <span className="rounded bg-info-soft px-1.5 py-0.5 text-[11px] font-medium text-info">当前使用</span>
                )}
              </p>
              <p className="mt-0.5 text-xs text-slate-500">约 {v.sizeMB}MB · Chrome for Testing 官方源</p>
              {dl && dl.status === 'downloading' && (
                <div className="mt-1.5 flex items-center gap-2">
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--fill-3)]">
                    <div className="h-full rounded-full bg-info transition-all" style={{ width: `${pct}%` }} />
                  </div>
                  <span className="shrink-0 text-[11px] text-slate-400">{pct}%</span>
                </div>
              )}
              {dl && dl.status === 'extracting' && (
                <p className="mt-1 text-[11px] text-slate-400">解压中…</p>
              )}
              {dl && dl.status === 'error' && (
                <p className="mt-1 text-[11px] text-danger" title={dl.error}>
                  下载失败：{dl.error?.slice(0, 60)}
                </p>
              )}
            </div>
            <div className="shrink-0">
              {installed ? (
                <Button size="sm" variant="danger" onClick={() => void doRemove(v)}>
                  删除
                </Button>
              ) : downloading === v.version ? (
                <Button size="sm" disabled>
                  {dl?.status === 'extracting' ? '解压中…' : '下载中…'}
                </Button>
              ) : (
                <Button size="sm" variant="primary" leftIcon="Download" onClick={() => void doDownload(v)}>
                  下载
                </Button>
              )}
            </div>
          </div>
        );
      })}
      {items.length === 0 && (
        <EmptyState icon="Browser" title="暂无可用内核版本" hint="网络异常时可能无法获取版本列表" />
      )}
      <p className="text-xs leading-4 text-slate-500">
        使用优先级：手动指定路径 → 系统 Chrome → 这里下载的 Chromium（多个版本取最新）。下载后可删除不用的版本。
      </p>
    </div>
  );
}
