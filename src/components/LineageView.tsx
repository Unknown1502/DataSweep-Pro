import { registry } from '../lib/tools/context';
import { Modal } from './Modal';
import type { Dataset } from '../lib/engine/registry';
import { useApp, useSelectedDataset } from '../store/app-store';

/**
 * Where this data came from and what was done to it.
 *
 * Drawn as inline SVG rather than pulling in a diagramming library: it is a
 * handful of rects and paths, and it matches the app's own palette instead of
 * looking like an embedded third-party widget.
 *
 * **It does not pretend to be a graph when it isn't.** A single dataset's
 * history is a straight chain, and is drawn and described as one. A branch only
 * appears where one genuinely exists — a join, whose inputs are recorded on
 * `Dataset.parents` at the time the join runs.
 */

const NODE_W = 132;
const NODE_H = 42;
const GAP_X = 34;
const GAP_Y = 22;
const PAD = 14;

interface Node {
  id: string;
  label: string;
  sub: string;
  col: number;
  row: number;
  kind: 'source' | 'step' | 'current' | 'undone';
}

export function LineageView({ onClose }: { onClose: () => void }) {
  const dataset = useSelectedDataset();
  useApp((s) => s.revision);

  if (!dataset) return null;

  const parents = dataset.parents
    .map((id) => (registry.has(id) ? registry.resolve(id) : null))
    .filter((d): d is Dataset => d !== null);

  const nodes: Node[] = [];
  const edges: { from: string; to: string }[] = [];

  // Parents occupy column 0, stacked. A join is the only way to get more than
  // one, so more than one row here means a genuine merge.
  parents.forEach((parent, i) => {
    const head = parent.history[parent.headIndex];
    nodes.push({
      id: `p_${parent.id}`,
      label: parent.name,
      sub: `${(head?.rowCount ?? 0).toLocaleString()} rows`,
      col: 0,
      row: i,
      kind: 'source',
    });
  });

  const startCol = parents.length > 0 ? 1 : 0;
  const centreRow = parents.length > 1 ? (parents.length - 1) / 2 : 0;

  dataset.history.forEach((checkpoint, i) => {
    const kind: Node['kind'] =
      i === dataset.headIndex ? 'current' : i > dataset.headIndex ? 'undone' : i === 0 ? 'source' : 'step';

    nodes.push({
      id: checkpoint.id,
      label: i === 0 ? dataset.name : checkpoint.label,
      sub: `${checkpoint.rowCount.toLocaleString()} rows`,
      col: startCol + i,
      row: centreRow,
      kind,
    });

    const previous = dataset.history[i - 1];
    if (previous) edges.push({ from: previous.id, to: checkpoint.id });
  });

  for (const parent of parents) {
    const first = dataset.history[0];
    if (first) edges.push({ from: `p_${parent.id}`, to: first.id });
  }

  const cols = Math.max(...nodes.map((n) => n.col)) + 1;
  const rows = Math.max(...nodes.map((n) => n.row)) + 1;
  const width = PAD * 2 + cols * NODE_W + (cols - 1) * GAP_X;
  const height = PAD * 2 + rows * (NODE_H + GAP_Y);

  const x = (n: Node) => PAD + n.col * (NODE_W + GAP_X);
  const y = (n: Node) => PAD + n.row * (NODE_H + GAP_Y);
  const byId = new Map(nodes.map((n) => [n.id, n]));

  const fill: Record<Node['kind'], string> = {
    source: 'var(--color-ink-700)',
    step: 'var(--color-ink-700)',
    current: 'var(--color-now-dim)',
    undone: 'var(--color-ink-800)',
  };
  const stroke: Record<Node['kind'], string> = {
    source: 'var(--color-ink-500)',
    step: 'var(--color-was)',
    current: 'var(--color-now)',
    undone: 'var(--color-ink-600)',
  };

  const isChain = parents.length === 0;

  return (
    <Modal
      title="Lineage"
      subtitle={
        isChain
          ? `A linear history of ${dataset.history.length} state(s).`
          : `Merged from ${parents.length} dataset(s).`
      }
      onClose={onClose}
      width="max-w-4xl"
      footer={
        <p className="font-mono text-[10px] leading-relaxed text-text-lo">
          Each box is a real DuckDB table. Dashed boxes were undone and are still reachable.
          {isChain
            ? ' This dataset was loaded from a file, so it has no upstream sources.'
            : ' Upstream sources are shown on the left and are themselves unchanged.'}
        </p>
      }
    >
      <div className="grid-scroll p-4">
          <svg
            width={width}
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            role="img"
            aria-label="Data lineage diagram"
          >
            <defs>
              <marker
                id="lineage-arrow"
                viewBox="0 0 8 8"
                refX="7"
                refY="4"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 1 L 7 4 L 0 7 z" fill="var(--color-ink-400)" />
              </marker>
            </defs>

            {edges.map((edge) => {
              const from = byId.get(edge.from);
              const to = byId.get(edge.to);
              if (!from || !to) return null;

              const x1 = x(from) + NODE_W;
              const y1 = y(from) + NODE_H / 2;
              const x2 = x(to);
              const y2 = y(to) + NODE_H / 2;
              const mid = (x1 + x2) / 2;

              return (
                <path
                  key={`${edge.from}-${edge.to}`}
                  d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`}
                  fill="none"
                  stroke="var(--color-ink-500)"
                  strokeWidth="1"
                  markerEnd="url(#lineage-arrow)"
                />
              );
            })}

            {nodes.map((node) => (
              <g key={node.id}>
                <rect
                  x={x(node)}
                  y={y(node)}
                  width={NODE_W}
                  height={NODE_H}
                  rx="4"
                  fill={fill[node.kind]}
                  stroke={stroke[node.kind]}
                  strokeWidth="1"
                  strokeDasharray={node.kind === 'undone' ? '3 3' : undefined}
                />
                <text
                  x={x(node) + 9}
                  y={y(node) + 17}
                  fontSize="10.5"
                  fill={node.kind === 'undone' ? 'var(--color-text-lo)' : 'var(--color-text-hi)'}
                  fontFamily="var(--font-sans)"
                >
                  {node.label.length > 19 ? `${node.label.slice(0, 18)}…` : node.label}
                </text>
                <text
                  x={x(node) + 9}
                  y={y(node) + 31}
                  fontSize="9.5"
                  fill="var(--color-text-lo)"
                  fontFamily="var(--font-mono)"
                >
                  {node.sub}
                  {node.kind === 'undone' ? ' · undone' : ''}
                </text>
              </g>
            ))}
        </svg>
      </div>
    </Modal>
  );
}
