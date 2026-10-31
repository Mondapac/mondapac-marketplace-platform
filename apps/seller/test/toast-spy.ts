import { screen, waitFor } from '@testing-library/react';
import { toast, type ToastOptions } from '@mondapac/ui';
import { afterEach, beforeEach, expect, vi, type MockInstance } from 'vitest';

type Kind = 'success' | 'error' | 'info' | 'warning';
const KINDS: readonly Kind[] = ['success', 'error', 'info', 'warning'];
let flash: MockInstance<(kind: Kind, text: string) => void> | undefined;
let spies: Partial<Record<Kind, MockInstance<(text: string, options?: ToastOptions) => string>>> =
  {};

// Importing this file watches the toasts of every test in the file, with no Toaster mounted: a
// message that is still drawn in the page (an old banner) is then found by `screen`.
beforeEach(() => {
  spies = Object.fromEntries(
    KINDS.map((kind) => [kind, vi.spyOn(toast, kind).mockReturnValue('toast')]),
  );
  flash = vi.spyOn(toast, 'flash').mockReturnValue(undefined);
});
afterEach(() => {
  Object.values(spies).forEach((spy) => spy.mockRestore());
  spies = {};
  flash?.mockRestore();
  flash = undefined;
});

const matches = (text: string, want: string | RegExp) =>
  typeof want === 'string' ? text === want : want.test(text);

/** The texts shown so far as toasts of one kind, a title counting as a text of its own. */
export function toastsOf(kind: Kind): string[] {
  return (spies[kind]?.mock.calls ?? []).flatMap(([text, options]) =>
    options?.title === undefined ? [text] : [text, options.title],
  );
}

/** Waits for a toast of this kind with this text, and checks the page does not repeat it. */
export async function expectToast(want: string | RegExp, kind: Kind = 'success') {
  await waitFor(() => expect(toastsOf(kind).some((text) => matches(text, want))).toBe(true));
  expect(screen.queryByText(want)).toBeNull();
}

/** No toast of this kind was shown. */
export function expectNoToast(kind: Kind = 'success') {
  expect(toastsOf(kind)).toEqual([]);
}

/** The outcome was handed to the page the action navigates to (`toast.flash`), not shown here. */
export function expectFlash(want: string | RegExp, kind: Kind = 'success') {
  const calls = flash?.mock.calls ?? [];
  expect(calls.some(([k, text]) => k === kind && matches(text, want))).toBe(true);
  expect(screen.queryByText(want)).toBeNull();
}
