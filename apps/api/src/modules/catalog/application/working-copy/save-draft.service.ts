import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import {
  changedTexts,
  draftTextsOf,
  restoreRefused,
  withoutVariantLabels,
} from '../../domain/draft-texts';
import { isStorableContent } from '../../domain/working-copy';
import { normalizeGtin } from '../../domain/variant-gtin';
import type { ClaimCheckedFieldId } from '../../domain/claim-checked-fields';
import type { ContentFilter } from '../../../../platform/content-filter/content-filter';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { CheckClaimText, ClaimTextVerdict } from '../claim-text/check-claim-text.service';
import type { ClaimTextMatch } from '../ports/claim-text-matcher';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { VariantGtinRegistry } from '../ports/variant-gtin.registry';
import type { WorkingCopyRepository } from '../ports/working-copy.repository';
import type {
  SaveWorkingCopy,
  SaveWorkingCopyFailure,
  SaveWorkingCopyOutput,
} from './save-working-copy.service';

export interface SaveDraftInput {
  readonly productId: Id<'Product'>;
  /** Opaque JSON object from the request; this service checks its shape and its texts. */
  readonly content: unknown;
  readonly variantIds: readonly (Id<'Variant'> | null)[];
  /** The seller import's placeholder ids for new variants; see {@link SaveWorkingCopyInput}. */
  readonly placeholders?: readonly string[];
}

/** A checked text that was not written, and why (catalog design 6.1, ux.md 7.2). */
export type RefusedField = {
  readonly field: ClaimCheckedFieldId;
  readonly ref: string | null;
  readonly locale: string;
} & (
  | { readonly code: 'claim-text.found'; readonly hits: readonly ClaimTextMatch[] }
  | { readonly code: 'claim-text.check-unavailable' }
  /** The Market's content filter: the text holds a blocked term (the text is never echoed). */
  | { readonly code: 'text.blocked-term' }
  | {
      readonly code: 'text.invisible-character';
      readonly offset: number;
      readonly character: 'ZWNJ' | 'ZWJ' | 'other';
    }
);

/**
 * A GTIN of the saved draft that another published product already carries (variants V4). The
 * save is allowed. For a PLATFORM product the notice carries its public code so the seller can
 * sell on it instead; for any other product it is neutral: no name, id, code or seller.
 */
export interface VariantNotice {
  readonly variantId: string;
  readonly code: 'gtin.duplicate';
  /** The public code of the PLATFORM product to sell on, else null. */
  readonly sellOnProductCode: string | null;
}

export interface SaveDraftOutput extends SaveWorkingCopyOutput {
  /** Texts that kept their last saved value; everything else of the request was saved. */
  readonly refusedFields: readonly RefusedField[];
  /** Advice about the saved variants; never a refusal. */
  readonly variantNotices: readonly VariantNotice[];
}

export type SaveDraftFailure =
  SaveWorkingCopyFailure | { readonly code: 'working-copy.invalid-content' };

export interface SaveDraftOptions {
  /**
   * False only for the rows of an admin import (catalog design 14a): the interactive limit of draft
   * saves per account is not spent, and the import's own limits bound the work instead. Every
   * interactive use case leaves it unset.
   */
  readonly spendSavesLimit?: boolean;
  /**
   * The seller import (design 14c): when any changed text is refused, nothing is written and the
   * answer is `claim-text.refused` with the list, so a row group that fails leaves the draft as
   * it was. Interactive callers leave it unset and keep the per-field behaviour.
   */
  readonly refuseAll?: boolean;
}

/** The whole save refused because a text was (only under {@link SaveDraftOptions.refuseAll}). */
export interface SaveDraftRefused {
  readonly code: 'claim-text.refused';
  readonly fields: readonly RefusedField[];
}

export interface SaveDraftDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly check: CheckClaimText;
  readonly save: SaveWorkingCopy;
  readonly workingCopies: WorkingCopyRepository;
  readonly policy: CatalogMarketPolicy;
  readonly gtinRegistry: VariantGtinRegistry;
  /** The Market's content filter; a changed text that holds a blocked term is refused. */
  readonly contentFilter: ContentFilter;
}

/**
 * The draft save with the claim-text control (catalog design 6.1; slice 6): an internal service
 * that `platform-product.save-draft` (and, in slice 7, `own-product.save-draft`) declare their
 * access rule around.
 *
 * 1. The draft must fit the closed shape of {@link draftTextsOf}: a key, locale or nesting it
 *    does not name refuses the whole save (`working-copy.invalid-content`), so no string can sit
 *    where the check does not look.
 * 2. Only the texts that differ from the stored draft are checked. A text that matches, holds a
 *    hidden character or cannot be checked is **not written**: it keeps its last saved value (or
 *    has none), and the answer lists it in `refusedFields`. Everything else is saved in the same
 *    unit by {@link SaveWorkingCopy}, which owns the actor, the ownership check, the saves limit
 *    and the variant registry.
 *
 * The stored draft is read before the save unit and used only to decide what changed and what to
 * restore; it is never returned. Another seller's or Market's product id is answered by the save
 * as `product.not-found`, whatever this service computed. A concurrent save of the same draft is
 * last-write-wins, as in {@link SaveWorkingCopy}: every string written was checked now or equals
 * a value that was checked when it was stored.
 */
export class SaveDraft {
  constructor(private readonly deps: SaveDraftDependencies) {}

  async execute(
    context: CallContext,
    input: SaveDraftInput,
    options?: SaveDraftOptions,
  ): Promise<Result<SaveDraftOutput, SaveDraftFailure>> {
    return (await this.run(context, input, { ...options, refuseAll: false })) as Result<
      SaveDraftOutput,
      SaveDraftFailure
    >;
  }

  /** All or nothing: as {@link execute}, but a refused text refuses the whole save. */
  executeAllOrNothing(
    context: CallContext,
    input: SaveDraftInput,
    options?: Omit<SaveDraftOptions, 'refuseAll'>,
  ): Promise<Result<SaveDraftOutput, SaveDraftFailure | SaveDraftRefused>> {
    return this.run(context, input, { ...options, refuseAll: true });
  }

  private async run(
    context: CallContext,
    input: SaveDraftInput,
    options: SaveDraftOptions,
  ): Promise<Result<SaveDraftOutput, SaveDraftFailure | SaveDraftRefused>> {
    if (!isStorableContent(input.content)) return err({ code: 'working-copy.invalid-content' });
    // A variant label is built by the server (V2): one a client still sends is dropped, not stored.
    const content = withoutVariantLabels(input.content);
    const { market } = context;

    let locales: { readonly default: string; readonly supported: readonly string[] };
    try {
      locales = this.deps.policy.locales(market);
    } catch {
      return err({ code: 'access.unavailable' });
    }
    const texts = draftTextsOf(content, locales.supported, locales.default);
    if (!texts.ok) return err(texts.error);

    // The saves limit is spent before the read and the check, so a throttled account costs the
    // matcher nothing (Hassan M2).
    // An import row (design 14a) is bounded by the import's own limits and spends no interactive save.
    if (options?.spendSavesLimit !== false) {
      const throttled = await this.deps.save.reserveSaves(context);
      if (throttled !== null) return err(throttled);
    }

    // A read-only unit opens no transaction (ADR-0025); the save below opens its own.
    const read = await this.deps.unitOfWork.run(
      market,
      async () => ok(await this.deps.workingCopies.find(market, input.productId)),
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    const stored = read.value;
    const changed = changedTexts(content, texts.value, stored?.content ?? null);

    let refused: readonly RefusedField[] = [];
    let amended: Record<string, unknown> = content;
    if (changed.length > 0) {
      const checked = await this.deps.check.execute(
        context,
        changed.map(({ field, ref, locale, text }) => ({ field, ref, locale, text })),
      );
      if (!checked.ok) {
        // A caller who may not check may not save; a request the check refuses is not a draft.
        return err(
          checked.error.code === 'validation.failed'
            ? { code: 'working-copy.invalid-content' }
            : checked.error.code === 'request.throttled'
              ? { code: 'access.unavailable' }
              : checked.error,
        );
      }
      const refusedPaths: (typeof changed)[number]['path'][] = [];
      const list: RefusedField[] = [];
      checked.value.forEach((verdict, index) => {
        const refusal =
          refusalOf(verdict) ??
          (this.deps.contentFilter.isBlocked(market, changed[index]!.text)
            ? ({
                field: verdict.field,
                ref: verdict.ref,
                locale: verdict.locale,
                code: 'text.blocked-term',
              } as const)
            : null);
        if (refusal === null) return;
        list.push(refusal);
        refusedPaths.push(changed[index]!.path);
      });
      refused = list;
      if (options.refuseAll === true && list.length > 0) {
        // Only an unavailable matcher refused: nothing is wrong with the text, so the caller waits.
        if (list.every((field) => field.code === 'claim-text.check-unavailable')) {
          return err({ code: 'access.unavailable' });
        }
        return err({ code: 'claim-text.refused', fields: list });
      }
      const restored = restoreRefused(content, stored?.content ?? null, refusedPaths);
      if (restored === null) return err({ code: 'working-copy.invalid-content' });
      amended = restored;
    }

    const saved = await this.deps.save.execute(
      context,
      {
        productId: input.productId,
        content: amended,
        variantIds: input.variantIds,
        ...(input.placeholders === undefined ? {} : { placeholders: input.placeholders }),
      },
      { savesReserved: true },
    );
    if (!saved.ok) return saved;
    const variantNotices = await this.gtinNotices(context, input.productId, amended);
    return ok({ ...saved.value, refusedFields: refused, variantNotices });
  }

  /**
   * The duplicate-GTIN advice for the saved draft (V4). It is advice after a successful save, so a
   * failed lookup answers no notice rather than failing the save. A GTIN the freeze would refuse
   * is skipped here; the submit reports it.
   */
  private async gtinNotices(
    context: CallContext,
    productId: Id<'Product'>,
    content: Readonly<Record<string, unknown>>,
  ): Promise<readonly VariantNotice[]> {
    const variants = content['variants'];
    if (!Array.isArray(variants)) return [];
    const typed: { variantId: string; gtin: string }[] = [];
    for (const variant of variants as unknown[]) {
      if (typeof variant !== 'object' || variant === null) continue;
      const { variantId, gtin } = variant as Record<string, unknown>;
      if (typeof variantId !== 'string' || typeof gtin !== 'string') continue;
      const normalized = normalizeGtin(gtin);
      if (normalized.ok) typed.push({ variantId, gtin: normalized.value });
    }
    if (typed.length === 0) return [];
    try {
      const read = await this.deps.unitOfWork.run(
        context.market,
        async () =>
          ok(
            await this.deps.gtinRegistry.duplicatesOf(context.market, productId, [
              ...new Set(typed.map((entry) => entry.gtin)),
            ]),
          ),
        { readOnly: true },
      );
      if (!read.ok) return [];
      const byGtin = new Map(read.value.map((duplicate) => [duplicate.gtin, duplicate] as const));
      return typed.flatMap(({ variantId, gtin }) => {
        const duplicate = byGtin.get(gtin);
        return duplicate === undefined
          ? []
          : [
              {
                variantId,
                code: 'gtin.duplicate' as const,
                sellOnProductCode: duplicate.platformProductCode,
              },
            ];
      });
    } catch {
      return [];
    }
  }
}

export function refusalOf(verdict: ClaimTextVerdict): RefusedField | null {
  const place = { field: verdict.field, ref: verdict.ref, locale: verdict.locale };
  switch (verdict.code) {
    case 'clean':
      return null;
    case 'claim-text.found':
      return { ...place, code: verdict.code, hits: verdict.hits };
    case 'claim-text.check-unavailable':
      return { ...place, code: verdict.code };
    case 'text.invisible-character':
      return { ...place, code: verdict.code, offset: verdict.offset, character: verdict.character };
  }
}
