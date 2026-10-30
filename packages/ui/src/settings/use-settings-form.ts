'use client';

import { useCallback, useRef, useState, type SetStateAction } from 'react';

/** One field that differs between the saved settings and the draft, as plain text. */
export interface FieldChange {
  readonly key: string;
  readonly label: string;
  /** The saved value, as the page words it. Shown as text only. */
  readonly saved: string;
  /** The draft value, as the page words it. Shown as text only. */
  readonly yours: string;
}

/** What a page's write maps its answer to; the hook never reads an API failure itself. */
export type SaveResult<S> =
  | { readonly status: 'saved'; readonly saved: S }
  /** The page's conflict code: someone saved first. */
  | { readonly status: 'conflict' }
  /** Any other refusal; the page has already shown it. */
  | { readonly status: 'failed' };

export interface UseSettingsFormOptions<S, D> {
  /** What the server holds now. */
  readonly initial: S;
  /** The editable draft of a saved value. */
  readonly toDraft: (saved: S) => D;
  /** The version the next write sends as `expectedVersion`. */
  readonly versionOf: (saved: S) => number;
  /** The fields where the draft differs from the saved value; its length is the dirty count. */
  readonly changes: (saved: S, draft: D) => readonly FieldChange[];
  /** GET the current saved value after a conflict; null when it cannot be read. */
  readonly reload: () => Promise<S | null>;
}

export type RunResult<S> = SaveResult<S> & {
  /** On a conflict: false when the re-read failed, so `theirs` is not set. */
  readonly reloaded?: boolean;
};

export interface SettingsForm<S, D> {
  readonly saved: S;
  readonly draft: D;
  readonly setDraft: (next: SetStateAction<D>) => void;
  /** Changed fields, measured against `saved` (after a conflict: against what is saved now). */
  readonly changes: readonly FieldChange[];
  readonly count: number;
  readonly dirty: boolean;
  readonly saving: boolean;
  /** The settings someone else saved, from the re-GET after a conflict; null otherwise. */
  readonly theirs: S | null;
  /** Counts conflicts; a view keyed on it starts closed for each new conflict. */
  readonly conflictId: number;
  /**
   * Runs one write with the version the form holds now. `saved` replaces the baseline and the
   * draft. `conflict` re-reads the settings, keeps the draft and sets `theirs`; the next write
   * then carries the new version.
   */
  readonly run: (
    write: (expectedVersion: number) => Promise<SaveResult<S>>,
  ) => Promise<RunResult<S>>;
  /** Draft back to the saved value; clears the conflict. */
  readonly discard: () => void;
  /** Takes a value from the server as the new baseline and draft. */
  readonly adopt: (next: S) => void;
}

/**
 * The state of one settings page that saves all its fields in one write: the saved baseline, the
 * draft, the dirty count, and the "someone saved first" path (optimistic version). The hook is
 * market- and language-agnostic: the page words every label and value.
 */
export function useSettingsForm<S, D>(options: UseSettingsFormOptions<S, D>): SettingsForm<S, D> {
  const { toDraft, versionOf, reload } = options;
  const [saved, setSaved] = useState(options.initial);
  const [draft, setDraft] = useState<D>(() => toDraft(options.initial));
  const [theirs, setTheirs] = useState<S | null>(null);
  const [conflictId, setConflictId] = useState(0);
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  // A write reads the newest saved value, not the one a stale closure saw.
  const latest = useRef(saved);

  const adopt = useCallback(
    (next: S) => {
      latest.current = next;
      setSaved(next);
      setDraft(toDraft(next));
      setTheirs(null);
    },
    [toDraft],
  );

  const run = useCallback(
    async (write: (expectedVersion: number) => Promise<SaveResult<S>>): Promise<RunResult<S>> => {
      if (busy.current) return { status: 'failed' };
      busy.current = true;
      setSaving(true);
      try {
        const result = await write(versionOf(latest.current));
        if (result.status === 'saved') {
          adopt(result.saved);
          return result;
        }
        if (result.status === 'conflict') {
          const fresh = await reload();
          if (fresh === null) return { status: 'conflict', reloaded: false };
          // The draft stays; only the baseline (and so the version) moves to what is saved now.
          latest.current = fresh;
          setSaved(fresh);
          setTheirs(fresh);
          setConflictId((n) => n + 1);
          return { status: 'conflict', reloaded: true };
        }
        return result;
      } finally {
        busy.current = false;
        setSaving(false);
      }
    },
    [adopt, reload, versionOf],
  );

  const discard = useCallback(() => {
    setDraft(toDraft(latest.current));
    setTheirs(null);
  }, [toDraft]);

  const changes = options.changes(saved, draft);
  return {
    saved,
    draft,
    setDraft,
    changes,
    count: changes.length,
    dirty: changes.length > 0,
    saving,
    theirs,
    conflictId,
    run,
    discard,
    adopt,
  };
}
