import { useCallback, useRef, useState } from 'react';
import { createClaudeAgent } from '../lib/agent/claude-agent';
import { demoAgent } from '../lib/agent/demo-agent';
import type { AgentEvent, AgentRun } from '../lib/agent/types';
import { useApp, useSelectedDataset } from '../store/app-store';

interface Entry {
  id: number;
  event: AgentEvent;
}

/**
 * The agent conversation.
 *
 * Approval is rendered inline in the transcript rather than as a modal: the
 * decision belongs next to the reasoning that led to it, and a modal would
 * hide the tool calls the user is being asked to judge.
 */
export function AgentPanel({ onClose }: { onClose: () => void }) {
  const dataset = useSelectedDataset();
  const refresh = useApp((s) => s.refresh);

  const [entries, setEntries] = useState<Entry[]>([]);
  const [running, setRunning] = useState(false);
  const [awaiting, setAwaiting] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [mode, setMode] = useState<'demo' | 'claude'>('demo');

  const runRef = useRef<AgentRun | null>(null);
  const counter = useRef(0);

  const push = useCallback((event: AgentEvent) => {
    counter.current += 1;
    setEntries((prev) => [...prev, { id: counter.current, event }]);
  }, []);

  /** Pump the generator until it needs a decision or finishes. */
  const pump = useCallback(
    async (run: AgentRun, decision?: boolean) => {
      let input = decision;
      for (;;) {
        const { value, done } = await run.next(input);
        input = undefined;
        if (done || !value) {
          setRunning(false);
          setAwaiting(false);
          refresh();
          return;
        }

        push(value);

        if (value.type === 'approve') {
          setAwaiting(true);
          return;
        }
        if (value.type === 'done' || value.type === 'error') {
          setRunning(false);
          setAwaiting(false);
          refresh();
          return;
        }
        if (value.type === 'result') refresh();
      }
    },
    [push, refresh],
  );

  async function start() {
    if (!dataset) return;
    setEntries([]);
    counter.current = 0;
    setRunning(true);

    const agent = mode === 'claude' ? createClaudeAgent(apiKey.trim()) : demoAgent;
    const run = agent.run(dataset.id);
    runRef.current = run;
    await pump(run);
  }

  async function decide(approved: boolean) {
    if (!runRef.current) return;
    setAwaiting(false);
    await pump(runRef.current, approved);
  }

  const canStart =
    !!dataset && !running && (mode === 'demo' || apiKey.trim().startsWith('sk-ant-'));

  return (
    <aside
      aria-label="Agent"
      className="contain-pane fixed inset-0 z-40 flex flex-col border-ink-600 bg-ink-850 xl:static xl:z-auto xl:w-[380px] xl:shrink-0 xl:border-l"
    >
      <div className="flex items-center justify-between border-b border-ink-600 px-3 py-2">
        <span className="eyebrow">Agent</span>
        <button className="font-mono text-[10px] text-text-lo hover:text-text-hi" onClick={onClose}>
          close
        </button>
      </div>

      <div className="border-b border-ink-600 px-3 py-2.5">
        <div className="mb-2 flex gap-1">
          {(['demo', 'claude'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              disabled={running}
              className={`rounded-sm px-2 py-1 font-mono text-[10px] tracking-wide uppercase transition-colors ${
                mode === m
                  ? 'bg-now-dim text-now'
                  : 'text-text-lo hover:bg-ink-700 hover:text-text-mid'
              }`}
            >
              {m === 'demo' ? 'Guided demo' : 'Claude'}
            </button>
          ))}
        </div>

        {mode === 'claude' ? (
          <>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-ant-…"
              disabled={running}
              className="w-full rounded-sm border border-ink-500 bg-ink-900 px-2 py-1.5 font-mono text-[11px] text-text-hi placeholder:text-text-lo"
            />
            <p className="mt-1.5 text-[10px] leading-relaxed text-text-lo">
              Held in memory for this tab only, never stored. Calls go from your browser straight
              to Anthropic.
            </p>
          </>
        ) : (
          <p className="text-[10px] leading-relaxed text-text-lo">
            {demoAgent.blurb} It follows a fixed plan and asks before every change.
          </p>
        )}

        <button
          className="btn btn-primary mt-2.5 w-full justify-center"
          onClick={() => void start()}
          disabled={!canStart}
        >
          {running ? 'Working…' : dataset ? 'Start' : 'Load a dataset first'}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {entries.length === 0 && !running && (
          <p className="text-xs leading-relaxed text-text-lo">
            The agent uses the same tools you do. Everything it proposes appears here for you to
            approve or decline before it runs.
          </p>
        )}

        <div className="space-y-2.5">
          {entries.map(({ id, event }) => (
            <EventView key={id} event={event} awaiting={awaiting} onDecide={decide} />
          ))}
        </div>
      </div>
    </aside>
  );
}

function EventView({
  event,
  awaiting,
  onDecide,
}: {
  event: AgentEvent;
  awaiting: boolean;
  onDecide: (approved: boolean) => void;
}) {
  switch (event.type) {
    case 'say':
      return <p className="text-xs leading-relaxed text-text-hi">{event.text}</p>;

    case 'tool':
      return (
        <div className="flex items-baseline gap-2 font-mono text-[10px] text-text-lo">
          <span className="text-now">&rarr;</span>
          <span className="truncate">{event.name}</span>
        </div>
      );

    case 'result':
      return (
        <p className="border-l border-ink-500 pl-2 text-[11px] leading-relaxed text-text-mid">
          {event.summary}
        </p>
      );

    case 'approve':
      return (
        <div className="rounded-sm border border-was/40 bg-was-dim p-2.5">
          <div className="eyebrow mb-1.5 text-was">Approval needed</div>
          <p className="text-[11px] leading-relaxed text-text-hi">{event.summary}</p>

          {Array.isArray(event.details['caveats']) &&
            (event.details['caveats'] as string[]).map((c) => (
              <p key={c} className="mt-1.5 text-[10px] leading-relaxed text-text-mid">
                {c}
              </p>
            ))}

          {awaiting && (
            <div className="mt-2.5 flex gap-2">
              <button className="btn flex-1 justify-center" onClick={() => onDecide(false)}>
                Skip
              </button>
              <button
                className="btn btn-primary flex-1 justify-center"
                onClick={() => onDecide(true)}
              >
                Apply
              </button>
            </div>
          )}
        </div>
      );

    case 'done':
      return event.text ? (
        <p className="rounded-sm border border-calm/40 bg-ink-800 p-2.5 text-xs leading-relaxed text-text-hi">
          {event.text}
        </p>
      ) : null;

    case 'error':
      return (
        <p className="rounded-sm border border-alarm/40 bg-alarm-dim p-2.5 text-xs leading-relaxed text-text-hi">
          {event.text}
        </p>
      );

    default:
      return null;
  }
}
