import { useState } from 'react';
import { Lock, Pencil } from 'lucide-react';
import { cn } from '../../lib/cn';
import { ALL_TOOLS } from '../../lib/tools';
import { Badge } from '../ui/badge';
import { Dialog, DialogContent } from '../ui/dialog';

/**
 * Every tool as an agent receives it: name, description, annotations and live
 * JSON Schema, read from the same definitions that were registered. "These are
 * real WebMCP tools" is a claim; this makes it checkable in ten seconds.
 */
export function ToolInspector({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [selected, setSelected] = useState(ALL_TOOLS[0]?.name ?? '');
  const tool = ALL_TOOLS.find((t) => t.name === selected);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Registered tools"
        description={`Published on document.modelContext · ${ALL_TOOLS.length} tools`}
        className="max-w-4xl sm:h-[min(680px,85vh)]"
      >
        <div className="flex h-full min-h-0 flex-col sm:flex-row">
          <nav
            aria-label="Tools"
            className="max-h-44 w-full shrink-0 overflow-y-auto border-b border-line p-1.5 sm:max-h-none sm:w-[240px] sm:border-r sm:border-b-0"
          >
            {ALL_TOOLS.map((t) => {
              const active = t.name === selected;
              const readOnly = t.annotations.readOnlyHint === true;
              return (
                <button
                  key={t.name}
                  type="button"
                  onClick={() => setSelected(t.name)}
                  aria-current={active ? 'true' : undefined}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left transition-colors',
                    active
                      ? 'bg-primary-dim text-fg'
                      : 'text-fg-muted hover:bg-surface-700 hover:text-fg',
                  )}
                >
                  {readOnly ? (
                    <Lock className="size-3 shrink-0 text-fg-subtle" aria-hidden="true" />
                  ) : (
                    <Pencil className="size-3 shrink-0 text-warn" aria-hidden="true" />
                  )}
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{t.name}</span>
                </button>
              );
            })}
          </nav>

          <div className="min-w-0 flex-1 overflow-y-auto p-4">
            {tool && (
              <>
                <h3 className="font-mono text-[14px] text-fg">{tool.name}</h3>
                <p className="mt-2 max-w-[70ch] text-[13px] leading-relaxed text-fg-muted">
                  {tool.description}
                </p>

                <div className="mt-4 flex flex-wrap gap-1.5">
                  {Object.entries(tool.annotations).map(([key, value]) => (
                    <Badge
                      key={key}
                      tone={
                        !value
                          ? 'neutral'
                          : key === 'untrustedContentHint' || key === 'destructiveHint'
                            ? 'warn'
                            : 'primary'
                      }
                    >
                      {key}: {String(value)}
                    </Badge>
                  ))}
                </div>

                <div className="eyebrow mt-5 mb-2">Input schema</div>
                <pre className="grid-scroll rounded-md border border-line bg-shell-900 p-3 font-mono text-[11px] leading-relaxed text-fg-muted">
                  {JSON.stringify(tool.inputSchema, null, 2)}
                </pre>
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
