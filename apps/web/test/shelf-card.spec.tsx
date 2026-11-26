// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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

function show(card: ShelfCard, live = false) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <StoreProvider live={live}>
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

  it('marks a special without a "was" price (the rule withheld it): pill and colour, no struck price', () => {
    const { container } = show({
      ...CARD,
      price: { amount: 2290, currency: 'AUD' },
      onSpecial: true,
    });
    expect(container.querySelector('.badge')?.textContent).toBe('Special price');
    expect(container.querySelector('.pr b.sp')?.textContent).toBe('A$22.90');
    expect(container.querySelector('.pr s')).toBeNull();
  });

  it('shows no pill and no special colour on a price that is not a special', () => {
    const { container } = show({ ...CARD, price: { amount: 2290, currency: 'AUD' } });
    expect(container.querySelector('.badge')).toBeNull();
    expect(container.querySelector('.pr b.sp')).toBeNull();
  });

  it('keeps the keyboard focus on the stepper after the first add, and on add after the last remove', () => {
    show({ ...CARD, price: { amount: 2290, currency: 'AUD' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add Lamb shoulder, 1 kg to cart' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Increase' }));
    fireEvent.click(screen.getByRole('button', { name: 'Decrease' }));
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Add Lamb shoulder, 1 kg to cart' }),
    );
  });

  describe('live', () => {
    const OFFER = '01990000-0000-7000-8000-000000000001';
    const VARIANT = '01990000-0000-7000-8000-000000000002';
    const priced = { ...CARD, price: { amount: 2290, currency: 'AUD' } };

    it('shows the add button on a card that names one sell unit', () => {
      show({ ...priced, unit: { offerId: OFFER, variantId: VARIANT } }, true);
      expect(screen.getByRole('button', { name: 'Add Lamb shoulder, 1 kg to cart' })).toBeDefined();
    });

    it('links to the product page when the card names no single unit', () => {
      show(priced, true);
      const link = screen.getByRole('link', { name: 'Choose options for Lamb shoulder, 1 kg' });
      expect(link).toHaveProperty('href', 'http://localhost:3000/p/p1');
    });

    it('links to the product page on a "From" price', () => {
      show({ ...priced, priceFrom: true }, true);
      expect(
        screen.getByRole('link', { name: 'Choose options for Lamb shoulder, 1 kg' }),
      ).toBeDefined();
    });

    it('shows no button on a card that is out of stock', () => {
      show({ ...priced, lowStock: 0, unit: { offerId: OFFER, variantId: VARIANT } }, true);
      expect(screen.queryByRole('button')).toBeNull();
    });
  });
});
