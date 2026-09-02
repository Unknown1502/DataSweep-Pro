import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '../../lib/cn';

/**
 * Dialog and Sheet, both on Radix.
 *
 * Radix supplies focus trap, focus restore, Escape, scroll lock and the ARIA
 * wiring. A title is always rendered — visually hidden if the caller asks —
 * because a dialog without an accessible name is announced as nothing at all.
 */
export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

const Overlay = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn('fixed inset-0 z-50 bg-shell-900/80', className)}
    {...props}
  />
));
Overlay.displayName = 'DialogOverlay';
export { Overlay as DialogOverlay };

export interface DialogContentProps
  extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  title: string;
  description?: React.ReactNode;
  /** Hide the header row; the title stays exposed to assistive tech. */
  hideHeader?: boolean;
  footer?: React.ReactNode;
  /** 'center' for a dialog, 'right' or 'bottom' for a sheet. */
  side?: 'center' | 'right' | 'bottom';
}

const SIDE_CLASSES = {
  center:
    'left-1/2 top-1/2 max-h-[88vh] w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-lg border',
  right: 'inset-y-0 right-0 h-full w-[min(460px,100vw)] border-l',
  bottom: 'inset-x-0 bottom-0 max-h-[85vh] w-full rounded-t-lg border-t',
} as const;

export const DialogContent = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Content>,
  DialogContentProps
>(function DialogContent(
  { className, children, title, description, hideHeader, footer, side = 'center', ...props },
  ref,
) {
  return (
    <DialogPrimitive.Portal>
      <Overlay />
      <DialogPrimitive.Content
        ref={ref}
        // Radix traps focus and makes the background pointer-inert, but in this
        // version it does not mark outside content aria-hidden, so a screen
        // reader's virtual cursor could still wander behind the dialog.
        // Declaring aria-modal closes that gap whichever mechanism Radix uses.
        aria-modal="true"
        className={cn(
          'fixed z-50 flex flex-col border-line bg-surface-800 shadow-2xl outline-none',
          SIDE_CLASSES[side],
          className,
        )}
        {...props}
      >
        {hideHeader ? (
          <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
        ) : (
          <div className="flex shrink-0 items-start justify-between gap-4 border-b border-line px-4 py-3">
            <div className="min-w-0">
              <DialogPrimitive.Title className="eyebrow">{title}</DialogPrimitive.Title>
              {description && (
                <DialogPrimitive.Description className="mt-1 text-[12px] leading-relaxed text-fg-muted">
                  {description}
                </DialogPrimitive.Description>
              )}
            </div>
            <DialogPrimitive.Close
              className="rounded-sm p-1 text-fg-subtle transition-colors hover:bg-surface-700 hover:text-fg"
              aria-label="Close"
            >
              <X className="size-4" />
            </DialogPrimitive.Close>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>

        {footer && <div className="shrink-0 border-t border-line px-4 py-3">{footer}</div>}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
});
