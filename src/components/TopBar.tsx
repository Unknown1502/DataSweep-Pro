import { useState } from 'react';
import { useApp } from '../store/app-store';
import { ToolInspector } from './ToolInspector';

/**
 * The wordmark is the one place the display face appears at size. Everything
 * else in the chrome is set in the UI face at small sizes, so the mark reads as
 * a signature rather than as a heading among headings.
 */
export function TopBar({ onOpenAgent, agentOpen }: { onOpenAgent: () => void; agentOpen: boolean }) {
  const [inspecting, setInspecting] = useState(false);
  const datasets = useApp((s) => s.datasets);
  const selectedId = useApp((s) => s.selectedId);
  const select = useApp((s) => s.select);

  return (
    <>
      <header className="flex h-12 shrink-0 items-center gap-4 border-b border-ink-600 bg-ink-850 px-4">
        <div className="flex items-baseline gap-2">
          <span className="font-display text-[15px] leading-none font-extrabold tracking-tight text-text-hi">
            DataSweep
          </span>
          <span className="font-mono text-[10px] tracking-[0.18em] text-now uppercase">Pro</span>
        </div>

        <div className="h-4 w-px bg-ink-600" />

        {datasets.length > 0 && (
          <select
            value={selectedId ?? ''}
            onChange={(e) => select(e.target.value || null)}
            className="rounded-sm border border-ink-500 bg-ink-700 px-2 py-1 font-mono text-xs text-text-hi"
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
          Tool inspector
        </button>

        <a
          className="btn"
          href="https://github.com/webmcp-org"
          target="_blank"
          rel="noreferrer noopener"
          title="Tools are published on document.modelContext"
        >
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-calm" />
          WebMCP live
        </a>
      </header>

      {inspecting && <ToolInspector onClose={() => setInspecting(false)} />}
    </>
  );
}
