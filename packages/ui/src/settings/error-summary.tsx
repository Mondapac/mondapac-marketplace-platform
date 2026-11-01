'use client';

import { useEffect, useRef } from 'react';

export interface SettingsErrorItem {
  /** The `id` given to the `SettingRow` of the invalid field. */
  readonly id: string;
  /** The field's label. */
  readonly label: string;
  /** Why the field is invalid, the same text as under the field: "Same-day cut-off: Enter a time…". */
  readonly reason?: string;
}

export interface SettingsErrorSummaryProps {
  /** "2 settings need fixing before you can save" */
  readonly title: string;
  readonly items: readonly SettingsErrorItem[];
  /** Raise it after each failed Save: focus moves to the summary. 0 never moves focus. */
  readonly focusSignal?: number;
}

/**
 * The critical banner at the top of a settings page that names every invalid field and links to
 * it. A link moves focus to the field (the row's control carries the row's id).
 */
export function SettingsErrorSummary({ title, items, focusSignal = 0 }: SettingsErrorSummaryProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focusSignal > 0) ref.current?.focus();
  }, [focusSignal]);
  if (items.length === 0) return null;
  return (
    <div
      ref={ref}
      role="alert"
      tabIndex={-1}
      className="rounded-md border border-critical-border bg-critical-bg px-4 py-3 text-sm text-critical-fg outline-offset-2"
    >
      <p className="font-semibold">{title}</p>
      <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
        {items.map((item) => (
          <li key={item.id}>
            <a
              href={`#${item.id}`}
              className="font-medium underline"
              onClick={(event) => {
                const field = document.getElementById(item.id);
                if (field === null) return;
                event.preventDefault();
                field.focus();
              }}
            >
              {item.label}
            </a>
            {item.reason === undefined ? null : <span>: {item.reason}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
