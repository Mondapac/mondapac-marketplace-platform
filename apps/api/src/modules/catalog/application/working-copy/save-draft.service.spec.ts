import { Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import type { ContentFilter } from '../../../../platform/content-filter/content-filter';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { CheckClaimText, ClaimTextVerdict } from '../claim-text/check-claim-text.service';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { WorkingCopyRepository } from '../ports/working-copy.repository';
import { SaveDraft } from './save-draft.service';
import type { SaveWorkingCopy } from './save-working-copy.service';

// The draft save with the claim-text control, in memory, on both Market fixtures (catalog design
// 6.1): the interactive save writes the texts that pass and leaves a refused one at its last saved
// value; the seller import's all-or-nothing save writes nothing when any changed text is refused,
// and spends the interactive saves limit only when the caller does not say otherwise.

const BAD = 'cures every illness';

describe.each(['AU', 'ZZ'])('SaveDraft in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const clock = new FixedClock(Temporal.Instant.from('2026-11-07T00:00:00Z'));
  const ids = new SequenceIdGenerator(clock);
  const productId = ids.next<'Product'>();
  const context: CallContext = testCallContext(
    market,
    testAuthenticatedActor(market, {
      population: 'seller',
      accountId: ids.next<'Account'>(),
      sessionId: ids.next<'Session'>(),
      sellerId: ids.next<'Seller'>(),
    }),
  );

  function rig(stored: Record<string, unknown> | null = null, blocked: readonly string[] = []) {
    const saves: { content: unknown; placeholders?: readonly string[] }[] = [];
    let reserved = 0;
    const check = {
      execute: (
        _c: CallContext,
        fields: readonly { field: string; ref: string | null; locale: string; text: string }[],
      ) =>
        Promise.resolve({
          ok: true as const,
          value: fields.map((field): ClaimTextVerdict =>
            field.text.includes(BAD)
              ? ({
                  ...field,
                  code: 'claim-text.found',
                  hits: [{ term: 'cures', start: 0, end: 5 }],
                } as unknown as ClaimTextVerdict)
              : ({ ...field, code: 'clean' } as unknown as ClaimTextVerdict),
          ),
        }),
    } as unknown as CheckClaimText;
    const save = {
      reserveSaves: () => {
        reserved += 1;
        return Promise.resolve(null);
      },
      execute: (
        _c: CallContext,
        input: {
          content: unknown;
          variantIds: readonly (Id<'Variant'> | null)[];
          placeholders?: readonly string[];
        },
      ) => {
        saves.push({
          content: input.content,
          ...(input.placeholders === undefined ? {} : { placeholders: input.placeholders }),
        });
        return Promise.resolve({
          ok: true as const,
          value: { variantIds: input.variantIds.map((v) => v ?? ids.next<'Variant'>()) },
        });
      },
    } as unknown as SaveWorkingCopy;
    const draft = new SaveDraft({
      unitOfWork: {
        run: async (_m: MarketContext, work: () => Promise<unknown>) => work(),
      } as unknown as UnitOfWork,
      check,
      save,
      workingCopies: {
        find: () => Promise.resolve(stored === null ? null : { content: stored }),
      } as unknown as WorkingCopyRepository,
      policy: {
        locales: () => ({ default: 'en', supported: ['en'] }),
      } as unknown as CatalogMarketPolicy,
      gtinRegistry: { duplicatesOf: () => Promise.resolve([]) },
      contentFilter: {
        isBlocked: (_m: MarketContext, text: string) =>
          blocked.some((term) => text.toLowerCase().includes(term)),
      } as unknown as ContentFilter,
    });
    return { draft, saves, reserved: () => reserved };
  }

  const content = (name: string, description = 'Fine lamb') => ({
    texts: { en: { name, description } },
  });
  const input = (extra: object = {}) => ({ productId, variantIds: [], ...extra });

  it('writes the texts that pass and keeps the last saved value of a refused one (interactive)', async () => {
    const r = rig({ texts: { en: { name: 'Old name', description: 'Old description' } } });
    const saved = await r.draft.execute(context, { ...input(), content: content('Lamb', BAD) });
    expect(saved).toMatchObject({ ok: true });
    expect(saved.ok && saved.value.refusedFields).toHaveLength(1);
    // The refused description is put back to what was saved; the new name is written.
    expect(r.saves[0]!.content).toEqual({
      texts: { en: { name: 'Lamb', description: 'Old description' } },
    });
  });

  it('writes nothing at all when any text is refused (all or nothing)', async () => {
    const r = rig({ texts: { en: { name: 'Old name', description: 'Old description' } } });
    const refused = await r.draft.executeAllOrNothing(context, {
      ...input(),
      content: content('Lamb', BAD),
    });
    expect(refused).toMatchObject({
      ok: false,
      error: { code: 'claim-text.refused' },
    });
    expect(!refused.ok && 'fields' in refused.error && refused.error.fields).toHaveLength(1);
    expect(r.saves).toHaveLength(0);
  });

  it.each([
    ['title', { texts: { en: { name: BAD } } }, 'product.name'],
    [
      'short description',
      { texts: { en: { name: 'Lamb', shortDescription: BAD } } },
      'product.short-description',
    ],
    ['description', { texts: { en: { name: 'Lamb', description: BAD } } }, 'product.description'],
    [
      'text attribute',
      { texts: { en: { name: 'Lamb' } }, attributeValues: { origin: BAD } },
      'product.attribute-text-value',
    ],
  ])('refuses the whole import save for a claim text in the %s', async (_label, draft, field) => {
    const r = rig();
    const refused = await r.draft.executeAllOrNothing(context, { ...input(), content: draft });
    expect(refused).toMatchObject({
      ok: false,
      error: { code: 'claim-text.refused', fields: [{ field }] },
    });
    expect(r.saves).toHaveLength(0);
  });

  it('refuses the whole save for a blocked term of the content filter too', async () => {
    const r = rig(null, ['forbidden']);
    const refused = await r.draft.executeAllOrNothing(context, {
      ...input(),
      content: content('Forbidden lamb'),
    });
    expect(refused).toMatchObject({ ok: false, error: { code: 'claim-text.refused' } });
    expect(r.saves).toHaveLength(0);
  });

  it('saves everything in one call when every text passes, carrying the placeholders', async () => {
    const r = rig();
    const saved = await r.draft.executeAllOrNothing(
      context,
      { ...input({ variantIds: [null] }), content: content('Lamb'), placeholders: ['new-1'] },
      { spendSavesLimit: false },
    );
    expect(saved.ok).toBe(true);
    // One save, never two: the placeholder ids are replaced inside that save.
    expect(r.saves).toHaveLength(1);
    expect(r.saves[0]!.placeholders).toEqual(['new-1']);
  });

  it('spends one interactive save by default and none for an import row', async () => {
    const interactive = rig();
    await interactive.draft.execute(context, { ...input(), content: content('Lamb') });
    expect(interactive.reserved()).toBe(1);

    const imported = rig();
    await imported.draft.execute(
      context,
      { ...input(), content: content('Lamb') },
      { spendSavesLimit: false },
    );
    await imported.draft.executeAllOrNothing(
      context,
      { ...input(), content: content('Lamb') },
      { spendSavesLimit: false },
    );
    expect(imported.reserved()).toBe(0);

    const allOrNothing = rig();
    await allOrNothing.draft.executeAllOrNothing(context, { ...input(), content: content('Lamb') });
    expect(allOrNothing.reserved()).toBe(1);
  });

  it('lets an unchanged text through without asking the check again', async () => {
    const r = rig({ texts: { en: { name: BAD, description: 'Fine lamb' } } });
    // The stored name was accepted when it was stored; only changed texts are checked.
    const saved = await r.draft.executeAllOrNothing(context, {
      ...input(),
      content: content(BAD, 'Fine lamb'),
    });
    expect(saved.ok).toBe(true);
  });
});
