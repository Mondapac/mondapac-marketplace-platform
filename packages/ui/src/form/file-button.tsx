'use client';

import type { ChangeEvent, InputHTMLAttributes, ReactNode, Ref } from 'react';
import { useId } from 'react';

export interface FileButtonProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'type' | 'id' | 'children' | 'onChange' | 'value' | 'className'
> {
  /** The button text ("Choose a picture"). */
  readonly children: ReactNode;
  /** The files the person picked (null when the picker was cancelled). */
  readonly onFiles: (files: FileList | null) => void;
  /** The file input, so a caller can focus it or clear it after a pick. */
  readonly inputRef?: Ref<HTMLInputElement>;
  readonly disabled?: boolean;
}

/**
 * A file picker that looks like a secondary Button. The real file input stays in the page, hidden
 * visually but focusable, so the keyboard (Tab, then Space or Enter) and screen readers get a
 * native control; the label is the visible button and shows the focus ring when the input has
 * focus. Disabled looks like a disabled Button and cannot be activated.
 */
export function FileButton({
  children,
  onFiles,
  inputRef,
  disabled = false,
  ...rest
}: FileButtonProps) {
  const id = useId();
  return (
    <>
      <input
        {...rest}
        ref={inputRef}
        id={id}
        type="file"
        disabled={disabled}
        className="peer sr-only"
        onChange={(event: ChangeEvent<HTMLInputElement>) => onFiles(event.target.files)}
      />
      <label
        htmlFor={id}
        className={`inline-flex h-(--mp-size-control) items-center justify-center rounded-md border border-line-control bg-surface px-4 font-medium peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-focus ${
          disabled ? 'cursor-not-allowed text-fg-muted' : 'cursor-pointer text-fg hover:bg-muted'
        }`}
      >
        {children}
      </label>
    </>
  );
}
