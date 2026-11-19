import { parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { CatalogFacade } from '../../catalog';
import { FacadePublishedVariants } from './facade-published-variants';

// The product page and search show only the sell units the seller keeps on sale (variants V5).

const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId<T>(`00000000-0000-7000-8000-${String(n).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value;
};

describe('FacadePublishedVariants', () => {
  const OFFER = id<'Offer'>(1);
  const on = id<'Variant'>(10);
  const off = id<'Variant'>(11);
  const proposed = id<'Variant'>(12);
  const context = {} as CallContext;

  const catalog = (
    units: readonly { variantId: Id<'Variant'>; state: string; selling: boolean }[],
  ) =>
    ({
      offerSellUnits: () =>
        Promise.resolve({
          ok: true,
          value: new Map([[OFFER, { sellUnits: units.map((u) => ({ ...u, variantSku: null })) }]]),
        }),
    }) as unknown as CatalogFacade;

  it('keeps published, selling units only', async () => {
    const variants = new FacadePublishedVariants(
      catalog([
        { variantId: on, state: 'published', selling: true },
        { variantId: off, state: 'published', selling: false },
        { variantId: proposed, state: 'proposed', selling: true },
      ]),
    );
    const answer = await variants.published(context, [OFFER]);
    expect([...answer!.get(OFFER)!]).toEqual([on]);
  });

  it('puts a unit back on the page when the seller turns it on again', async () => {
    const variants = new FacadePublishedVariants(
      catalog([{ variantId: off, state: 'published', selling: true }]),
    );
    expect([...(await variants.published(context, [OFFER]))!.get(OFFER)!]).toEqual([off]);
  });

  it('answers null when the catalog refuses or fails', async () => {
    const refusing = {
      offerSellUnits: () => Promise.resolve({ ok: false, error: { code: 'access.denied' } }),
    } as unknown as CatalogFacade;
    expect(await new FacadePublishedVariants(refusing).published(context, [OFFER])).toBeNull();
    const failing = {
      offerSellUnits: () => Promise.reject(new Error('down')),
    } as unknown as CatalogFacade;
    expect(await new FacadePublishedVariants(failing).published(context, [OFFER])).toBeNull();
  });
});
