'use client';

import { useState } from 'react';
import { Button } from '../form/button.tsx';
import { RadioGroup } from '../form/radio-group.tsx';
import { Dialog } from '../overlay/dialog.tsx';

export type ExportFormat = 'csv' | 'xlsx';

export interface ExportDialogLabels {
  readonly title: string;
  readonly body: string;
  readonly legend: string;
  readonly csv: string;
  readonly csvHelp: string;
  readonly xlsx: string;
  readonly xlsxHelp: string;
  readonly confirm: string;
  readonly cancel: string;
}

export interface ExportDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly labels: ExportDialogLabels;
  /** The export is running: Export is off until it ends. */
  readonly busy?: boolean;
  /** The format was chosen: the page closes the dialog and starts the download. */
  readonly onConfirm: (format: ExportFormat) => void;
}

/**
 * The Export dialog of a list: the file format (CSV or XLSX) and a note on what the file holds.
 * It only asks; the page makes the request and says how it went.
 */
export function ExportDialog({
  open,
  onClose,
  labels,
  busy = false,
  onConfirm,
}: ExportDialogProps) {
  const [format, setFormat] = useState<ExportFormat>('csv');
  return (
    <Dialog
      open={open}
      title={labels.title}
      onClose={onClose}
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>
            {labels.cancel}
          </Button>
          <Button disabled={busy} onClick={() => onConfirm(format)}>
            {labels.confirm}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p>{labels.body}</p>
        <RadioGroup
          legend={labels.legend}
          name="list-export-format"
          value={format}
          onChange={(next) => setFormat(next === 'xlsx' ? 'xlsx' : 'csv')}
          options={[
            { value: 'csv', label: labels.csv, help: labels.csvHelp },
            { value: 'xlsx', label: labels.xlsx, help: labels.xlsxHelp },
          ]}
        />
      </div>
    </Dialog>
  );
}

/** Hands a downloaded file to the browser under a name of the page's choice. */
export function saveFile(blob: Blob, filename: string): void {
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
