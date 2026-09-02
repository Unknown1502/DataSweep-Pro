import { useState } from 'react';
import { Modal } from './Modal';
import { ALL_TOOLS } from '../lib/tools';

/**
 * Shows every tool exactly as an agent receives it: name, description,
 * annotations, and live JSON Schema — read from the same definitions that were
 * registered, so what is inspected here cannot drift from what is offered.
 *
 * Included because "the tools are real WebMCP tools" is a claim, and this makes
 * it something a reviewer can check in ten seconds rather than take on trust.
 */
export function ToolInspector({ onClose }: { onClose: () => void }) {
  const [selected, setSelected] = useState(ALL_TOOLS[0]?.name ?? '');
  const tool = ALL_TOOLS.find((t) => t.name === selected);

  return (
    <Modal
      title="Registered tools"
      subtitle={`published on document.modelContext · ${ALL_TOOLS.length} tools`}
      onClose={onClose}
      width="max-w-4xl"
      height="h-[min(680px,85vh)]"
    >
      <div className="flex h-full min-h-0 flex-col sm:flex-row">
        <nav
          aria-label="Tools"
          className="max-h-40 w-full shrink-0 overflow-y-auto border-b border-ink-600 sm:max-h-none sm:w-[230px] sm:border-r sm:border-b-0"
        >
            {ALL_TOOLS.map((t) => (
              <button
                key={t.name}
                onClick={() => setSelected(t.name)}
                className={`block w-full px-3 py-2 text-left font-mono text-[11px] transition-colors ${
                  t.name === selected
                    ? 'bg-now-dim text-now'
                    : 'text-text-mid hover:bg-ink-700 hover:text-text-hi'
                }`}
              >
                {t.name}
                <span className="mt-0.5 block font-sans text-[9px] tracking-wider text-text-lo uppercase">
                  {t.annotations.readOnlyHint ? 'read only' : 'mutating'}
                </span>
            </button>
          ))}
        </nav>

        <div className="min-w-0 flex-1 overflow-y-auto p-4">
            {tool && (
              <>
                <h3 className="font-mono text-[13px] text-text-hi">{tool.name}</h3>
                <p className="mt-2 max-w-[70ch] text-xs leading-relaxed text-text-mid">
                  {tool.description}
                </p>

                <div className="mt-4 flex flex-wrap gap-1.5">
                  {Object.entries(tool.annotations).map(([key, value]) => (
                    <span
                      key={key}
                      className={`rounded-sm border px-1.5 py-0.5 font-mono text-[10px] ${
                        value
                          ? 'border-now/40 bg-now-dim text-now'
                          : 'border-ink-500 bg-ink-700 text-text-lo'
                      }`}
                    >
                      {key}: {String(value)}
                    </span>
                  ))}
                </div>

                <div className="eyebrow mt-5 mb-2">Input schema</div>
                <pre className="grid-scroll rounded-sm border border-ink-600 bg-ink-900 p-3 font-mono text-[11px] leading-relaxed text-text-mid">
                  {JSON.stringify(tool.inputSchema, null, 2)}
                </pre>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
