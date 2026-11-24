'use client';

import { useEffect, useRef, type FormEvent } from 'react';
import { Button } from '../form/button.tsx';
import { TextField } from '../form/text-field.tsx';

export interface RangeFormLabels {
  /** The form's accessible name ("Custom range"). */
  readonly form: string;
  readonly from: string;
  readonly to: string;
  readonly apply: string;
}

/**
 * The from/to pickers of a custom dashboard range, with the refusals under their fields. The page
 * words everything (it knows the Market's days and formats them): `fromError` and `toError` sit
 * under their field and are announced (`role="alert"`, once); `generalError` is a refusal that
 * belongs to neither day, under the pair. `focusSignal` changes after every refused Apply, so focus
 * moves to the first invalid field. `showing` names what the figures show until Apply; null hides
 * the line (a refused range has no figures).
 */
export function RangeForm({
  labels,
  from,
  to,
  min,
  max,
  fromError,
  toError,
  generalError,
  help,
  showing,
  busy,
  focusSignal,
  onChange,
  onApply,
}: {
  readonly labels: RangeFormLabels;
  readonly from: string;
  readonly to: string;
  /** The earliest day `from` may take for the `to` shown. */
  readonly min: string;
  /** The latest day either may take (the Market's today). */
  readonly max: string;
  readonly fromError?: string | undefined;
  readonly toError?: string | undefined;
  readonly generalError?: string | null | undefined;
  readonly help: string;
  readonly showing: string | null;
  readonly busy: boolean;
  readonly focusSignal: number;
  readonly onChange: (next: { from: string; to: string }) => void;
  readonly onApply: () => void;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (focusSignal === 0) return;
    formRef.current?.querySelector<HTMLInputElement>('input[aria-invalid="true"]')?.focus();
  }, [focusSignal]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onApply();
  };
  return (
    <form
      ref={formRef}
      aria-label={labels.form}
      onSubmit={submit}
      noValidate
      className="flex flex-wrap items-start gap-3 rounded-lg border border-line bg-surface p-3"
    >
      <TextField
        label={labels.from}
        type="date"
        name="from"
        value={from}
        min={min}
        max={max}
        error={fromError}
        announceError
        onChange={(event) => onChange({ from: event.target.value, to })}
      />
      <TextField
        label={labels.to}
        type="date"
        name="to"
        value={to}
        max={max}
        error={toError}
        announceError
        onChange={(event) => onChange({ from, to: event.target.value })}
      />
      <div className="flex flex-col gap-1.5 self-end">
        <Button type="submit" disabled={busy}>
          {labels.apply}
        </Button>
      </div>
      {generalError === null || generalError === undefined ? null : (
        <p role="alert" className="w-full text-sm text-critical-fg">
          {generalError}
        </p>
      )}
      <p className="w-full text-xs text-fg-muted">{help}</p>
      {showing === null ? null : <p className="w-full text-xs text-fg-muted">{showing}</p>}
    </form>
  );
}
