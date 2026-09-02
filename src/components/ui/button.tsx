import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/cn';

/**
 * Variants carry meaning, not decoration.
 *
 * `primary` is the action you are expected to take. `danger` is reserved for
 * changes that destroy or overwrite. Everything else is neutral, so a screen
 * full of buttons still tells you where to look.
 */
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-sm font-medium transition-colors ' +
    'disabled:pointer-events-none disabled:opacity-45 [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default:
          'border border-line-strong bg-surface-700 text-fg hover:bg-surface-600 hover:border-[var(--color-line-strong)]',
        primary:
          'bg-primary text-primary-fg font-semibold hover:bg-primary-hover',
        danger: 'bg-danger text-white font-semibold hover:bg-danger-hover',
        outline: 'border border-line bg-transparent text-fg-muted hover:bg-surface-700 hover:text-fg',
        ghost: 'text-fg-muted hover:bg-surface-700 hover:text-fg',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        sm: 'h-7 px-2.5 text-[12px] [&_svg]:size-3.5',
        md: 'h-8 px-3 text-[13px] [&_svg]:size-4',
        lg: 'h-10 px-4 text-[14px] [&_svg]:size-4',
        icon: 'h-8 w-8 [&_svg]:size-4',
        'icon-sm': 'h-7 w-7 [&_svg]:size-3.5',
      },
    },
    defaultVariants: { variant: 'default', size: 'md' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, type, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        ref={ref}
        // Explicit type: a bare <button> inside a form submits it, which has
        // caused a full page reload in more products than anyone admits.
        {...(asChild ? {} : { type: type ?? 'button' })}
        className={cn(buttonVariants({ variant, size }), className)}
        {...props}
      />
    );
  },
);
Button.displayName = 'Button';

export { buttonVariants };
