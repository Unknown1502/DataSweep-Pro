import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/cn';

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 font-mono text-[10px] font-medium leading-tight [&_svg]:size-3',
  {
    variants: {
      tone: {
        neutral: 'border-line-strong bg-surface-700 text-fg-muted',
        primary: 'border-primary-line bg-primary-dim text-primary',
        agent: 'border-agent-line bg-agent-dim text-agent',
        warn: 'border-warn-line bg-warn-dim text-warn',
        danger: 'border-danger-line bg-danger-dim text-danger',
        success: 'border-success-line bg-success-dim text-success',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

export { badgeVariants };
