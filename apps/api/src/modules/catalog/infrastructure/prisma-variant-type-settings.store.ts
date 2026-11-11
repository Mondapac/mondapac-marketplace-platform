import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext, MarketId } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import { StaleAggregateError } from '../../../platform/unit-of-work/errors';
import type { VariantTypeSettingsStore } from '../application/ports/variant-type-settings.store';
import {
  VariantTypeSettings,
  type VariantDisplayStyle,
  type VariantOptionOrder,
  type VariantTypeSettingsState,
} from '../domain/variant-type-settings';
import { asTexts } from './locale-pick';

const toDate = (instant: { readonly epochMilliseconds: number }): Date =>
  new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

const stringMap = (value: unknown): Record<string, string> =>
  Object.fromEntries(
    Object.entries(asTexts(value) ?? {}).filter(([, text]) => typeof text === 'string'),
  );

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002'
  );
}

/**
 * {@link VariantTypeSettingsStore} on `catalog.variant_type_settings` and their insert-only
 * revisions (variants V6), the pattern of a category's attribute links. Every statement goes
 * through `PrismaService.tx(market)` with `marketId` at the top level of `where`; the root row is
 * written only in its granted columns.
 */
export class PrismaVariantTypeSettingsStore implements VariantTypeSettingsStore {
  constructor(private readonly prisma: PrismaService) {}

  async find(
    market: MarketContext,
    definitionId: Id<'AttributeDefinition'>,
  ): Promise<VariantTypeSettings | null> {
    const row = await this.prisma.tx(market).catalogVariantTypeSetting.findFirst({
      where: { marketId: market.marketId, definitionId },
      include: { currentRevision: true },
    });
    const revision = row?.currentRevision;
    if (row === null || revision === null || revision === undefined) return null;
    const state: VariantTypeSettingsState = {
      marketId: row.marketId as MarketId,
      definitionId: row.definitionId as Id<'AttributeDefinition'>,
      revisionId: revision.id as Id<'VariantTypeSettingRevision'>,
      revisionNo: revision.revisionNo,
      version: row.version,
      displayStyle: revision.displayStyle as VariantDisplayStyle,
      optionOrder: revision.optionOrder as VariantOptionOrder,
      swatches: stringMap(revision.swatches),
      sellerHelp: stringMap(revision.sellerHelp),
      createdAt: toInstant(row.createdAt),
      revisedAt: toInstant(revision.createdAt),
    };
    return VariantTypeSettings.rehydrate(state);
  }

  async add(
    market: MarketContext,
    settings: VariantTypeSettings,
    authorAccountId: Id<'Account'>,
  ): Promise<void> {
    const state = settings.state;
    this.#sameMarket(market, state);
    if (state.version !== 1 || state.revisionNo !== 1) {
      throw new Error('add: only first settings are added');
    }
    const tx = this.prisma.tx(market);
    try {
      await tx.catalogVariantTypeSetting.create({
        data: {
          marketId: market.marketId,
          tenantId: market.tenantId,
          definitionId: state.definitionId,
          currentRevisionId: null,
          version: state.version,
          createdAt: toDate(state.createdAt),
        },
        select: { definitionId: true },
      });
    } catch (error) {
      // A racing first save for the same variant type fails on the primary key.
      if (isUniqueViolation(error)) {
        throw new StaleAggregateError('variant-type-settings', state.definitionId);
      }
      throw error;
    }
    await this.#insertRevision(market, state, authorAccountId);
    const { count } = await tx.catalogVariantTypeSetting.updateMany({
      where: {
        marketId: market.marketId,
        definitionId: state.definitionId,
        version: state.version,
      },
      data: { currentRevisionId: state.revisionId },
    });
    if (count !== 1) throw new StaleAggregateError('variant-type-settings', state.definitionId);
  }

  async saveRevision(
    market: MarketContext,
    settings: VariantTypeSettings,
    authorAccountId: Id<'Account'>,
  ): Promise<void> {
    const state = settings.state;
    this.#sameMarket(market, state);
    await this.#insertRevision(market, state, authorAccountId);
    const { count } = await this.prisma.tx(market).catalogVariantTypeSetting.updateMany({
      where: {
        marketId: market.marketId,
        definitionId: state.definitionId,
        version: state.version - 1,
      },
      data: { currentRevisionId: state.revisionId, version: state.version },
    });
    if (count !== 1) throw new StaleAggregateError('variant-type-settings', state.definitionId);
  }

  async #insertRevision(
    market: MarketContext,
    state: VariantTypeSettingsState,
    authorAccountId: Id<'Account'>,
  ): Promise<void> {
    try {
      await this.prisma.tx(market).catalogVariantTypeSettingRevision.create({
        data: {
          id: state.revisionId,
          marketId: market.marketId,
          tenantId: market.tenantId,
          definitionId: state.definitionId,
          revisionNo: state.revisionNo,
          displayStyle: state.displayStyle,
          optionOrder: state.optionOrder,
          swatches: { ...state.swatches },
          sellerHelp: { ...state.sellerHelp },
          authorAccountId,
          createdAt: toDate(state.revisedAt),
        },
        select: { id: true },
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new StaleAggregateError('variant-type-settings', state.definitionId);
      }
      throw error;
    }
  }

  #sameMarket(market: MarketContext, state: VariantTypeSettingsState): void {
    if (state.marketId !== market.marketId) {
      throw new Error('PrismaVariantTypeSettingsStore: the settings are of another Market');
    }
  }
}
