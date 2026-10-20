// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it } from 'vitest';
import messages from '../messages/en.json';
import { ProductCard } from '../src/home/product-card.tsx';
import { StoreProvider } from '../src/shell/store-context.tsx';
import type { ShelfCard } from '../src/storefront/types.ts';

afterEach(cleanup);

const CARD: ShelfCard = {
  id: 'p1',
  name: 'Lamb shoulder, 1 kg',
  sellerName: '',
  category: 'meat',
  certifications: [],
};

function show(card: ShelfCard) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <StoreProvider>
        <ProductCard product={card} />
      </StoreProvider>
    </NextIntlClientProvider>,
  );
}

describe('shelf card from the API', () => {
  it('shows the name only when the read carries no price and no seller name', () => {
    const { container } = show(CARD);
    expect(screen.getByRole('link', { name: 'Lamb shoulder, 1 kg' })).toHaveProperty(
      'href',
      'http://localhost:3000/p/p1',
    );
    expect(screen.queryByRole('button')).toBeNull();
    expect(container.querySelector('.pr, .gst, .by')).toBeNull();
  });

  it('shows the price, the regular price and the add button when the read carries them', () => {
    const { container } = show({
      ...CARD,
      price: { amount: 2290, currency: 'AUD' },
      wasPrice: { amount: 2490, currency: 'AUD' },
    });
    expect(container.querySelector('.pr b')?.textContent).toBe('A$22.90');
    expect(container.querySelector('.pr s')?.textContent).toContain('A$24.90');
    expect(screen.getByRole('button', { name: 'Add Lamb shoulder, 1 kg to cart' })).toBeDefined();
    expect(container.querySelector('.by')).toBeNull();
  });
});
