import { Bot, Plug, User } from 'lucide-react';
import type { Actor } from '../../lib/tools/guards';
import { ACTOR_LABELS } from '../../lib/tools/guards';
import { Hint } from '../ui/misc';
import { cn } from '../../lib/cn';

/**
 * Who did it, at a glance.
 *
 * Colour carries the distinction but never alone: each actor also has its own
 * icon, so the difference survives greyscale and colour-blindness.
 */
const ACTOR_STYLE: Record<Actor, { icon: typeof Bot; className: string }> = {
  human: { icon: User, className: 'border-primary-line bg-primary-dim text-primary' },
  'demo-agent': { icon: Bot, className: 'border-agent-line bg-agent-dim text-agent' },
  'claude-agent': { icon: Bot, className: 'border-agent-line bg-agent-dim text-agent' },
  'external-mcp': { icon: Plug, className: 'border-warn-line bg-warn-dim text-warn' },
};

export function ActorBadge({ actor, className }: { actor: Actor; className?: string }) {
  const { icon: Icon, className: tone } = ACTOR_STYLE[actor];
  return (
    <Hint label={ACTOR_LABELS[actor]}>
      <span
        className={cn(
          'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-sm border',
          tone,
          className,
        )}
      >
        <Icon className="size-3" aria-hidden="true" />
        <span className="sr-only">{ACTOR_LABELS[actor]}</span>
      </span>
    </Hint>
  );
}
