import { useEffect, useId, useRef, type ReactNode } from 'react';

/**
 * An accessible dialog.
 *
 * The hand-rolled overlays this replaces were a genuine WCAG failure, not a
 * cosmetic one: Tab walked straight out of the dialog into the page behind it,
 * screen readers were never told a dialog had opened, Escape did nothing, and
 * focus was dropped on the floor when the dialog closed. Each of those is a
 * blocker for someone navigating by keyboard.
 *
 * Implemented directly rather than by pulling in a component library, because
 * the behaviour is well-specified and small, and a library would also bring a
 * default visual language that would flatten this app's own.
 */

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export interface ModalProps {
  readonly title: string;
  readonly subtitle?: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
  /** Tailwind max-width class. */
  readonly width?: string;
  /** Fixed height for panels that scroll internally. */
  readonly height?: string;
}

export function Modal({
  title,
  subtitle,
  onClose,
  children,
  footer,
  width = 'max-w-3xl',
  height,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const subtitleId = useId();

  useEffect(() => {
    // Remember where focus was so it can be handed back on close. Without this
    // a keyboard user is dumped at the top of the document every time.
    const previouslyFocused = document.activeElement as HTMLElement | null;

    const panel = panelRef.current;
    const first = panel?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel)?.focus();

    // The page behind must not scroll while a modal is open.
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }

      if (event.key !== 'Tab' || !panel) return;

      const focusable = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (el) => el.offsetParent !== null,
      );
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }

      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;

      // Wrap at both ends, so Tab can never reach the page behind the dialog.
      if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && (active === first || active === panel)) {
        event.preventDefault();
        last.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.body.style.overflow = originalOverflow;
      previouslyFocused?.focus?.();
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/80 p-4 sm:p-6"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={subtitle ? subtitleId : undefined}
        tabIndex={-1}
        className={`panel flex w-full flex-col outline-none ${width} ${height ?? 'max-h-[88vh]'}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between gap-4 border-b border-ink-600 px-4 py-3">
          <div className="min-w-0">
            <h2 id={titleId} className="eyebrow">
              {title}
            </h2>
            {subtitle && (
              <p id={subtitleId} className="mt-0.5 font-mono text-[10px] text-text-lo">
                {subtitle}
              </p>
            )}
          </div>
          <button className="btn shrink-0" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>

        {footer && (
          <div className="shrink-0 border-t border-ink-600 px-4 py-2.5">{footer}</div>
        )}
      </div>
    </div>
  );
}
