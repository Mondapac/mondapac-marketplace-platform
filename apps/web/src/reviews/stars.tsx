'use client';

import { useId, type ReactNode } from 'react';

// Stars for the reviews pages. The row is drawn with text glyphs in two layers, the filled one
// cut to the share of the value from the reading start (`inset-inline-start`), so the same markup
// fills from the right in a right-to-left page. The glyphs are decorative: the accessible name is
// the caller's text ("4.6 out of 5").

/** A read-only row of stars; `value` may have a fraction. */
export function Stars({
  value,
  label,
}: {
  readonly value: number;
  /** The accessible name ("4 out of 5 stars"). */
  readonly label: string;
}) {
  const share = Math.max(0, Math.min(5, value)) * 20;
  return (
    <span className="rv-stars" role="img" aria-label={label}>
      <span className="rv-stars-bg" aria-hidden="true">
        ★★★★★
      </span>
      <span className="rv-stars-fg" aria-hidden="true" style={{ inlineSize: `${share}%` }}>
        ★★★★★
      </span>
    </span>
  );
}

/**
 * A required 1 to 5 choice: native radio buttons, so the arrow keys and a screen reader work
 * without code. The legend is the question.
 */
export function StarInput({
  legend,
  value,
  onChange,
  optionLabel,
  error,
  required = true,
}: {
  readonly legend: ReactNode;
  readonly value: number;
  /** 0 is "not chosen yet". */
  readonly onChange: (value: number) => void;
  /** The name of the n-star choice ("3 stars"). */
  readonly optionLabel: (stars: number) => string;
  readonly error?: string | undefined;
  readonly required?: boolean;
}) {
  const group = useId();
  const errorId = `${group}-error`;
  return (
    <fieldset
      className={error ? 'rv-pick bad' : 'rv-pick'}
      aria-describedby={error ? errorId : undefined}
    >
      <legend>{legend}</legend>
      <div className="rv-pick-row">
        {[1, 2, 3, 4, 5].map((n) => (
          <label key={n} className={n <= value ? 'on' : undefined}>
            <input
              type="radio"
              name={group}
              value={n}
              checked={value === n}
              required={required}
              onChange={() => onChange(n)}
            />
            <span aria-hidden="true">★</span>
            <span className="sr-only">{optionLabel(n)}</span>
          </label>
        ))}
      </div>
      {error ? (
        <small id={errorId} className="err" role="alert">
          {error}
        </small>
      ) : null}
    </fieldset>
  );
}
