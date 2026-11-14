'use client';

import { useEffect, useId, useRef } from 'react';
import { Badge } from '../form/badge.tsx';
import { Button } from '../form/button.tsx';
import {
  MAX_PRODUCT_CATEGORIES,
  addCategory,
  choiceLabel,
  choiceParts,
  focusAfterRemove,
  makePrimary,
  removeCategory,
  splitLabel,
  type CategoryChoice,
  type FocusTarget,
} from './category-chooser-logic.ts';
import { SearchSelect, type SearchSelectLabels } from './search-select.tsx';

export type { CategoryChoice } from './category-chooser-logic.ts';

/** The words the chooser shows; the caller passes the panel's own copy. */
export interface CategoryChooserLabels {
  readonly legend: string;
  /** The hint under the legend. */
  readonly hint: string;
  readonly general: string;
  /** The note under a general choice in the select ("Not in a subcategory"). */
  readonly generalHint: string;
  readonly primary: string;
  readonly hidden: string;
  readonly makePrimary: (name: string) => string;
  readonly makePrimaryText: string;
  readonly remove: (name: string) => string;
  readonly removeText: string;
  readonly add: string;
  readonly addPlaceholder: string;
  readonly empty: string;
  readonly limitReached: string;
  readonly loading: string;
  readonly loadError: string;
  readonly retry: string;
  readonly search: string;
  readonly noResults: string;
  /** Said once when the list changes (a live region). */
  readonly added: (name: string) => string;
  readonly removed: (name: string) => string;
  readonly madePrimary: (name: string) => string;
}

export interface CategoryChooserProps {
  readonly choices: readonly CategoryChoice[];
  /** The chosen category ids; the first is the primary one. */
  readonly value: readonly string[];
  readonly onChange: (ids: string[]) => void;
  readonly labels: CategoryChooserLabels;
  /** The choices are being fetched. */
  readonly loading?: boolean;
  /** The fetch failed; the field says so and offers `onRetry`. */
  readonly failed?: boolean;
  /** Retry after a failure; also called the first time the Add control gets focus (lazy fetch). */
  readonly onRetry?: () => void;
  /** Called when focus first enters the Add control: the owner may fetch the choices then. */
  readonly onOpen?: () => void;
  /** A refusal of the whole list (nothing chosen, too many). */
  readonly error?: string | undefined;
  /** A refusal of one chosen category, by its place in `value`. */
  readonly itemErrors?: Readonly<Record<number, string>>;
  /** A name for a chosen id the picker does not offer (an upper-level or retired category). */
  readonly nameOf?: (id: string) => string;
  readonly max?: number;
  readonly disabled?: boolean;
  /** A note after the last add, remove or Make primary, for screen readers. */
  readonly announcement?: string;
}

/**
 * The category field of a product form: the chosen categories as a list (the first one marked
 * Primary, with Make primary and Remove on the others) and a searchable select that adds one.
 * A choice shows its path, and "General" for the level-3 category itself; a department or group is
 * never offered. Keyboard: every control is a button or the select's combobox.
 */
export function CategoryChooser({
  choices,
  value,
  onChange,
  labels,
  loading = false,
  failed = false,
  onRetry,
  onOpen,
  error,
  itemErrors = {},
  nameOf,
  max = MAX_PRODUCT_CATEGORIES,
  disabled = false,
  announcement,
}: CategoryChooserProps) {
  const base = useId();
  const byId = new Map(choices.map((choice) => [choice.id, choice]));
  const nameFor = (id: string): string => {
    const choice = byId.get(id);
    return choice === undefined ? (nameOf?.(id) ?? id) : choiceLabel(choice, labels.general);
  };
  const free = choices.filter((choice) => !value.includes(choice.id));
  const full = value.length >= max;
  const selectLabels: Partial<SearchSelectLabels> = {
    search: labels.search,
    noResults: labels.noResults,
    loading: labels.loading,
    retry: labels.retry,
  };
  const removeButtons = useRef(new Map<string, HTMLButtonElement>());
  const addBox = useRef<HTMLDivElement>(null);
  const limitNote = useRef<HTMLParagraphElement>(null);
  const pendingFocus = useRef<FocusTarget | null>(null);
  // Focus follows the change once the list is drawn: a removed or moved row would drop it to the page.
  useEffect(() => {
    const target = pendingFocus.current;
    if (target === null) return;
    pendingFocus.current = null;
    if (target.kind === 'row') removeButtons.current.get(target.id)?.focus();
    else if (target.kind === 'limit') limitNote.current?.focus();
    else addBox.current?.querySelector<HTMLElement>('[role="combobox"]')?.focus();
  }, [value]);
  const describe = (choice: CategoryChoice) => {
    const notes = [
      ...(choice.general ? [labels.generalHint] : []),
      ...(choice.status === 'hidden' ? [labels.hidden] : []),
    ];
    return notes.length === 0 ? {} : { description: notes.join(' · ') };
  };
  const hintId = `${base}-hint`;
  const errorId = `${base}-error`;
  return (
    <fieldset
      className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0"
      aria-describedby={error === undefined ? hintId : `${hintId} ${errorId}`}
    >
      <legend className="mb-1 text-sm font-medium text-fg">{labels.legend}</legend>
      <p id={hintId} className="m-0 text-sm text-fg-muted">
        {labels.hint}
      </p>
      {value.length === 0 ? (
        <p className="m-0 text-sm text-fg-muted">{labels.empty}</p>
      ) : (
        <ol className="m-0 flex list-none flex-col gap-2 p-0">
          {value.map((id, index) => {
            const label = nameFor(id);
            const choice = byId.get(id);
            const parts =
              choice === undefined ? splitLabel(label) : choiceParts(choice, labels.general);
            const itemError = itemErrors[index];
            const itemErrorId = `${base}-item-${index}-error`;
            const describedBy = itemError === undefined ? undefined : itemErrorId;
            return (
              <li
                key={id}
                className="flex flex-wrap items-center gap-2 rounded-md border border-line px-3 py-2"
              >
                <span className="min-w-0 flex-1 break-words" dir="auto">
                  {parts.map((part, at) => (
                    <span key={at}>
                      {at > 0 ? (
                        <>
                          <span aria-hidden="true"> › </span>
                          <span className="sr-only">, </span>
                        </>
                      ) : null}
                      {part}
                    </span>
                  ))}
                </span>
                {index === 0 ? <Badge tone="info">{labels.primary}</Badge> : null}
                {choice?.status === 'hidden' ? <Badge tone="neutral">{labels.hidden}</Badge> : null}
                {index > 0 ? (
                  <Button
                    variant="secondary"
                    type="button"
                    disabled={disabled}
                    aria-label={labels.makePrimary(label)}
                    aria-describedby={describedBy}
                    onClick={() => {
                      pendingFocus.current = { kind: 'row', id };
                      onChange(makePrimary(value, id));
                    }}
                  >
                    {labels.makePrimaryText}
                  </Button>
                ) : null}
                <Button
                  ref={(node: HTMLButtonElement | null) => {
                    if (node === null) removeButtons.current.delete(id);
                    else removeButtons.current.set(id, node);
                  }}
                  variant="secondary"
                  type="button"
                  disabled={disabled}
                  aria-label={labels.remove(label)}
                  aria-describedby={describedBy}
                  onClick={() => {
                    pendingFocus.current = focusAfterRemove(value, id);
                    onChange(removeCategory(value, id));
                  }}
                >
                  {labels.removeText}
                </Button>
                {itemError === undefined ? null : (
                  <p id={itemErrorId} role="alert" className="m-0 w-full text-sm text-critical-fg">
                    {itemError}
                  </p>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {error === undefined ? null : (
        <p id={errorId} role="alert" className="m-0 text-sm text-critical-fg">
          {error}
        </p>
      )}
      {full ? (
        <p ref={limitNote} tabIndex={-1} className="m-0 text-sm text-fg-muted">
          {labels.limitReached}
        </p>
      ) : (
        <div ref={addBox} onFocusCapture={onOpen} onClickCapture={onOpen}>
          <SearchSelect
            label={labels.add}
            placeholder={labels.addPlaceholder}
            alwaysSearch
            disabled={disabled}
            loading={loading}
            loadError={failed ? labels.loadError : undefined}
            {...(onRetry === undefined ? {} : { onRetry })}
            labels={selectLabels}
            options={free.map((choice) => ({
              value: choice.id,
              label: choiceLabel(choice, labels.general),
              ...describe(choice),
            }))}
            value={null}
            onChange={(picked) => {
              if (picked === null) return;
              const next = addCategory(value, picked.value, max);
              // The last free slot takes the Add control away: focus goes to the note that says why.
              if (next.length >= max && next.length > value.length) {
                pendingFocus.current = { kind: 'limit' };
              }
              onChange(next);
            }}
          />
        </div>
      )}
      <p className="sr-only" role="status" aria-live="polite">
        {announcement ?? ''}
      </p>
    </fieldset>
  );
}
