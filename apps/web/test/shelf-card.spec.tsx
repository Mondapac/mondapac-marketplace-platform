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

  it('moves the keyboard focus to "Decrease" when "+" reaches the cap and is disabled', () => {
    show({ ...CARD, price: { amount: 2290, currency: 'AUD' }, lowStock: 2 });
    fireEvent.click(screen.getByRole('button', { name: 'Add Lamb shoulder, 1 kg to cart' }));
    fireEvent.click(screen.getByRole('button', { name: 'Increase' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Decrease' }));
  });

  it('puts the focus on "Decrease" after the first add of a unit with only one left', () => {
    show({ ...CARD, price: { amount: 2290, currency: 'AUD' }, lowStock: 1 });
    fireEvent.click(screen.getByRole('button', { name: 'Add Lamb shoulder, 1 kg to cart' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Decrease' }));
  });

  it('shows the seller name, "Only N left" and one seal per certificate type', () => {
    const { container } = show({
      ...CARD,
      sellerName: 'Kedron Farms',
      lowStock: 3,
      certifications: [
        { type: 'halal', label: 'Halal certified', artwork: 'halal' },
        { type: 'vegan', label: 'Vegan', artwork: 'vegan' },
      ],
    });
    expect(container.querySelector('.by')?.textContent).toBe('Kedron Farms');
    expect(container.querySelector('.low')?.textContent).toBe('Only 3 left');
    expect(screen.getByRole('img', { name: 'Halal certified' })).toBeDefined();
    expect(screen.getByRole('img', { name: 'Vegan' })).toBeDefined();
    expect(container.querySelectorAll('.seals .seal')).toHaveLength(2);
  });

  it('draws the seal by the artwork key, and a key without artwork as a plain badge', () => {
    const { container } = show({
      ...CARD,
      certifications: [
        { type: 'kashrut', label: 'Kosher', artwork: 'kosher' },
        { type: 'fair-trade', label: 'Fair trade', artwork: 'text' },
      ],
    });
    expect(screen.getByRole('img', { name: 'Kosher' })).toBeDefined();
    expect(container.querySelector('.seals .badge')?.textContent).toBe('Fair trade');
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
