'use client';

import { useEffect, useRef, type InputHTMLAttributes } from 'react';

export interface SelectBoxProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'type' | 'aria-label' | 'checked' | 'className'
> {
  /** What the box selects, read by assistive technology ("Select Lamb cutlets"). */
  readonly label: string;
  readonly checked: boolean;
  /** Some but not all of a group are selected (the header box of a table). */
  readonly indeterminate?: boolean;
}

/**
 * The checkbox of a table row or header: no visible text, so `label` is its accessible name. The
 * box is 16 px and its click target grows to 40 px square around it without moving the layout,
 * so rows and headers line up on the box itself. `indeterminate` is set on the element, the only
 * way a browser draws the dash.
 */
export function SelectBox({ label, checked, indeterminate = false, ...rest }: SelectBoxProps) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (input.current !== null) input.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <label className="-m-3 inline-flex size-10 cursor-pointer items-center justify-center">
      <input
        ref={input}
        type="checkbox"
        aria-label={label}
        checked={checked}
        className="size-4 shrink-0 cursor-pointer accent-accent disabled:cursor-not-allowed"
        {...rest}
      />
    </label>
  );
}
