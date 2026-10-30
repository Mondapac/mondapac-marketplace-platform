'use client';

import { useState } from 'react';
import { SettingsConflictBanner } from './conflict-banner.tsx';

export interface ConflictCompareRow {
  readonly key: string;
  /** The whole line, already worded: "Cut-off: saved now 14:00, yours 15:00". Plain text. */
  readonly text: string;
}

export interface SettingsConflictCompareProps {
  readonly title: string;
  readonly body: string;
  readonly compareLabel: string;
  readonly hideLabel: string;
  /** Shown when the draft now equals what is saved. */
  readonly sameText: string;
  readonly rows: readonly ConflictCompareRow[];
}

/**
 * The conflict banner with a Compare button that lists, per field, what is saved now and what the
 * user typed. Every value is rendered as text by React, so user content (a welcome message, a
 * store description) can never become markup. Remount it per conflict (`key`) to start closed.
 */
export function SettingsConflictCompare({
  title,
  body,
  compareLabel,
  hideLabel,
  sameText,
  rows,
}: SettingsConflictCompareProps) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-3">
      <SettingsConflictBanner
        title={title}
        body={body}
        compareLabel={open ? hideLabel : compareLabel}
        onCompare={() => setOpen((current) => !current)}
      />
      {open ? (
        <ul className="flex flex-col gap-1 rounded-md border border-line p-4 text-sm">
          {rows.length === 0 ? (
            <li>{sameText}</li>
          ) : (
            rows.map((row) => (
              <li key={row.key} className="break-words whitespace-pre-line">
                {row.text}
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
