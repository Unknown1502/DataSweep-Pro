import { useState } from 'react';
import { ChevronRight, FolderOpen, Menu, Bot, Plug } from 'lucide-react';
import { Button } from '../ui/button';
import { Hint, Separator } from '../ui/misc';
import { ToolInspector } from '../panels/ToolInspector';
import { ThemeToggle } from './ThemeToggle';
import { useApp, useSelectedDataset } from '../../store/app-store';

/**
 * The application bar.
 *
 * "WebMCP live" used to look like a call to action; it is a system-status
 * indicator and is now styled as one — a dot and a word, at the far edge, where
 * status belongs.
 */
export function TopBar({
  onOpenAgent,
  agentOpen,
  onToggleNav,
}: {
  onOpenAgent: () => void;
  agentOpen: boolean;
  onToggleNav: () => void;
}) {
  const [inspecting, setInspecting] = useState(false);
  const dataset = useSelectedDataset();
  const selectedId = useApp((s) => s.selectedId);
  const select = useApp((s) => s.select);
  const status = useApp((s) => s.status);

  const ready = status === 'ready';

  return (
    <>
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-shell-800 px-3 sm:px-4">
        <Button
          variant="ghost"
          size="icon"
          className="lg:hidden"
          onClick={onToggleNav}
          aria-label="Toggle navigation"
        >
          <Menu />
        </Button>

        <div className="flex items-baseline gap-1.5">
          <span className="font-display text-[16px] leading-none font-extrabold tracking-tight text-fg">
            DataSweep
          </span>
          <span className="rounded-[3px] border border-primary-line bg-primary-dim px-1 font-mono text-[9px] tracking-[0.12em] text-primary uppercase">
            Pro
          </span>
        </div>

        {/* Breadcrumb: where you are, and a route back. */}
        <nav aria-label="Breadcrumb" className="hidden min-w-0 items-center gap-1 sm:flex">
          <ChevronRight className="size-3.5 shrink-0 text-fg-subtle" aria-hidden="true" />
          <button
            type="button"
            onClick={() => select(null)}
            className={
              selectedId
                ? 'rounded-sm px-1.5 py-0.5 text-[13px] text-fg-muted transition-colors hover:bg-surface-700 hover:text-fg'
                : 'px-1.5 py-0.5 text-[13px] font-medium text-fg'
            }
            aria-current={selectedId ? undefined : 'page'}
          >
            Files
          </button>
          {dataset && (
            <>
              <ChevronRight className="size-3.5 shrink-0 text-fg-subtle" aria-hidden="true" />
              <span
                className="max-w-[26ch] truncate px-1.5 text-[13px] font-medium text-fg"
                aria-current="page"
              >
                {dataset.name}
              </span>
            </>
          )}
        </nav>

        <div className="flex-1" />

        {/* Compact workspace status. */}
        <div className="hidden items-center gap-2 md:flex">
          <span
            aria-hidden="true"
            className={
              ready
                ? 'size-1.5 rounded-full bg-success'
                : 'size-1.5 rounded-full bg-fg-subtle'
            }
          />
          <span className="font-mono text-[11px] text-fg-subtle">
            Local workspace ·{' '}
            <span className="text-fg-muted">
              {dataset ? dataset.name : 'nothing loaded'}
            </span>
          </span>
        </div>

        <Separator orientation="vertical" className="hidden h-5 md:block" />

        {selectedId && (
          <Hint label="Back to files — Ctrl/Cmd+O">
            <Button variant="ghost" size="sm" onClick={() => select(null)}>
              <FolderOpen />
              <span className="hidden sm:inline">Files</span>
            </Button>
          </Hint>
        )}

        {!agentOpen && (
          <Button variant="ghost" size="sm" onClick={onOpenAgent}>
            <Bot />
            <span className="hidden sm:inline">Agent</span>
          </Button>
        )}

        <ThemeToggle />

        <Button variant="outline" size="sm" onClick={() => setInspecting(true)}>
          <span className="hidden sm:inline">Tool inspector</span>
          <span className="sm:hidden">Tools</span>
        </Button>

        <Hint label={ready ? 'Tools are published on document.modelContext' : 'Starting up'}>
          <span className="flex items-center gap-1.5 rounded-sm border border-line px-2 py-1 font-mono text-[10px] text-fg-subtle">
            <Plug className={ready ? 'size-3 text-success' : 'size-3 text-fg-subtle'} />
            <span className="hidden lg:inline">WebMCP</span>
          </span>
        </Hint>
      </header>

      {inspecting && <ToolInspector open onOpenChange={setInspecting} />}
    </>
  );
}
