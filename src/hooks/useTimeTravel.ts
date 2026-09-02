import { useCallback } from 'react';
import { callTool } from '../lib/tools';
import { useApp, useSelectedDataset } from '../store/app-store';
import { useFindings } from '../store/findings';

/**
 * Undo and redo, shared by the keyboard shortcuts and the header controls.
 *
 * Both are the same operation in opposite directions, because history is a list
 * and the head is an index into it. Extracted so the two entry points cannot
 * drift — a header button that took a different route to the same result is how
 * one of them ends up skipping the confirmation gate.
 */
export function useTimeTravel() {
  const dataset = useSelectedDataset();
  const refresh = useApp((s) => s.refresh);
  const setActionError = useApp((s) => s.setActionError);
  const invalidate = useFindings((s) => s.invalidate);

  const step = useCallback(
    async (delta: -1 | 1) => {
      if (!dataset) return;
      const target = dataset.history[dataset.headIndex + delta];
      if (!target) return;

      setActionError(null);
      try {
        // The same two-phase gate an agent goes through. Invoking this control
        // is the review, so the token is redeemed immediately.
        const args = { dataset_id: dataset.id, checkpoint_id: target.id };
        const preview = (await callTool('undo_to_checkpoint', args)) as {
          confirmation_token: string;
        };
        await callTool('undo_to_checkpoint', {
          ...args,
          confirmation_token: preview.confirmation_token,
        });
        // The old scan describes data that no longer exists.
        invalidate(dataset.id);
        refresh();
      } catch (error) {
        setActionError(error instanceof Error ? error.message : String(error));
      }
    },
    [dataset, refresh, setActionError, invalidate],
  );

  return {
    step,
    canUndo: !!dataset && dataset.headIndex > 0,
    canRedo: !!dataset && dataset.headIndex < dataset.history.length - 1,
  };
}
