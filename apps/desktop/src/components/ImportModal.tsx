import { useEffect, useMemo, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { api, type ScanFolderOut } from '../api';

interface Props {
  onClose: () => void;
  onImported: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

/**
 * 把磁盘上的邮件目录（ost2eml 导出树 / mbox / maildir）导入本机邮件库。
 * 不需要任何账户；引擎在首次导入时自动创建本地账户。
 */
export default function ImportModal({ onClose, onImported }: Props) {
  const [root, setRoot] = useState('');
  const [own, setOwn] = useState('');
  const [folders, setFolders] = useState<ScanFolderOut[] | null>(null);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<{ imported: number; doneBytes: number; totalBytes: number } | null>(null);

  // Progress and completion arrive as engine events while the import runs.
  useEffect(() => {
    if (!importing) return;
    const unProgress = listen('import-progress', (e) => {
      const p = e.payload as { imported: number; doneBytes: number; totalBytes: number };
      setProgress(p);
    });
    const unReport = listen('import-report', (e) => {
      const r = e.payload as { imported: number; alreadyPresent: number; stopped: boolean };
      setImporting(false);
      if (!r.stopped) {
        onImported();
      }
    });
    const unFailed = listen('import-failed', (e) => {
      setError(String(e.payload));
      setImporting(false);
    });
    return () => {
      unProgress.then((f) => f());
      unReport.then((f) => f());
      unFailed.then((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [importing]);

  const selectedBytes = useMemo(
    () => (folders ?? []).filter((f) => checked.has(f.index)).reduce((sum, f) => sum + f.sizeBytes, 0),
    [folders, checked],
  );

  const scan = async () => {
    setError(null);
    setScanning(true);
    setFolders(null);
    try {
      const list = await api.scanImport(root);
      setFolders(list);
      // 默认全选，但“同步问题”是 Outlook 的同步日志，没有导入价值。
      const next = new Set<number>();
      for (const f of list) {
        if (f.selectable && !f.name.includes('同步问题')) next.add(f.index);
      }
      setChecked(next);
    } catch (e) {
      setError(String(e));
    } finally {
      setScanning(false);
    }
  };

  const start = async () => {
    setError(null);
    if (checked.size === 0) {
      setError('请至少选择一个文件夹');
      return;
    }
    try {
      await api.importLocalMail(
        root,
        [...checked],
        own.split(/[,;\s]+/).filter(Boolean),
      );
      setImporting(true);
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal modal-wide">
        <h1>导入本地邮件</h1>
        <p className="form-note">
          选择一个邮件目录（每封一个 .eml、mbox 或 maildir）。邮件存入本机账户，无需登录即可浏览和操作。
        </p>
        <label className="root-path">
          邮件目录
          <div className="row">
            <input value={root} onChange={(e) => setRoot(e.target.value)} placeholder="D:\\邮件导出\\eml" />
            <button onClick={() => void scan()} disabled={scanning}>
              {scanning ? '扫描中…' : '扫描'}
            </button>
          </div>
        </label>
        <label className="root-path">
          你的发件地址（用于把已发送邮件归档；可留空）
          <input value={own} onChange={(e) => setOwn(e.target.value)} placeholder="you@example.com" />
        </label>

        {folders && (
          <div className="scan-list">
            {folders.map((f) => (
              <label key={f.index} className={`scan-item ${f.selectable ? '' : 'disabled'}`}>
                <input
                  type="checkbox"
                  disabled={!f.selectable}
                  checked={checked.has(f.index)}
                  onChange={(e) => {
                    setChecked((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) next.add(f.index);
                      else next.delete(f.index);
                      return next;
                    });
                  }}
                />
                <span className="scan-name">{f.name}</span>
                <span className="scan-size">{formatBytes(f.sizeBytes)}</span>
              </label>
            ))}
          </div>
        )}

        {importing && progress && (
          <div className="import-progress">
            已导入 {progress.imported} 封 · {formatBytes(progress.doneBytes)} / {formatBytes(progress.totalBytes)}
            <button onClick={() => api.cancelImport()}>取消</button>
          </div>
        )}

        {error && <div className="form-error">{error}</div>}

        <div className="modal-actions">
          <button onClick={onClose} disabled={importing}>
            关闭
          </button>
          <button
            className="primary"
            disabled={importing || checked.size === 0}
            onClick={() => void start()}
          >
            {importing ? '导入中…' : `导入 ${checked.size} 个文件夹（${formatBytes(selectedBytes)}）`}
          </button>
        </div>
      </div>
    </div>
  );
}
