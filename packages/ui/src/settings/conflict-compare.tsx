'use client';

import { useId, useState } from 'react';
import { SettingsConflictBanner } from './conflict-banner.tsx';

export interface ConflictCompareRow {
  readonly key: string;
  /** The field's label, the same words the form uses. */
  readonly label: string;
  /** What is saved now, as plain text. */
  readonly saved: string;
  /** What the user typed, as plain text. */
  readonly yours: string;
}

export interface SettingsConflictCompareProps {
  readonly title: string;
  readonly body: string;
  readonly compareLabel: string;
  readonly hideLabel: string;
  /** Short heading of the list ("What changed"). */
  readonly heading: string;
  /** Accessible name of the list ("Changes compared"). */
  readonly listLabel: string;
  /** "Saved now:" */
  readonly savedLabel: string;
  /** "Yours:" */
  readonly yoursLabel: string;
  /** Shown when the draft now equals what is saved. */
  readonly sameText: string;
  readonly rows: readonly ConflictCompareRow[];
}

/** One value: quoted, at most two lines, the full text in the tooltip. Rendered as text only. */
function Value({ text }: { readonly text: string }) {
  return (
    <q
      title={text}
      className="line-clamp-2 min-w-0 break-words rounded-sm bg-muted px-1.5 font-medium text-fg"
    >
      {text}
    </q>
  );
}

/**
 * The conflict banner with a Compare button that lists, per field, what is saved now and what the
 * user typed. Every value is rendered as text by React, so user content (a welcome message, a
 * store description) can never become markup. The banner is a status region that mounts when the
 * conflict is set. Remount it per conflict (`key`) to start closed.
 */
export function SettingsConflictCompare({
  title,
  body,
  compareLabel,
  hideLabel,
  heading,
  listLabel,
  savedLabel,
  yoursLabel,
  sameText,
  rows,
}: SettingsConflictCompareProps) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  return (
    <div className="flex flex-col gap-3">
      <SettingsConflictBanner
        title={title}
        body={body}
        compareLabel={open ? hideLabel : compareLabel}
        onCompare={() => setOpen((current) => !current)}
        compareExpanded={open}
        compareControls={listId}
      />
      <div
        id={listId}
        hidden={!open}
        className="ms-3 border-s-4 border-attention-solid ps-4 text-sm"
      >
        {open ? (
          <>
            <h3 className="mb-2 font-semibold text-fg">{heading}</h3>
            {rows.length === 0 ? (
              <p>{sameText}</p>
            ) : (
              <ul aria-label={listLabel} className="flex flex-col gap-3">
                {rows.map((row) => (
                  <li key={row.key} className="flex min-w-0 flex-col gap-1">
                    <span className="font-medium text-fg">{row.label}</span>
                    <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                      <span className="text-fg-muted">{savedLabel}</span>
                      <Value text={row.saved} />
                    </span>
                    <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                      <span className="text-fg-muted">{yoursLabel}</span>
                      <Value text={row.yours} />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}
