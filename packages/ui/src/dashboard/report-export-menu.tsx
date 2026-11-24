'use client';

import { useState } from 'react';
import { toast } from '../feedback/toast-store.ts';
import { ActionMenu } from '../overlay/action-menu.tsx';
import { downloadReport, ReportDownloadError, type ReportFormat } from './report-download.ts';

export interface ReportExportLabels {
  /** The button ("Export"). */
  readonly button: string;
  /** The line at the top of the open menu ("Figures for the shown period"). */
  readonly title: string;
  readonly csv: string;
  readonly csvHelp: string;
  readonly xlsx: string;
  readonly xlsxHelp: string;
  readonly done: string;
  /** The toast of a 403, before the button goes away. */
  readonly denied: string;
  readonly invalidFile: string;
  readonly unavailable: string;
  /** Why the button is disabled (the range is not valid). */
  readonly invalidRange: string;
}

/**
 * The Export button of a dashboard header: the report of the shown period as CSV or XLSX, fetched
 * through the panel's relay. A 403 says so once and hides the button (the session may not export
 * after all); any other failure is a toast and the button stays. `disabled` (a range that is not
 * valid) keeps it visible with the reason as its hint.
 */
export function ReportExportMenu({
  labels,
  path,
  queryFor,
  fallbackName,
  zone,
  disabled,
}: {
  readonly labels: ReportExportLabels;
  /** The relay path of the report. */
  readonly path: string;
  /** The query of the request for a format (the shown period or range, then `format`). */
  readonly queryFor: (format: ReportFormat) => string;
  readonly fallbackName: string;
  readonly zone: string | null;
  readonly disabled: boolean;
}) {
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  if (hidden) return null;

  async function start(format: ReportFormat) {
    setBusy(true);
    try {
      await downloadReport({ path, query: queryFor(format), format, fallbackName, zone });
      toast.success(labels.done, { id: 'dashboard-export' });
    } catch (reason) {
      if (reason instanceof ReportDownloadError && reason.reason === 'denied') {
        toast.error(labels.denied, { id: 'dashboard-export' });
        setHidden(true);
      } else {
        const invalid = reason instanceof ReportDownloadError && reason.reason === 'invalid';
        toast.error(invalid ? labels.invalidFile : labels.unavailable, { id: 'dashboard-export' });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <ActionMenu
      label={labels.button}
      title={labels.title}
      disabled={busy || disabled}
      {...(disabled ? { hint: labels.invalidRange } : {})}
      items={[
        {
          id: 'csv',
          label: labels.csv,
          description: labels.csvHelp,
          icon: 'download',
          onSelect: () => void start('csv'),
        },
        {
          id: 'xlsx',
          label: labels.xlsx,
          description: labels.xlsxHelp,
          icon: 'download',
          onSelect: () => void start('xlsx'),
        },
      ]}
    />
  );
}
