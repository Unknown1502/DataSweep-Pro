import * as React from 'react';
import * as SeparatorPrimitive from '@radix-ui/react-separator';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/cn';

// --- Separator ---------------------------------------------------------------

export const Separator = React.forwardRef<
  React.ComponentRef<typeof SeparatorPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SeparatorPrimitive.Root>
>(({ className, orientation = 'horizontal', decorative = true, ...props }, ref) => (
  <SeparatorPrimitive.Root
    ref={ref}
    decorative={decorative}
    orientation={orientation}
    className={cn(
      'shrink-0 bg-line',
      orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px',
      className,
    )}
    {...props}
  />
));
Separator.displayName = 'Separator';

// --- Tooltip -----------------------------------------------------------------

export const TooltipProvider = TooltipPrimitive.Provider;
export const TooltipRoot = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

export const TooltipContent = React.forwardRef<
  React.ComponentRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 6, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        'z-50 max-w-xs rounded-sm border border-line-strong bg-surface-700 px-2 py-1.5 text-[12px] leading-relaxed text-fg shadow-lg',
        className,
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
));
TooltipContent.displayName = 'TooltipContent';

/** A tooltip in one element, for the common case. */
export function Hint({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <TooltipRoot>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </TooltipRoot>
  );
}

// --- Alert -------------------------------------------------------------------

const alertVariants = cva(
  'flex items-start gap-2.5 rounded-md border px-3 py-2.5 text-[13px] leading-relaxed [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0',
  {
    variants: {
      tone: {
        neutral: 'border-line bg-surface-700 text-fg-muted [&>svg]:text-fg-subtle',
        info: 'border-primary-line bg-primary-dim text-fg [&>svg]:text-primary',
        agent: 'border-agent-line bg-agent-dim text-fg [&>svg]:text-agent',
        warn: 'border-warn-line bg-warn-dim text-fg [&>svg]:text-warn',
        danger: 'border-danger-line bg-danger-dim text-fg [&>svg]:text-danger',
        success: 'border-success-line bg-success-dim text-fg [&>svg]:text-success',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export interface AlertProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof alertVariants> {}

export function Alert({ className, tone, ...props }: AlertProps) {
  return <div role="alert" className={cn(alertVariants({ tone }), className)} {...props} />;
}

// --- Skeleton ----------------------------------------------------------------

export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('animate-pulse rounded-sm bg-surface-700', className)}
      {...props}
    />
  );
}

// --- Form controls -----------------------------------------------------------

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        'h-8 w-full rounded-sm border border-line-strong bg-shell-900 px-2.5 text-[13px] text-fg',
        'placeholder:text-fg-subtle disabled:opacity-45',
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';

export const Label = React.forwardRef<
  HTMLLabelElement,
  React.LabelHTMLAttributes<HTMLLabelElement>
>(({ className, ...props }, ref) => (
  <label ref={ref} className={cn('eyebrow block', className)} {...props} />
));
Label.displayName = 'Label';

/**
 * A native select, styled to match.
 *
 * Radix Select adds a portal, typeahead and virtual focus that a short list of
 * plain options does not need, and the native control is better on mobile.
 */
export const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(({ className, ...props }, ref) => (
  <select
    ref={ref}
    className={cn(
      'h-8 rounded-sm border border-line-strong bg-surface-700 px-2 text-[13px] text-fg disabled:opacity-45',
      className,
    )}
    {...props}
  />
));
Select.displayName = 'Select';

// --- Gauge -------------------------------------------------------------------

/**
 * The segmented gauge.
 *
 * A smooth bar is the shape of an estimate, and this product's whole argument
 * is that its figures are measured. Discrete segments read as counted units,
 * which is what a quality score out of 100 actually is.
 *
 * `baseline` marks where the score stood at the first scan, so the bar shows
 * the movement rather than only where it landed. It is omitted when there is
 * nothing real to mark.
 *
 * The number is always printed alongside, so the gauge is never the sole
 * carrier of the value — which is what lets its segments disappear safely under
 * forced colors.
 */
export function Gauge({
  value,
  max = 100,
  tone = 'primary',
  baseline,
  className,
  label,
}: {
  value: number;
  max?: number;
  tone?: 'primary' | 'success' | 'warn' | 'danger';
  /** Where this figure started, if it is known. */
  baseline?: number;
  className?: string;
  label?: string;
}) {
  const clamp = (n: number) => Math.min(100, Math.max(0, (n / max) * 100));
  const pct = max === 0 ? 0 : clamp(value);
  const fill = {
    primary: 'var(--color-primary)',
    success: 'var(--color-success)',
    warn: 'var(--color-warn)',
    danger: 'var(--color-danger)',
  }[tone];

  // Only set --gauge-mark when a baseline exists and actually differs; the
  // marker's CSS rule keys off the property being present at all.
  const showMark = baseline !== undefined && Math.round(clamp(baseline)) !== Math.round(pct);

  return (
    <div
      role="meter"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-label={label}
      className={cn('gauge', className)}
      style={{ '--gauge-value': pct, '--gauge-fill': fill } as React.CSSProperties}
    >
      <span className="gauge-segments" />
      {showMark && (
        <span
          className="gauge-mark"
          style={{ '--gauge-mark': clamp(baseline) } as React.CSSProperties}
        />
      )}
    </div>
  );
}

// --- Stat --------------------------------------------------------------------

/**
 * A labelled number. Used wherever the product reports a measured figure.
 *
 * `hero` is for the one figure a panel is actually about. Without it every
 * number on the Overview carried identical weight, so the quality score — the
 * thing the panel exists to report — had to be found rather than seen.
 */
export function Stat({
  label,
  value,
  suffix,
  tone,
  hint,
  size = 'default',
}: {
  label: string;
  value: string | number;
  suffix?: string;
  tone?: 'default' | 'success' | 'warn' | 'danger';
  hint?: string;
  size?: 'default' | 'hero';
}) {
  const color =
    tone === 'success'
      ? 'text-success'
      : tone === 'warn'
        ? 'text-warn'
        : tone === 'danger'
          ? 'text-danger'
          : 'text-fg';

  return (
    <div>
      <div className="eyebrow" title={hint}>
        {label}
      </div>
      <div
        className={cn(
          'mt-0.5 font-display leading-none font-bold tabular-nums',
          size === 'hero' ? 'text-[40px] tracking-[-0.02em]' : 'text-[20px]',
          color,
        )}
      >
        {value}
        {suffix && (
          <span
            className={cn(
              'ml-0.5 font-normal text-fg-subtle',
              size === 'hero' ? 'text-[15px]' : 'text-[12px]',
            )}
          >
            {suffix}
          </span>
        )}
      </div>
    </div>
  );
}
