import { useCallback, useEffect, useMemo, useState } from 'react';
import { RegisterTools } from './components/RegisterTools';
import { TopBar } from './components/TopBar';
import { LedgerRail } from './components/LedgerRail';
import { Workspace } from './components/Workspace';
import { AgentPanel } from './components/AgentPanel';
import { ShortcutsHelp } from './components/ShortcutsHelp';
import { useKeyboardShortcuts, type Shortcut } from './hooks/useKeyboardShortcuts';
import { audit } from './lib/tools/context';
import { callTool } from './lib/tools';
import { useApp, useSelectedDataset } from './store/app-store';

export function App() {
  const status = useApp((s) => s.status);
  const bootError = useApp((s) => s.bootError);
  const boot = useApp((s) => s.boot);
  const [agentOpen, setAgentOpen] = useState(true);
  const [helpOpen, setHelpOpen] = useState(false);

  const dataset = useSelectedDataset();
  const refresh = useApp((s) => s.refresh);
  const setActionError = useApp((s) => s.setActionError);

  /**
   * Move the head pointer one step. Undo and redo are the same operation in
   * opposite directions, because history is a list and the head is an index.
   */
  const step = useCallback(
    async (delta: -1 | 1) => {
      if (!dataset) return;
      const target = dataset.history[dataset.headIndex + delta];
      if (!target) return;

      setActionError(null);
      try {
        const args = { dataset_id: dataset.id, checkpoint_id: target.id };
        const preview = (await callTool('undo_to_checkpoint', args)) as {
          confirmation_token: string;
        };
        await callTool('undo_to_checkpoint', {
          ...args,
          confirmation_token: preview.confirmation_token,
        });
        refresh();
      } catch (error) {
        setActionError(error instanceof Error ? error.message : String(error));
      }
    },
    [dataset, refresh, setActionError],
  );

  const shortcuts = useMemo<Shortcut[]>(
    () => [
      {
        key: 'z',
        meta: true,
        shift: false,
        label: 'Undo',
        description: 'Step back one checkpoint',
        enabled: !!dataset && dataset.headIndex > 0,
        run: () => void step(-1),
      },
      {
        key: 'z',
        meta: true,
        shift: true,
        label: 'Redo',
        description: 'Step forward again',
        enabled: !!dataset && dataset.headIndex < dataset.history.length - 1,
        run: () => void step(1),
      },
      {
        key: 'a',
        meta: true,
        shift: true,
        label: 'Agent panel',
        description: 'Show or hide the agent',
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
    [dataset, step],
  );

  useKeyboardShortcuts(shortcuts);

  useEffect(() => {
    void boot();
  }, [boot]);

  // Every tool call, agent- or human-initiated, lands in the same ledger.
  // Owned by an effect with cleanup so a remount replaces the subscription
  // rather than stacking another one on top of it.
  useEffect(() => {
    const { pushActivity } = useApp.getState();
    for (const entry of audit.entries()) pushActivity(entry);
    return audit.subscribe(pushActivity);
  }, []);

  if (status === 'failed') {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="panel max-w-lg p-6">
          <div className="eyebrow mb-2 text-alarm">Engine failed to start</div>
          <p className="mb-3 text-text-hi">
            DuckDB could not be loaded, so no data can be processed.
          </p>
          <p className="mb-4 font-mono text-xs text-text-mid">{bootError}</p>
          <button className="btn" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Registration happens as soon as React mounts, independent of what the
          user has loaded — an agent can connect to an empty page and discover
          the tool surface. */}
      <RegisterTools />

      <TopBar onOpenAgent={() => setAgentOpen(true)} agentOpen={agentOpen} />

      <div className="flex min-h-0 flex-1">
        <LedgerRail />
        <main className="contain-pane min-w-0 flex-1 overflow-y-auto">
          {status === 'booting' ? <Booting /> : <Workspace />}
        </main>
        {agentOpen && status === 'ready' && <AgentPanel onClose={() => setAgentOpen(false)} />}
      </div>

      {helpOpen && <ShortcutsHelp shortcuts={shortcuts} onClose={() => setHelpOpen(false)} />}
    </div>
  );
}

function Booting() {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="text-center">
        <div className="mb-3 font-mono text-xs tracking-[0.2em] text-text-lo uppercase">
          Starting DuckDB
        </div>
        <div className="mx-auto h-px w-40 overflow-hidden bg-ink-600">
          <div className="h-full w-1/3 animate-[slide_1.1s_ease-in-out_infinite] bg-now" />
        </div>
        <style>{`@keyframes slide{0%{transform:translateX(-100%)}100%{transform:translateX(300%)}}`}</style>
      </div>
    </div>
  );
}
