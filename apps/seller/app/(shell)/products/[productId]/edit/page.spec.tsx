import { describe, expect, it, vi } from 'vitest';

const permanentRedirect = vi.fn((to: string) => {
  throw new Error(`redirect:${to}`);
});
vi.mock('next/navigation', () => ({
  permanentRedirect: (to: string) => permanentRedirect(to),
}));

import EditProductPage from './page.tsx';

describe('the old edit page (server)', () => {
  it('permanently redirects to the product page', async () => {
    await expect(
      EditProductPage({ params: Promise.resolve({ productId: 'p-1' }) }),
    ).rejects.toThrow('redirect:/products/p-1');
    expect(permanentRedirect).toHaveBeenCalledWith('/products/p-1');
  });
});
