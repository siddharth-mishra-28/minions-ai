import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Info } from 'lucide-react';
import { cn } from './ui';

/**
 * Lightweight accessible tooltip: opens on hover (with a small delay) and on
 * keyboard focus, closes on leave/blur/Escape. The bubble is absolutely
 * positioned against the trigger — no floating-ui dependency needed.
 */
export function Tooltip({ content, label, children, side = 'top', className }: {
  content: ReactNode; label?: string; children: ReactNode; side?: 'top' | 'right' | 'bottom'; className?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = () => { if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => setOpen(true), 150); };
  const hide = () => { if (timer.current) clearTimeout(timer.current); setOpen(false); };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') hide(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  const pos = side === 'right' ? 'left-full top-1/2 ml-2 -translate-y-1/2'
    : side === 'bottom' ? 'top-full mt-2 left-1/2 -translate-x-1/2'
    : 'bottom-full mb-2 left-1/2 -translate-x-1/2';
  return (
    <span className={cn('relative inline-flex', className)} onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}>
      <span aria-describedby={open ? id : undefined} aria-label={label}>{children}</span>
      {open && (
        <span role="tooltip" id={id}
          className={cn('pointer-events-none absolute z-50 w-max max-w-xs rounded-lg border border-border bg-surface-2 px-2.5 py-1.5 text-xs leading-relaxed text-fg shadow-lg', pos)}>
          {content}
        </span>
      )}
    </span>
  );
}

/** The "i" affordance used beside form labels; copy is looked up by key. */
export function InfoTip({ content, label }: { content: ReactNode; label: string }) {
  return (
    <Tooltip content={content} side="right" className="align-middle">
      <button type="button" aria-label={`About ${label}`}
        className="inline-flex size-4 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-accent/60">
        <Info className="size-3.5" />
      </button>
    </Tooltip>
  );
}
