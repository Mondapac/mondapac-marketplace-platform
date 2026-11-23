// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

let path = '/accounting/payout-account';
vi.mock('next/navigation', () => ({ usePathname: () => path }));

import { SellerHelpButton, SellerHelpPanel, SellerHelpProvider } from './seller-help.tsx';

function mount(timeZone: string) {
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages} timeZone={timeZone}>
      <SellerHelpProvider>
        <SellerHelpButton />
        <SellerHelpPanel />
      </SellerHelpProvider>
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  path = '/accounting/payout-account';
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Seller Help panel', () => {
  it('tells the seller MondaPac never sees their bank details', () => {
    mount('Australia/Brisbane');
    fireEvent.click(screen.getByRole('button', { name: 'Help' }));
    expect(screen.getByRole('dialog').textContent).toContain(
      'MondaPac never sees your bank details',
    );
  });

  it("names the seller's own zone on a page that shows times", () => {
    path = '/orders';
    mount('Pacific/Auckland');
    fireEvent.click(screen.getByRole('button', { name: 'Help' }));
    const panel = screen.getByRole('dialog');
    expect(panel.textContent).toContain('Pacific/Auckland');
    expect(panel.textContent).not.toContain('Brisbane');
  });
});
