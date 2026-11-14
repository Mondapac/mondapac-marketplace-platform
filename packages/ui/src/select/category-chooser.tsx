'use client';

import { useId } from 'react';
import { Badge } from '../form/badge.tsx';
import { Button } from '../form/button.tsx';
import {
  MAX_PRODUCT_CATEGORIES,
  addCategory,
  choiceLabel,
  makePrimary,
  removeCategory,
  type CategoryChoice,
} from './category-chooser-logic.ts';
import { SearchSelect, type SearchSelectLabels } from './search-select.tsx';

export type { CategoryChoice } from './category-chooser-logic.ts';

/** The words the chooser shows; the caller passes the panel's own copy. */
export interface CategoryChooserLabels {
  readonly legend: string;
  /** The hint under the legend. */
  readonly hint: string;
  readonly general: string;
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
            const itemError = itemErrors[index];
            const itemErrorId = `${base}-item-${index}-error`;
            const choice = byId.get(id);
            return (
              <li
                key={id}
                className="flex flex-wrap items-center gap-2 rounded-md border border-line px-3 py-2"
              >
                <span className="min-w-0 flex-1 break-words" dir="auto">
                  {label}
                </span>
                {index === 0 ? <Badge tone="info">{labels.primary}</Badge> : null}
                {choice?.status === 'hidden' ? <Badge tone="neutral">{labels.hidden}</Badge> : null}
                {index > 0 ? (
                  <Button
                    variant="secondary"
                    type="button"
                    disabled={disabled}
                    aria-label={labels.makePrimary(label)}
                    onClick={() => onChange(makePrimary(value, id))}
                  >
                    {labels.makePrimaryText}
                  </Button>
                ) : null}
                <Button
                  variant="secondary"
                  type="button"
                  disabled={disabled}
                  aria-label={labels.remove(label)}
                  onClick={() => onChange(removeCategory(value, id))}
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
        <p className="m-0 text-sm text-fg-muted">{labels.limitReached}</p>
      ) : (
        <div onFocusCapture={onOpen} onClickCapture={onOpen}>
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
              ...(choice.status === 'hidden' ? { description: labels.hidden } : {}),
            }))}
            value={null}
            onChange={(picked) => {
              if (picked !== null) onChange(addCategory(value, picked.value, max));
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
