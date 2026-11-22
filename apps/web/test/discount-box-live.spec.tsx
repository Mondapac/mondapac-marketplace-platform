// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/en.json';
import { DiscountBox } from '../src/cart/cart-parts.tsx';
import { StoreProvider } from '../src/shell/store-context.tsx';

// Discount codes have no backend yet: the box is gone with the API on and stays in the preview.

vi.mock('next/navigation', () => ({
  usePathname: () => '/cart',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: () => undefined, replace: () => undefined }),
}));

afterEach(cleanup);

function renderBox(live: boolean) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <StoreProvider live={live}>
        <DiscountBox startOpen />
      </StoreProvider>
    </NextIntlClientProvider>,
  );
}

describe('the discount code box', () => {
  it('is hidden with the API on', () => {
    const { container } = renderBox(true);
    expect(container.innerHTML).toBe('');
    expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull();
  });

  it('is shown in the preview', () => {
    renderBox(false);
    expect(screen.getByRole('button', { name: 'Apply' })).toBeTruthy();
  });
});
