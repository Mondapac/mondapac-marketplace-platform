'use client';

import { useTranslations } from 'next-intl';
import { useId, useRef, useState, type InputHTMLAttributes, type Ref } from 'react';
import { Icon } from '../icons/icon.tsx';

type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'value' | 'onChange'>;

/**
 * A labelled input of the account pages: its hint, or its error in place of the hint, is read out
 * with it. Controlled when `value` is given.
 */
export function AcField({
  label,
  hint,
  error,
  value,
  onText,
  ...input
}: InputProps & {
  readonly label: string;
  readonly hint?: string | undefined;
  readonly error?: string | undefined;
  readonly value?: string;
  readonly onText?: (text: string) => void;
}) {
  const id = useId();
  return (
    <div className={error ? 'ac-fld bad' : 'ac-fld'}>
      <label htmlFor={id}>{label}</label>
      <FieldInput id={id} hint={hint} error={error} value={value} onText={onText} {...input} />
      <FieldHelp id={id} hint={hint} error={error} />
    </div>
  );
}

/** A password field with a show or hide button (44px; its name says what it will do). */
export function PasswordField({
  label,
  hint,
  error,
  value,
  onText,
  ...input
}: InputProps & {
  readonly label: string;
  readonly hint?: string | undefined;
  readonly error?: string | undefined;
  readonly value?: string;
  readonly onText?: (text: string) => void;
}) {
  const t = useTranslations('account.auth');
  const id = useId();
  const [shown, setShown] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div className={error ? 'ac-fld bad' : 'ac-fld'}>
      <label htmlFor={id}>{label}</label>
      <span className="ac-pw">
        <FieldInput
          ref={ref}
          id={id}
          hint={hint}
          error={error}
          value={value}
          onText={onText}
          {...input}
          type={shown ? 'text' : 'password'}
        />
        <button
          className="ac-eye"
          type="button"
          aria-pressed={shown}
          aria-label={shown ? t('hide-password') : t('show-password')}
          aria-controls={id}
          onClick={() => {
            setShown(!shown);
            ref.current?.focus({ preventScroll: true });
          }}
        >
          <Icon name={shown ? 'eye-off' : 'eye'} />
        </button>
      </span>
      <FieldHelp id={id} hint={hint} error={error} />
    </div>
  );
}

function FieldInput({
  id,
  hint,
  error,
  value,
  onText,
  ref,
  ...input
}: InputProps & {
  readonly id: string;
  readonly hint?: string | undefined;
  readonly error?: string | undefined;
  readonly value?: string | undefined;
  readonly onText?: ((text: string) => void) | undefined;
  readonly ref?: Ref<HTMLInputElement>;
}) {
  return (
    <input
      ref={ref}
      id={id}
      aria-invalid={error ? true : undefined}
      aria-describedby={(error ?? hint) ? `${id}-help` : undefined}
      {...(value === undefined ? {} : { value, onChange: (event) => onText?.(event.target.value) })}
      {...input}
    />
  );
}

/** The hint under a field, or its error in its place. */
function FieldHelp({
  id,
  hint,
  error,
}: {
  readonly id: string;
  readonly hint?: string | undefined;
  readonly error?: string | undefined;
}) {
  if (error)
    return (
      <small id={`${id}-help`} className="err">
        {error}
      </small>
    );
  return hint ? <small id={`${id}-help`}>{hint}</small> : null;
}
