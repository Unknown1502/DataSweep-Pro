import { useCallback, useRef, useState } from 'react';
import { Bot, CheckCircle2, ChevronRight, Play, Plug, X } from 'lucide-react';
import { cn } from '../../lib/cn';
import { createClaudeAgent } from '../../lib/agent/claude-agent';
import { demoAgent } from '../../lib/agent/demo-agent';
import type { AgentEvent, AgentRun } from '../../lib/agent/types';
import { useApp, useSelectedDataset } from '../../store/app-store';
import { useFindings } from '../../store/findings';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Alert, Input } from '../ui/misc';

interface Entry {
  id: number;
  event: AgentEvent;
}

type AgentStatus = 'ready' | 'scanning' | 'waiting' | 'complete';

const STATUS_LABEL: Record<AgentStatus, string> = {
  ready: 'Ready',
  scanning: 'Working',
  waiting: 'Waiting for approval',
  complete: 'Complete',
};

/**
 * Agent activity.
 *
 * Not a chat window: an activity record. Every entry is an action, a tool name,
 * a result or an approval — never a narration of reasoning the application
 * cannot actually observe.
 *
 * Approval is rendered inline in the transcript rather than as a dialog: the
 * decision belongs next to the calls it follows from, and a modal would hide
 * the very thing the user is being asked to judge.
 */
export function AgentRail({ onClose }: { onClose: () => void }) {
  const dataset = useSelectedDataset();
  const refresh = useApp((s) => s.refresh);
  const invalidate = useFindings((s) => s.invalidate);

  const [entries, setEntries] = useState<Entry[]>([]);
  const [running, setRunning] = useState(false);
  const [awaiting, setAwaiting] = useState(false);
  const [done, setDone] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [mode, setMode] = useState<'demo' | 'claude' | 'relay'>('demo');

  const runRef = useRef<AgentRun | null>(null);
  const counter = useRef(0);

  const push = useCallback((event: AgentEvent) => {
    counter.current += 1;
    setEntries((prev) => [...prev, { id: counter.current, event }]);
  }, []);

  const pump = useCallback(
    async (run: AgentRun, decision?: boolean) => {
      let input = decision;
      for (;;) {
        const { value, done: finished } = await run.next(input);
        input = undefined;
        if (finished || !value) {
          setRunning(false);
          setAwaiting(false);
          setDone(true);
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
          setDone(true);
          refresh();
          return;
        }
        if (value.type === 'result') {
          if (dataset) invalidate(dataset.id);
          refresh();
        }
      }
    },
    [push, refresh, invalidate, dataset],
  );

  async function start() {
    if (!dataset) return;
    setEntries([]);
    setDone(false);
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

  const status: AgentStatus = awaiting
    ? 'waiting'
    : running
      ? 'scanning'
      : done
        ? 'complete'
        : 'ready';

  const canStart =
    !!dataset && !running && (mode === 'demo' || apiKey.trim().startsWith('sk-ant-'));

  const lastAction = [...entries].reverse().find((e) => e.event.type === 'tool');

  return (
    <aside
      aria-label="Agent activity"
      className="contain-pane fixed inset-0 z-40 flex flex-col border-line bg-shell-800 xl:static xl:z-auto xl:w-[340px] xl:shrink-0 xl:border-l"
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-line px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <Bot className="size-4 shrink-0 text-agent" aria-hidden="true" />
          <span className="eyebrow">Agent activity</span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Badge
            tone={status === 'waiting' ? 'warn' : status === 'complete' ? 'success' : 'agent'}
          >
            {STATUS_LABEL[status]}
          </Badge>
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close agent panel">
            <X />
          </Button>
        </div>
      </div>

      {/* Agent path */}
      <div className="shrink-0 border-b border-line px-3 py-2.5">
        <div className="mb-2 flex gap-1" role="tablist" aria-label="Agent path">
          {(
            [
              ['demo', 'Guided demo'],
              ['claude', 'Claude'],
              ['relay', 'Local relay'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={mode === id}
              onClick={() => setMode(id)}
              disabled={running}
              className={cn(
                'rounded-sm px-2 py-1 text-[11px] font-medium transition-colors',
                mode === id
                  ? 'bg-agent-dim text-agent'
                  : 'text-fg-subtle hover:bg-surface-700 hover:text-fg-muted',
              )}
            >
              {label}
            </button>
          ))}
        </div>

        {mode === 'claude' && (
          <>
            <Input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-ant-…"
              disabled={running}
              aria-label="Anthropic API key"
              className="font-mono text-[12px]"
            />
            <p className="mt-1.5 text-[11px] leading-relaxed text-fg-subtle">
              Held in memory for this tab only, never stored. Requests go from your browser
              straight to Anthropic.
            </p>
          </>
        )}

        {mode === 'demo' && (
          <p className="text-[11px] leading-relaxed text-fg-subtle">
            A scripted agent that calls the real tools. No API key. It follows a fixed plan and
            asks before every change.
          </p>
        )}

        {mode === 'relay' && (
          <div className="space-y-1.5">
            <p className="text-[11px] leading-relaxed text-fg-subtle">
              Drive this page from Claude Code or Claude Desktop. Run the relay, then ask your
              client for <code className="font-mono text-fg-muted">list_datasets</code>.
            </p>
            <code className="block rounded-sm border border-line bg-shell-900 px-2 py-1 font-mono text-[11px] text-fg-muted">
              npx @mcp-b/webmcp-local-relay
            </code>
          </div>
        )}

        {/* With nothing loaded there is nothing to start, and a big disabled
            primary button would dominate the panel while doing nothing. The
            empty state below already says what to do. */}
        {mode !== 'relay' && dataset && (
          <Button
            variant="primary"
            className="mt-2.5 w-full"
            onClick={() => void start()}
            disabled={!canStart}
          >
            <Play />
            {running ? 'Working…' : done ? 'Run again' : 'Start'}
          </Button>
        )}
      </div>

      {/* Current task */}
      {dataset && (running || awaiting) && lastAction?.event.type === 'tool' && (
        <div className="shrink-0 border-b border-line px-3 py-2">
          <div className="eyebrow mb-1">Current action</div>
          <div className="flex items-center gap-1.5">
            <ChevronRight className="size-3 shrink-0 text-agent" aria-hidden="true" />
            <span className="truncate font-mono text-[11px] text-fg-muted">
              {lastAction.event.name}
            </span>
          </div>
        </div>
      )}

      <div
        className="min-h-0 flex-1 overflow-y-auto px-3 py-3"
        aria-live="polite"
        aria-busy={running}
      >
        {!dataset && (
          <div className="flex flex-col items-center py-8 text-center">
            <Bot className="size-6 text-fg-subtle" aria-hidden="true" />
            <p className="mt-3 text-[13px] font-medium text-fg">
              Choose a dataset to activate the agent
            </p>
            <p className="mt-1 max-w-[30ch] text-[12px] leading-relaxed text-fg-subtle">
              It will scan for quality problems and propose fixes, asking you before anything
              changes.
            </p>
          </div>
        )}

        {dataset && entries.length === 0 && !running && (
          <div className="flex flex-col items-center py-8 text-center">
            <Plug className="size-6 text-fg-subtle" aria-hidden="true" />
            <p className="mt-3 max-w-[32ch] text-[12px] leading-relaxed text-fg-subtle">
              The agent uses the same tools you do. Everything it proposes appears here for you to
              approve or decline before it runs.
            </p>
          </div>
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
      return <p className="text-[12.5px] leading-relaxed text-fg">{event.text}</p>;

    case 'tool':
      return (
        <div className="flex items-baseline gap-1.5 font-mono text-[11px] text-fg-subtle">
          <ChevronRight className="size-3 shrink-0 text-agent" aria-hidden="true" />
          <span className="truncate">{event.name}</span>
        </div>
      );

    case 'result':
      return (
        <p className="border-l-2 border-agent-line pl-2 text-[12px] leading-relaxed text-fg-muted">
          {event.summary}
        </p>
      );

    case 'approve':
      return (
        <div className="rounded-md border border-warn-line bg-warn-dim p-2.5">
          <div className="eyebrow mb-1.5 text-warn">Waiting for your approval</div>
          <p className="text-[12px] leading-relaxed text-fg">{event.summary}</p>

          {Array.isArray(event.details['caveats']) &&
            (event.details['caveats'] as string[]).map((c) => (
              <p key={c} className="mt-1.5 text-[11px] leading-relaxed text-fg-muted">
                {c}
              </p>
            ))}

          {awaiting && (
            <div className="mt-2.5 flex gap-2">
              <Button variant="outline" size="sm" className="flex-1" onClick={() => onDecide(false)}>
                Skip
              </Button>
              <Button variant="primary" size="sm" className="flex-1" onClick={() => onDecide(true)}>
                Apply
              </Button>
            </div>
          )}
        </div>
      );

    case 'done':
      return event.text ? (
        <Alert tone="success">
          <CheckCircle2 />
          <span className="text-[12px]">{event.text}</span>
        </Alert>
      ) : null;

    case 'error':
      return (
        <Alert tone="danger">
          <span className="text-[12px]">{event.text}</span>
        </Alert>
      );

    default:
      return null;
  }
}
