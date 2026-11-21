'use client';

import {
  useId,
  useRef,
  useState,
  type ClipboardEvent,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

/**
 * The widest the row of boxes gets: `length` boxes of 3rem (`max-w-12`) with 0.5rem gaps (`gap-2`).
 * Keep in step with the box and gap classes below.
 */
export function otpRowWidth(length = 6): string {
  return `${length * 3 + (length - 1) * 0.5}rem`;
}

export interface OtpColumnProps {
  /** Number of boxes in the `OtpField` inside, so the column matches its row. */
  readonly length?: number;
  readonly children: ReactNode;
}

/**
 * A column exactly as wide as an `OtpField` row: the field, the submit button and the links under
 * it line up with the boxes. Below that width (phones) it fills its parent and the boxes shrink.
 */
export function OtpColumn({ length = 6, children }: OtpColumnProps) {
  return (
    <div className="flex w-full flex-col gap-5" style={{ maxWidth: otpRowWidth(length) }}>
      {children}
    </div>
  );
}

export interface OtpFieldProps {
  /** The group label, shown above the boxes. */
  readonly label: string;
  /** The accessible name of one box, e.g. "Digit 2 of 6". */
  readonly digitLabel: (position: number, total: number) => string;
  /** Number of boxes. */
  readonly length?: number;
  readonly name?: string;
  /** Error text; setting it marks every box invalid. */
  readonly error?: string | undefined;
  /** Boxes stay in place but ignore input (a request is running). */
  readonly readOnly?: boolean;
  /** Focus the first box on mount. Remount the field (a new `key`) to clear it and refocus. */
  readonly autoFocus?: boolean;
  /** Id of text that explains the step (the instructions), added to the group's description. */
  readonly describedBy?: string;
  /** Every change, as the digits typed so far (gaps removed). */
  readonly onChange?: (code: string) => void;
  /** Called once when the last box is filled and the code is complete. */
  readonly onComplete?: (code: string) => void;
}

/** One digit per box: typing advances, Backspace and the arrow keys move, a paste fills the row. */
export function OtpField({
  label,
  digitLabel,
  length = 6,
  name,
  error,
  readOnly = false,
  autoFocus = false,
  describedBy,
  onChange,
  onComplete,
}: OtpFieldProps) {
  const id = useId();
  const errorId = `${id}-error`;
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const [digits, setDigits] = useState<readonly string[]>(() => Array.from({ length }, () => ''));

  function commit(next: string[]) {
    setDigits(next);
    const code = next.join('');
    onChange?.(code);
    if (code.length === length) onComplete?.(code);
  }

  function focusBox(index: number) {
    const box = refs.current[Math.max(0, Math.min(length - 1, index))];
    box?.focus();
    box?.select();
  }

  /** Writes `typed` from box `start` on; returns the box that should take focus next. */
  function fill(start: number, typed: string): number {
    const next = [...digits];
    // A whole code pasted or autofilled lands from the first box, not from the one in focus.
    const from = typed.length >= length ? 0 : start;
    let index = from;
    for (const digit of typed.slice(0, length - from)) {
      next[index] = digit;
      index += 1;
    }
    commit(next);
    return index;
  }

  function onInput(index: number, event: ChangeEvent<HTMLInputElement>) {
    if (readOnly) return;
    const typed = event.target.value.replace(/\D/g, '');
    if (typed === '') {
      const next = [...digits];
      next[index] = '';
      commit(next);
      return;
    }
    focusBox(fill(index, typed));
  }

  function onKeyDown(index: number, event: KeyboardEvent<HTMLInputElement>) {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === 'Backspace') {
      event.preventDefault();
      if (readOnly) return;
      const next = [...digits];
      if (next[index] === '' && index > 0) {
        next[index - 1] = '';
        commit(next);
        focusBox(index - 1);
      } else {
        next[index] = '';
        commit(next);
      }
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      focusBox(index - 1);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      focusBox(index + 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      focusBox(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      focusBox(length - 1);
    } else if (/^\d$/.test(event.key)) {
      event.preventDefault();
      if (!readOnly) focusBox(fill(index, event.key));
    }
  }

  function onPaste(index: number, event: ClipboardEvent<HTMLInputElement>) {
    event.preventDefault();
    if (readOnly) return;
    const typed = event.clipboardData.getData('text').replace(/\D/g, '');
    if (typed !== '') focusBox(fill(index, typed));
  }

  return (
    <div
      role="group"
      aria-labelledby={`${id}-label`}
      aria-describedby={
        [describedBy, error ? errorId : null].filter(Boolean).join(' ') || undefined
      }
      className="flex flex-col gap-1.5"
    >
      <span id={`${id}-label`} className="text-sm font-medium text-fg">
        {label}
      </span>
      <div dir="ltr" className="flex gap-2">
        {digits.map((digit, index) => (
          <input
            // The boxes are positional and never reorder.
            key={index}
            ref={(element) => {
              refs.current[index] = element;
            }}
            name={name ? `${name}-${index + 1}` : undefined}
            type="text"
            inputMode="numeric"
            autoComplete={index === 0 ? 'one-time-code' : 'off'}
            autoFocus={autoFocus && index === 0}
            aria-label={digitLabel(index + 1, length)}
            aria-invalid={error ? true : undefined}
            value={digit}
            readOnly={readOnly}
            onChange={(event) => onInput(index, event)}
            onKeyDown={(event) => onKeyDown(index, event)}
            onPaste={(event) => onPaste(index, event)}
            onFocus={(event) => event.target.select()}
            className={[
              'h-12 min-w-0 max-w-12 flex-1 rounded-md border bg-surface text-center text-lg text-fg',
              error ? 'border-critical-solid' : 'border-line-input',
            ].join(' ')}
          />
        ))}
      </div>
      {error ? (
        <p id={errorId} className="text-sm text-critical-fg">
          {error}
        </p>
      ) : null}
    </div>
  );
}
