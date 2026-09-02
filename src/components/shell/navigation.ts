import {
  Database,
  FileText,
  FolderOpen,
  GitBranch,
  History,
  LayoutDashboard,
  ScrollText,
  ShieldAlert,
  Table2,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { WorkspaceView } from '../../store/app-store';

export interface NavItem {
  readonly id: WorkspaceView | 'files';
  readonly label: string;
  readonly icon: LucideIcon;
  /** Shown on the disabled state, so an inert control explains itself. */
  readonly requiresDataset: boolean;
}

export interface NavSection {
  readonly heading: string;
  readonly items: readonly NavItem[];
}

/**
 * The navigation, and the tab strip, come from this one list.
 *
 * Every entry has a working destination. "Checkpoints" appears in no section
 * because the ledger already *is* the checkpoint list — a second route to the
 * same pane would imply a feature that does not exist.
 */
export const NAV_SECTIONS: readonly NavSection[] = [
  {
    heading: 'Workspace',
    items: [
      { id: 'files', label: 'Files', icon: FolderOpen, requiresDataset: false },
      { id: 'overview', label: 'Overview', icon: LayoutDashboard, requiresDataset: true },
      { id: 'findings', label: 'Findings', icon: ShieldAlert, requiresDataset: true },
      { id: 'data', label: 'Data', icon: Table2, requiresDataset: true },
      { id: 'rules', label: 'Rules', icon: ScrollText, requiresDataset: true },
    ],
  },
  {
    heading: 'Traceability',
    items: [
      { id: 'ledger', label: 'Ledger', icon: History, requiresDataset: true },
      { id: 'lineage', label: 'Lineage', icon: GitBranch, requiresDataset: true },
    ],
  },
  {
    heading: 'Output',
    items: [
      { id: 'exports', label: 'Exports', icon: Database, requiresDataset: true },
      { id: 'docs', label: 'Documentation', icon: FileText, requiresDataset: true },
    ],
  },
];

/** The tab strip inside the dataset workspace, in the same order as the rail. */
export const WORKSPACE_TABS: readonly { id: WorkspaceView; label: string; icon: LucideIcon }[] = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'findings', label: 'Findings', icon: ShieldAlert },
  { id: 'data', label: 'Data', icon: Table2 },
  { id: 'ledger', label: 'Ledger', icon: History },
  { id: 'lineage', label: 'Lineage', icon: GitBranch },
  { id: 'rules', label: 'Rules', icon: ScrollText },
  { id: 'exports', label: 'Exports', icon: Database },
  { id: 'docs', label: 'Docs', icon: FileText },
];
