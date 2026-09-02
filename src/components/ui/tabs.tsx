import * as React from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import { cn } from '../../lib/cn';

export const Tabs = TabsPrimitive.Root;

export const TabsList = React.forwardRef<
  React.ComponentRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn('flex items-center gap-1 overflow-x-auto border-b border-line', className)}
    {...props}
  />
));
TabsList.displayName = 'TabsList';

export const TabsTrigger = React.forwardRef<
  React.ComponentRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      'relative flex shrink-0 items-center gap-1.5 px-3 py-2 text-[13px] font-medium whitespace-nowrap',
      'text-fg-subtle transition-colors hover:text-fg-muted',
      'disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-3.5',
      // The active marker is a rule, not only a colour, so the current tab is
      // identifiable without relying on hue.
      'data-[state=active]:text-fg',
      'after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full',
      'data-[state=active]:after:bg-primary',
      className,
    )}
    {...props}
  />
));
TabsTrigger.displayName = 'TabsTrigger';

export const TabsContent = React.forwardRef<
  React.ComponentRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content ref={ref} className={cn('outline-none', className)} {...props} />
));
TabsContent.displayName = 'TabsContent';
