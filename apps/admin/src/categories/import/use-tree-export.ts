import { useState } from 'react';
import { exportTree } from './export-tree.ts';

export type TreeExportFormat = 'csv' | 'xlsx';

/**
 * The export of the tree as a file, one format at a time. `exporting` names the format that is
 * running, so only that button shows the spinner; the other button waits, disabled, until it ends.
 */
export function useTreeExport(failedText: string): {
  readonly exporting: TreeExportFormat | null;
  readonly run: (format: TreeExportFormat) => Promise<void>;
} {
  const [exporting, setExporting] = useState<TreeExportFormat | null>(null);
  const run = async (format: TreeExportFormat) => {
    setExporting(format);
    try {
      await exportTree(format, failedText);
    } finally {
      setExporting(null);
    }
  };
  return { exporting, run };
}
