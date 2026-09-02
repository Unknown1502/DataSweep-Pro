import { useCallback, useRef, useState } from 'react';
import { Bot, CheckCircle2, ChevronRight, Play, Plug, Plus, Trash2, X } from 'lucide-react';
import { cn } from '../../lib/cn';
import { createClaudeAgent } from '../../lib/agent/claude-agent';
import { demoAgent } from '../../lib/agent/demo-agent';
import { forgetKey, keyFor } from '../../lib/agent/key-vault';
import { effectLabel, readIntent } from '../../lib/domain/intent';
import { createOpenAIAgent } from '../../lib/agent/openai-agent';
import { providerById, type ModelConnection } from '../../lib/agent/providers';
import type { AgentEvent, AgentRun } from '../../lib/agent/types';
import { useApp, useSelectedDataset } from '../../store/app-store';
import { useFindings } from '../../store/findings';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Alert } from '../ui/misc';
import { AddModelDialog } from './AddModelDialog';

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
  /**
   * Which path is driving.
   *
   * `models` holds the connections the user added; each is selectable by its
   * own id, so several can be configured at once and swapped between without
   * re-entering a key. Keys are not in here — they are in the vault, so this
   * state can be rendered and passed around freely.
   */
  const [mode, setMode] = useState<'demo' | 'relay' | string>('demo');
  const [models, setModels] = useState<ModelConnection[]>([]);
  const [adding, setAdding] = useState(false);

  const activeModel = models.find((m) => m.id === mode) ?? null;

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

    // Anthropic keeps its SDK-backed loop; every other provider goes through
    // the OpenAI-compatible one. Both enforce the approval gate themselves.
    const agent = !activeModel
      ? demoAgent
      : activeModel.provider === 'anthropic'
        ? createClaudeAgent(keyFor(activeModel.id))
        : createOpenAIAgent(activeModel);
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

  const canStart = !!dataset && !running && (mode === 'demo' || activeModel !== null);

  function disconnect(connection: ModelConnection) {
    forgetKey(connection.id);
    setModels((prev) => prev.filter((m) => m.id !== connection.id));
    // Leaving a removed model selected would keep Start enabled with nothing
    // behind it, so the selection falls back to the demo.
    setMode((current) => (current === connection.id ? 'demo' : current));
  }

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
        <div className="mb-2 flex flex-wrap gap-1" role="tablist" aria-label="Agent path">
          {[
            { id: 'demo', label: 'Guided demo' },
            ...models.map((m) => ({
              id: m.id,
              label: `${providerById(m.provider).label} · ${m.model}`,
            })),
            { id: 'relay', label: 'Local relay' },
          ].map(({ id, label }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={mode === id}
              onClick={() => setMode(id)}
              disabled={running}
              title={label}
              className={cn(
                'max-w-[160px] truncate rounded-sm px-2 py-1 text-[11px] font-medium transition-colors',
                mode === id
                  ? 'bg-agent-dim text-agent'
                  : 'text-fg-subtle hover:bg-surface-700 hover:text-fg-muted',
              )}
            >
              {label}
            </button>
          ))}

          <button
            type="button"
            onClick={() => setAdding(true)}
            disabled={running}
            className="flex items-center gap-1 rounded-sm border border-dashed border-line-strong px-2 py-1 text-[11px] font-medium text-fg-subtle transition-colors hover:border-agent-line hover:text-agent"
          >
            <Plus className="size-3" aria-hidden="true" />
            Add model
          </button>
        </div>

        {activeModel && (
          <div className="space-y-1.5">
            <div className="flex items-center gap-2 rounded-sm border border-line bg-surface-800 px-2 py-1.5">
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-[11px] text-fg">{activeModel.model}</div>
                <div className="font-mono text-[10px] text-fg-subtle">
                  {providerById(activeModel.provider).label} · key held in this tab
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => disconnect(activeModel)}
                disabled={running}
                aria-label={`Disconnect ${providerById(activeModel.provider).label} ${activeModel.model}`}
              >
                <Trash2 />
              </Button>
            </div>
            <p className="text-[11px] leading-relaxed text-fg-subtle">
              Runs the same tools and the same approval gate as every other path here. Requests go
              from your browser straight to {providerById(activeModel.provider).label}.
            </p>
          </div>
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

      <AddModelDialog
        open={adding}
        onOpenChange={setAdding}
        existing={models}
        onAdded={(connection) => {
          setModels((prev) => [...prev, connection]);
          setMode(connection.id);
        }}
      />

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

    case 'approve': {
      // Read from the dry run that already ran, so what the agent is asking for
      // is stated in measured terms rather than in its own description of it.
      const intent = readIntent(event.details);

      return (
        <div className="rounded-md border border-warn-line bg-warn-dim p-2.5">
          <div className="eyebrow mb-1.5 text-warn">Waiting for your approval</div>
          <p className="text-[12px] leading-relaxed text-fg">{event.summary}</p>

          {intent && (
            <div className="mt-2 space-y-1.5 border-t border-warn-line/60 pt-2">
              {intent.steps.map((step, i) => (
                <div key={`${step.operation}-${i}`}>
                  <div className="flex flex-wrap items-baseline gap-x-1.5 font-mono text-[11px]">
                    <span className="text-warn">{step.operation}</span>
                    {step.column && <span className="text-fg-muted">{step.column}</span>}
                    <span className="text-fg-subtle tabular-nums">
                      {step.rowsAffected.toLocaleString()} affected
                    </span>
                  </div>
                  {step.description && (
                    <p className="mt-0.5 text-[11px] leading-relaxed text-fg-muted">
                      {step.description}
                    </p>
                  )}
                </div>
              ))}
              <p className="font-mono text-[10px] text-fg-subtle">
                {intent.effects.map(effectLabel).join(' · ')} · reversible
              </p>
            </div>
          )}

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
    }

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
