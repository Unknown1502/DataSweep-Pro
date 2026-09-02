import { registry } from '../../lib/tools/context';
import type { Dataset } from '../../lib/engine/registry';
import { useApp, useSelectedDataset } from '../../store/app-store';
import { Badge } from '../ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';

/**
 * Where this data came from and what was done to it.
 *
 * Inline SVG rather than a diagramming library: it is a handful of rects and
 * paths, and it matches the product's own palette instead of looking like an
 * embedded widget.
 *
 * It does not pretend to be a graph when it isn't. A single dataset's history
 * is a chain, drawn and described as one. A branch appears only where one
 * genuinely exists — a join, whose inputs are recorded on `Dataset.parents`.
 */

const NODE_W = 150;
const NODE_H = 48;
const GAP_X = 40;
const GAP_Y = 24;
const PAD = 16;

interface Node {
  id: string;
  label: string;
  sub: string;
  col: number;
  row: number;
  kind: 'source' | 'step' | 'current' | 'undone';
}

export function LineagePanel() {
  const dataset = useSelectedDataset();
  useApp((s) => s.revision);

  if (!dataset) return null;

  const parents = dataset.parents
    .map((id) => (registry.has(id) ? registry.resolve(id) : null))
    .filter((d): d is Dataset => d !== null);

  const nodes: Node[] = [];
  const edges: { from: string; to: string }[] = [];

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
      i === dataset.headIndex
        ? 'current'
        : i > dataset.headIndex
          ? 'undone'
          : i === 0
            ? 'source'
            : 'step';

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
    source: 'var(--color-surface-700)',
    step: 'var(--color-surface-700)',
    current: 'var(--color-primary-dim)',
    undone: 'var(--color-surface-900)',
  };
  const stroke: Record<Node['kind'], string> = {
    source: 'var(--color-line-strong)',
    step: 'var(--color-line-strong)',
    current: 'var(--color-primary)',
    undone: 'var(--color-line)',
  };

  const isChain = parents.length === 0;

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <div>
          <CardTitle className="text-[14px]">Lineage</CardTitle>
          <p className="mt-0.5 text-[12px] text-fg-muted">
            {isChain
              ? `A linear history of ${dataset.history.length} state${dataset.history.length === 1 ? '' : 's'}.`
              : `Merged from ${parents.length} dataset${parents.length === 1 ? '' : 's'}.`}
          </p>
        </div>
        <Badge>{isChain ? 'linear' : 'merge'}</Badge>
      </CardHeader>

      <CardContent>
        <div className="grid-scroll rounded-md border border-line bg-shell-900 p-2">
          <svg
            width={width}
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            role="img"
            aria-label={`Lineage: ${nodes.length} states${isChain ? ', linear' : ', merged'}`}
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
                <path d="M 0 1 L 7 4 L 0 7 z" fill="var(--color-line-strong)" />
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
                  stroke="var(--color-line-strong)"
                  strokeWidth="1.25"
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
                  rx="6"
                  fill={fill[node.kind]}
                  stroke={stroke[node.kind]}
                  strokeWidth={node.kind === 'current' ? 1.5 : 1}
                  strokeDasharray={node.kind === 'undone' ? '3 3' : undefined}
                />
                <text
                  x={x(node) + 11}
                  y={y(node) + 20}
                  fontSize="11.5"
                  fill={
                    node.kind === 'undone' ? 'var(--color-fg-subtle)' : 'var(--color-fg)'
                  }
                  fontFamily="var(--font-sans)"
                >
                  {node.label.length > 20 ? `${node.label.slice(0, 19)}…` : node.label}
                </text>
                <text
                  x={x(node) + 11}
                  y={y(node) + 35}
                  fontSize="10"
                  fill="var(--color-fg-subtle)"
                  fontFamily="var(--font-mono)"
                >
                  {node.sub}
                  {node.kind === 'undone' ? ' · undone' : ''}
                </text>
              </g>
            ))}
          </svg>
        </div>

        <p className="mt-3 text-[12px] leading-relaxed text-fg-subtle">
          Each box is a real DuckDB table. Dashed boxes were undone and remain reachable.
          {isChain
            ? ' This dataset was loaded from a file, so it has no upstream sources.'
            : ' Upstream sources are on the left and are themselves unchanged.'}
        </p>
      </CardContent>
    </Card>
  );
}
