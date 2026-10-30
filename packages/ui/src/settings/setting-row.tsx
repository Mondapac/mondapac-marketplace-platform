'use client';

import {
  createContext,
  useContext,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import type { SelectOption } from '../form/select.tsx';

interface SettingField {
  readonly id: string;
  readonly describedBy: string | undefined;
  readonly invalid: boolean;
  readonly changed: boolean;
  readonly disabled: boolean;
}

const FieldContext = createContext<SettingField | null>(null);

/** The wiring the row gives its control: id, aria-describedby, invalid and changed state. */
export function useSettingField(): SettingField {
  const field = useContext(FieldContext);
  if (field === null) throw new Error('A setting control must be inside a SettingRow.');
  return field;
}

export interface SettingRowProps {
  readonly label: string;
  /** Marks the label "(optional)"; the word comes from the caller. */
  readonly optionalLabel?: string;
  /** Help text under the label, on the start side. */
  readonly help?: ReactNode;
  /** Error text under the control; setting it marks the control invalid. */
  readonly error?: string | undefined;
  /** The value differs from the saved one: the control gets the attention ring. */
  readonly changed?: boolean;
  /** The row is view-only: its controls are disabled. */
  readonly disabled?: boolean;
  /** A group of controls (radios): the label names the group instead of one control. */
  readonly group?: boolean;
  /** A value shown as text, with no control: the label is plain text, not a `<label>`. */
  readonly plain?: boolean;
  /** Anchor for an error summary link; generated when absent. */
  readonly id?: string;
  /** One control (`SettingInput`, `SettingSelect`, `SettingCheckbox`) or a group of them. */
  readonly children: ReactNode;
}

/**
 * One setting: label and help on the start side, the control on the end side from 760 px, one
 * column below it. The label is a real label for the control (or names a group); help and error
 * text are tied to the control with aria-describedby.
 */
export function SettingRow({
  label,
  optionalLabel,
  help,
  error,
  changed = false,
  disabled = false,
  group = false,
  plain = false,
  id: given,
  children,
}: SettingRowProps) {
  const generated = useId();
  const id = given ?? generated;
  const labelId = `${id}-label`;
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  const describedBy = [help ? helpId : null, error ? errorId : null].filter(Boolean).join(' ');
  const text = (
    <>
      {label}
      {optionalLabel ? <span className="font-normal text-fg-muted"> ({optionalLabel})</span> : null}
    </>
  );
  return (
    <div
      role={group ? 'group' : undefined}
      aria-labelledby={group ? labelId : undefined}
      aria-describedby={group ? describedBy || undefined : undefined}
      className="grid gap-1.5 border-b border-line-row px-5 py-4 last:border-b-0 md:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] md:gap-4"
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        {group || plain ? (
          <span id={labelId} className="text-sm font-medium text-fg">
            {text}
          </span>
        ) : (
          <label id={labelId} htmlFor={id} className="text-sm font-medium text-fg">
            {text}
          </label>
        )}
        {help ? (
          <p id={helpId} className="text-sm text-fg-muted">
            {help}
          </p>
        ) : null}
      </div>
      <div className="min-w-0">
        <FieldContext.Provider
          value={{
            id,
            describedBy: group ? undefined : describedBy || undefined,
            invalid: Boolean(error),
            changed,
            disabled,
          }}
        >
          {children}
        </FieldContext.Provider>
        {error ? (
          <p id={errorId} className="mt-1.5 text-sm text-critical-fg">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** The edge of a control: critical when invalid, the attention ring when changed. */
function edge(field: SettingField): string {
  if (field.invalid) return 'border-critical-solid';
  return field.changed
    ? 'border-attention-solid ring-2 ring-attention-border'
    : 'border-line-input';
}

export interface SettingInputProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'id' | 'aria-describedby' | 'aria-invalid' | 'disabled'
> {
  /** Fixed text before the value, shown inside the control (US$). Left-to-right. */
  readonly prefix?: string;
}

/** A text input for a `SettingRow`: the row names it, so it has no label of its own. */
export function SettingInput({ prefix, className, ...rest }: SettingInputProps) {
  const field = useSettingField();
  return (
    <div className="flex items-center">
      {prefix ? (
        <span
          dir="ltr"
          className="flex h-(--mp-size-control) items-center rounded-s-md border border-e-0 border-line-input bg-subtle px-3 text-fg-muted"
        >
          {prefix}
        </span>
      ) : null}
      <input
        id={field.id}
        aria-invalid={field.invalid ? true : undefined}
        aria-describedby={field.describedBy}
        disabled={field.disabled}
        className={[
          'h-(--mp-size-control) w-full border bg-surface px-3 text-fg disabled:bg-subtle disabled:text-fg-muted',
          prefix ? 'rounded-e-md' : 'rounded-md',
          edge(field),
          className ?? '',
        ]
          .filter(Boolean)
          .join(' ')}
        {...rest}
      />
    </div>
  );
}

export interface SettingTextAreaProps extends Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  'id' | 'aria-describedby' | 'aria-invalid' | 'disabled'
> {
  /** A line under the control that counts characters ("120 of 2000"); part of its description. */
  readonly counter?: ReactNode;
}

/** A multi-line text control for a `SettingRow`, with an optional character counter. */
export function SettingTextArea({ counter, rows = 6, className, ...rest }: SettingTextAreaProps) {
  const field = useSettingField();
  const counterId = `${field.id}-counter`;
  const describedBy = [field.describedBy, counter ? counterId : null].filter(Boolean).join(' ');
  return (
    <div className="flex flex-col gap-1.5">
      <textarea
        id={field.id}
        rows={rows}
        aria-invalid={field.invalid ? true : undefined}
        aria-describedby={describedBy || undefined}
        disabled={field.disabled}
        className={[
          'w-full rounded-md border bg-surface px-3 py-2 text-fg disabled:bg-subtle disabled:text-fg-muted',
          edge(field),
          className ?? '',
        ]
          .filter(Boolean)
          .join(' ')}
        {...rest}
      />
      {counter ? (
        <div id={counterId} className="text-sm text-fg-muted">
          {counter}
        </div>
      ) : null}
    </div>
  );
}

export interface SettingSelectProps extends Omit<
  SelectHTMLAttributes<HTMLSelectElement>,
  'id' | 'aria-describedby' | 'aria-invalid' | 'children' | 'disabled'
> {
  readonly options: readonly SelectOption[];
  readonly placeholder?: string;
}

/** A native select for a `SettingRow`. */
export function SettingSelect({ options, placeholder, className, ...rest }: SettingSelectProps) {
  const field = useSettingField();
  return (
    <select
      id={field.id}
      aria-invalid={field.invalid ? true : undefined}
      aria-describedby={field.describedBy}
      disabled={field.disabled}
      className={[
        'h-(--mp-size-control) w-full rounded-md border bg-surface px-3 text-fg disabled:bg-subtle disabled:text-fg-muted',
        edge(field),
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    >
      {placeholder === undefined ? null : <option value="">{placeholder}</option>}
      {options.map((option) => (
        <option key={option.value} value={option.value} disabled={option.disabled}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

export interface SettingCheckboxProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'id' | 'type' | 'aria-describedby' | 'aria-invalid' | 'disabled'
> {
  /** The state in words next to the box ("On" / "Off"); the row's label names the setting. */
  readonly text?: string;
}

/** A checkbox for a `SettingRow`, with the state in words beside it. */
export function SettingCheckbox({ text, className, ...rest }: SettingCheckboxProps) {
  const field = useSettingField();
  return (
    <span className="inline-flex items-center gap-2">
      <input
        id={field.id}
        type="checkbox"
        aria-describedby={field.describedBy}
        disabled={field.disabled}
        className={[
          'size-5 rounded-sm accent-accent disabled:cursor-not-allowed disabled:outline-1 disabled:outline-line-control',
          field.changed ? 'outline-2 outline-offset-2 outline-attention-solid' : '',
          className ?? '',
        ]
          .filter(Boolean)
          .join(' ')}
        {...rest}
      />
      {text ? (
        <span aria-hidden="true" className="text-sm text-fg-secondary">
          {text}
        </span>
      ) : null}
    </span>
  );
}
