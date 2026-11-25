import { useEffect, useRef } from 'react';

export interface ContextMenuItem {
  label: string;
  shortcut?: string;
  /** Red label: the action throws mail away. */
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

interface Props {
  /** Where the pointer was, in viewport coordinates. */
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

/** A right-click menu: closes on an outside click, Escape, or a chosen item. */
export default function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  // 贴着窗口边缘右键时别让菜单跑出可见范围。
  const width = 196;
  const height = items.length * 30 + 8;
  const left = Math.max(4, Math.min(x, window.innerWidth - width - 4));
  const top = Math.max(4, Math.min(y, window.innerHeight - height - 4));

  return (
    <div ref={ref} className="context-menu" style={{ left, top }} role="menu">
      {items.map((item) => (
        <button
          key={item.label}
          role="menuitem"
          className={item.danger ? 'danger' : undefined}
          disabled={item.disabled}
          onClick={() => {
            item.onSelect();
            onClose();
          }}
        >
          <span>{item.label}</span>
          {item.shortcut && <em>{item.shortcut}</em>}
        </button>
      ))}
    </div>
  );
}
