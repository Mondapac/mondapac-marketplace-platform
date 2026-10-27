'use client';

import { TextField, type TextFieldProps } from '@mondapac/ui';

/**
 * A text field for an amount typed in major units of a currency ("25.00", "2500" for yen). It only
 * sets the input mode and direction; parsing by the currency's decimals is `parseAmount`.
 */
export function MoneyField(props: Omit<TextFieldProps, 'inputMode' | 'dir' | 'autoComplete'>) {
  return (
    <TextField {...props} inputMode="decimal" dir="ltr" autoComplete="off" spellCheck={false} />
  );
}
