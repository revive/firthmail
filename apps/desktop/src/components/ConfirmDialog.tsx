import { useEffect } from 'react';

interface Props {
  title: string;
  message: string;
  confirmLabel: string;
  /** Red confirm button: the action throws mail away. */
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** A small yes/no dialog for destructive actions; Esc cancels. */
export default function ConfirmDialog({
  title,
  message,
  confirmLabel,
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
}: Props) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={title}>
      <div className="modal modal-confirm">
        <h1>{title}</h1>
        <p className="confirm-message">{message}</p>
        <div className="modal-actions">
          <button onClick={onCancel} disabled={busy} autoFocus>
            取消
          </button>
          <button
            className={danger ? 'primary danger' : 'primary'}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? '处理中…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
