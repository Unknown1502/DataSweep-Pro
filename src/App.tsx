import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { RegisterTools } from './components/RegisterTools';
import { TopBar } from './components/shell/TopBar';
import { NavRail } from './components/shell/NavRail';
import { AgentRail } from './components/shell/AgentRail';
import { ShortcutsHelp } from './components/shell/ShortcutsHelp';
import { FilesScreen } from './components/screens/FilesScreen';
import { DatasetWorkspace } from './components/screens/DatasetWorkspace';
import { Alert, Skeleton, TooltipProvider } from './components/ui/misc';
import { Button } from './components/ui/button';
import { useKeyboardShortcuts, type Shortcut } from './hooks/useKeyboardShortcuts';
import { useTimeTravel } from './hooks/useTimeTravel';
import { audit } from './lib/tools/context';
import { useApp } from './store/app-store';

export function App() {
  const status = useApp((s) => s.status);
  const bootError = useApp((s) => s.bootError);
  const boot = useApp((s) => s.boot);
  const selectedId = useApp((s) => s.selectedId);
  const select = useApp((s) => s.select);

  const [agentOpen, setAgentOpen] = useState(
    // Open by default only where it sits beside the workspace. Below xl it is a
    // full-screen overlay, so defaulting it open would put a phone user on the
    // agent with the data they came to look at hidden behind it.
    () => typeof window === 'undefined' || window.innerWidth >= 1280,
  );
  const [helpOpen, setHelpOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);

  const { step, canUndo, canRedo } = useTimeTravel();

  useEffect(() => {
    void boot();
  }, [boot]);

  /**
   * Every tool call, agent- or human-initiated, lands in the same ledger.
   * Owned by an effect with cleanup so a remount replaces the subscription
   * rather than stacking another one on top of it.
   */
  useEffect(() => {
    const { pushActivity } = useApp.getState();
    for (const entry of audit.entries()) pushActivity(entry);
    return audit.subscribe(pushActivity);
  }, []);

  /**
   * The URL hash is the source of truth for which dataset is open, so Back and
   * Forward work. The effect pushes only when the hash disagrees with state, so
   * a selection driven by popstate finds the hash already correct and does not
   * push again — without that check, Back would immediately push forward again
   * and the button would look broken.
   */
  useEffect(() => {
    const target = selectedId ? `#${selectedId}` : '';
    if (window.location.hash === target) return;
    window.history.pushState(null, '', target || window.location.pathname);
  }, [selectedId]);

  useEffect(() => {
    function onPopState() {
      const id = window.location.hash.replace(/^#/, '');
      const { datasets, select: choose } = useApp.getState();
      choose(id && datasets.some((d) => d.id === id) ? id : null);
    }
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const openFiles = useCallback(() => select(null), [select]);

  const shortcuts = useMemo<Shortcut[]>(
    () => [
      {
        key: 'z',
        meta: true,
        shift: false,
        label: 'Undo',
        description: 'Step back one checkpoint',
        enabled: canUndo,
        run: () => void step(-1),
      },
      {
        key: 'z',
        meta: true,
        shift: true,
        label: 'Redo',
        description: 'Step forward again',
        enabled: canRedo,
        run: () => void step(1),
      },
      {
        key: 'o',
        meta: true,
        label: 'Open a file',
        description: 'Back to the file screen',
        enabled: !!selectedId,
        run: openFiles,
      },
      {
        key: 'a',
        meta: true,
        shift: true,
        label: 'Agent panel',
        description: 'Show or hide agent activity',
        run: () => setAgentOpen((open) => !open),
      },
      {
        key: '?',
        label: 'This list',
        description: 'Show keyboard shortcuts',
        run: () => setHelpOpen(true),
      },
      {
        key: 'escape',
        label: 'Dismiss',
        description: 'Close the shortcut list',
        run: () => setHelpOpen(false),
      },
    ],
    [canUndo, canRedo, selectedId, step, openFiles],
  );

  useKeyboardShortcuts(shortcuts);

  if (status === 'failed') {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-lg space-y-3">
          <Alert tone="danger">
            <AlertTriangle />
            <span>
              <strong>The data engine failed to start.</strong> DuckDB could not be loaded, so no
              data can be processed.
            </span>
          </Alert>
          <p className="font-mono text-[12px] text-fg-subtle">{bootError}</p>
          <Button variant="primary" onClick={() => window.location.reload()}>
            Reload
          </Button>
        </div>
      </div>
    );
  }

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex h-full flex-col">
        {/* Registration happens as soon as React mounts, independent of what is
            loaded — an agent can connect to an empty page and discover the tool
            surface. */}
        <RegisterTools />

        <TopBar
          onOpenAgent={() => setAgentOpen(true)}
          agentOpen={agentOpen}
          onToggleNav={() => setNavOpen((o) => !o)}
        />

        <div className="flex min-h-0 flex-1">
          <NavRail open={navOpen} onClose={() => setNavOpen(false)} />

          <main className="contain-pane min-w-0 flex-1 overflow-y-auto bg-surface-900">
            {status === 'booting' ? (
              <BootingSkeleton />
            ) : selectedId ? (
              <DatasetWorkspace />
            ) : (
              <FilesScreen />
            )}
          </main>

          {agentOpen && status === 'ready' && <AgentRail onClose={() => setAgentOpen(false)} />}
        </div>

        <ShortcutsHelp shortcuts={shortcuts} open={helpOpen} onOpenChange={setHelpOpen} />
      </div>
    </TooltipProvider>
  );
}

/** Shaped like the file screen, so the shell does not jump when it arrives. */
function BootingSkeleton() {
  return (
    <div className="mx-auto w-full max-w-7xl px-5 py-6" aria-busy="true" aria-label="Starting">
      <Skeleton className="h-4 w-24" />
      <Skeleton className="mt-3 h-7 w-72" />
      <Skeleton className="mt-3 h-4 w-[46ch]" />
      <Skeleton className="mt-6 h-36 w-full" />
      <div className="mt-5 grid gap-2.5 sm:grid-cols-2">
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
      </div>
    </div>
  );
}
