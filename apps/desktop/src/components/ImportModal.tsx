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
 *
 * 也可以直接选 Outlook 的 .ost/.pst：内置的 ost2eml 先转成 EML 树再导入。
 * 两条路都默认按 Message-ID 跳过本机已有的邮件——同一账户已经从 IMAP
 * 同步过的邮件不会变成第二份。
 */
export default function ImportModal({ onClose, onImported }: Props) {
  const [root, setRoot] = useState('');
  const [own, setOwn] = useState('');
  const [folders, setFolders] = useState<ScanFolderOut[] | null>(null);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [skipExisting, setSkipExisting] = useState(true);
  const [progress, setProgress] = useState<{ imported: number; doneBytes: number; totalBytes: number } | null>(null);
  const [outlookPath, setOutlookPath] = useState('');
  const [outlookPhase, setOutlookPhase] = useState<'idle' | 'converting' | 'importing'>('idle');

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
      setOutlookPhase('idle');
      if (!r.stopped) {
        onImported();
      }
    });
    const unFailed = listen('import-failed', (e) => {
      setError(String(e.payload));
      setImporting(false);
      setOutlookPhase('idle');
    });
    const unOutlook = listen('outlook-progress', (e) => {
      const p = e.payload as { phase: 'converting' | 'importing' };
      setOutlookPhase(p.phase);
    });
    return () => {
      unProgress.then((f) => f());
      unReport.then((f) => f());
      unFailed.then((f) => f());
      unOutlook.then((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [importing]);

  const selectedBytes = useMemo(
    () => (folders ?? []).filter((f) => checked.has(f.index)).reduce((sum, f) => sum + f.sizeBytes, 0),
    [folders, checked],
  );

  const ownAddresses = () => own.split(/[,;\s]+/).filter(Boolean);

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
      await api.importLocalMail(root, [...checked], ownAddresses(), skipExisting);
      setImporting(true);
    } catch (e) {
      setError(String(e));
    }
  };

  const startOutlook = async () => {
    setError(null);
    if (!outlookPath.trim()) {
      setError('请填写 .ost/.pst 文件路径');
      return;
    }
    try {
      await api.importOutlookFile(outlookPath.trim(), ownAddresses());
      setImporting(true);
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal modal-wide modal-setup">
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
        <label className="check-row">
          <input
            type="checkbox"
            checked={skipExisting}
            onChange={(e) => setSkipExisting(e.target.checked)}
          />
          跳过本机已有的邮件（按 Message-ID；同一账户已同步过的不再重复导入）
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
            {outlookPhase === 'converting'
              ? '正在转换 Outlook 数据文件…'
              : `已导入 ${progress.imported} 封 · ${formatBytes(progress.doneBytes)} / ${formatBytes(progress.totalBytes)}`}
            <button onClick={() => api.cancelImport()}>取消</button>
          </div>
        )}
        {importing && outlookPhase !== 'idle' && !progress && (
          <div className="import-progress">正在转换 Outlook 数据文件（16 GB 的 OST 大约需要十分钟）…</div>
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

        <section className="outlook-import">
          <h2>直接导入 Outlook 数据文件（.ost / .pst）</h2>
          <p className="form-note">
            用内置的 ost2eml 先转成 EML 树，再按上面的规则导入并去重。转换结果放在缓存目录，导入完成后自动删除。
          </p>
          <div className="row">
            <input
              value={outlookPath}
              onChange={(e) => setOutlookPath(e.target.value)}
              placeholder="C:\\Users\\<你>\\AppData\\Local\\Microsoft\\Outlook\\<账户>.ost"
              spellCheck={false}
            />
            <button className="primary" disabled={importing} onClick={() => void startOutlook()}>
              {outlookPhase === 'converting' ? '转换中…' : '转换并导入'}
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
