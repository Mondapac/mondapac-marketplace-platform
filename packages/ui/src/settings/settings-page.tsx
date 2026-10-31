'use client';

import type { FormEvent, ReactNode } from 'react';
import { useUnsavedChangesGuard, type LeaveLabels } from './unsaved-changes-guard.tsx';

export interface SettingsPageProps {
  /** The page's h1. */
  readonly title: string;
  /** One sentence under the title. */
  readonly description?: string;
  /** "Last changed by Sara K. · 2 days ago": the caller writes the text. */
  readonly lastChanged?: {
    readonly text: string;
    readonly historyHref?: string;
    readonly historyLabel?: string;
  };
  /** Buttons at the end of the header (pin, help). */
  readonly actions?: ReactNode;
  /** A read-only, conflict or error-summary `Banner` above the sections. */
  readonly banner?: ReactNode;
  /** Present: the sections and the save bar are one form, and Save submits it. */
  readonly onSubmit?: () => void;
  /** The `SaveBar`, inside the form, after the sections. */
  readonly saveBar?: ReactNode;
  /** True while a field differs from the saved value: leaving the page asks first. */
  readonly dirty?: boolean;
  readonly leave?: LeaveLabels;
  /** `SettingsSection`s. */
  readonly children: ReactNode;
}

/**
 * The one frame of a settings page: header (title, description, last change, actions), a banner
 * slot, the sections, and the save bar. It also guards the page against being left with unsaved
 * changes. The path above the title is the shell's own breadcrumb.
 */
export function SettingsPage({
  title,
  description,
  lastChanged,
  actions,
  banner,
  onSubmit,
  saveBar,
  dirty = false,
  leave,
  children,
}: SettingsPageProps) {
  const guard = useUnsavedChangesGuard(
    dirty && leave !== undefined,
    leave ?? { title: '', message: '', stay: '', leave: '' },
  );
  const body = (
    <>
      {children}
      {saveBar}
    </>
  );
  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold text-fg">{title}</h1>
          {description ? (
            <p className="mt-1 max-w-prose text-sm text-fg-muted">{description}</p>
          ) : null}
          {lastChanged ? (
            <p className="mt-1 text-xs text-fg-muted">
              {lastChanged.text}
              {lastChanged.historyHref && lastChanged.historyLabel ? (
                <>
                  {' · '}
                  <a href={lastChanged.historyHref} className="font-medium text-link underline">
                    {lastChanged.historyLabel}
                  </a>
                </>
              ) : null}
            </p>
          ) : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </header>
      {banner}
      {onSubmit ? (
        <form
          className="flex flex-col gap-4"
          noValidate
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          {body}
        </form>
      ) : (
        body
      )}
      {guard.dialog}
    </div>
  );
}
