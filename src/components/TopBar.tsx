import { useState } from 'react';
import { useApp } from '../store/app-store';
import { ToolInspector } from './ToolInspector';

/**
 * The wordmark is the one place the display face appears at size. Everything
 * else in the chrome is set in the UI face at small sizes, so the mark reads as
 * a signature rather than as a heading among headings.
 */
export function TopBar({
  onOpenAgent,
  agentOpen,
  onToggleRail,
}: {
  onOpenAgent: () => void;
  agentOpen: boolean;
  onToggleRail: () => void;
}) {
  const [inspecting, setInspecting] = useState(false);
  const datasets = useApp((s) => s.datasets);
  const selectedId = useApp((s) => s.selectedId);
  const select = useApp((s) => s.select);

  return (
    <>
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-ink-600 bg-ink-850 px-3 sm:gap-4 sm:px-4">
        <button
          className="btn px-2 lg:hidden"
          onClick={onToggleRail}
          aria-label="Toggle ledger"
        >
          &#9776;
        </button>

        <div className="flex items-baseline gap-2">
          <span className="font-display text-[15px] leading-none font-extrabold tracking-tight text-text-hi">
            DataSweep
          </span>
          <span className="font-mono text-[10px] tracking-[0.18em] text-now uppercase">Pro</span>
        </div>

        <div className="hidden h-4 w-px bg-ink-600 sm:block" />

        {datasets.length > 0 && (
          <select
            value={selectedId ?? ''}
            onChange={(e) => select(e.target.value || null)}
            className="max-w-[38vw] rounded-sm border border-ink-500 bg-ink-700 px-2 py-1 font-mono text-xs text-text-hi sm:max-w-none"
            aria-label="Selected dataset"
          >
            {datasets.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        )}

        <div className="flex-1" />

        {!agentOpen && (
          <button className="btn" onClick={onOpenAgent}>
            Agent
          </button>
        )}

        <button className="btn" onClick={() => setInspecting(true)}>
          <span className="hidden sm:inline">Tool inspector</span>
          <span className="sm:hidden">Tools</span>
        </button>

        <a
          className="btn"
          href="https://github.com/webmcp-org"
          target="_blank"
          rel="noreferrer noopener"
          title="Tools are published on document.modelContext"
        >
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-calm" />
          <span className="hidden md:inline">WebMCP live</span>
        </a>
      </header>

      {inspecting && <ToolInspector onClose={() => setInspecting(false)} />}
    </>
  );
}
