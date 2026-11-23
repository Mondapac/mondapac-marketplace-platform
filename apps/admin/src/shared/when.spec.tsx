// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it } from 'vitest';
import { When } from './when.tsx';

afterEach(cleanup);

const show = (locale: string, zone?: string) =>
  render(
    <NextIntlClientProvider locale={locale} messages={{}}>
      <When
        iso="2026-10-09T23:30:00.000Z"
        missing="none"
        {...(zone === undefined ? {} : { zone })}
      />
    </NextIntlClientProvider>,
  );

describe('When', () => {
  it('writes the date over the time in the Market locale (AU)', () => {
    show('en-AU');
    expect(screen.getByText('9 Oct 2026')).toBeTruthy();
    expect(screen.getByText(/11:30\s?pm UTC/i)).toBeTruthy();
  });

  it('writes the date over the time in another Market locale', () => {
    show('de-DE');
    expect(screen.getByText('09.10.2026')).toBeTruthy();
    expect(screen.getByText('23:30 UTC')).toBeTruthy();
  });

  it('reads the instant on the given zone clock, without naming the zone', () => {
    show('en-AU', 'Australia/Brisbane');
    expect(screen.getByText('10 Oct 2026')).toBeTruthy();
    expect(screen.getByText(/9:30\s?am/i)).toBeTruthy();
    expect(screen.queryByText(/UTC/)).toBeNull();
  });
});
