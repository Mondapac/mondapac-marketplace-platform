import type { CallContext, Id, MarketContext, Temporal } from '@mondapac/shared-kernel';

/** The Market's model tiers (server configuration names the model of each). */
export type WriterModelTier = 'fast' | 'balanced';

export type WriterModelAnswer =
  | { readonly ok: true; readonly text: string }
  | {
      readonly ok: false;
      /** `incomplete`: the model stopped early or refused; its text is never used. */
      readonly failure: 'not-configured' | 'timeout' | 'unavailable' | 'incomplete';
    };

/**
 * The model behind the AI description writer (AIS-03), bound to `platform/ai`'s one entry point
 * by the only catalog file on its boundary allow-list. One call, text in and text out: no tools,
 * no images, no history (ADR-0019 R4, R9). Never called inside a unit of work (decision 6).
 */
export interface DescriptionWriterModel {
  /** Key, model and price are set for the tier in the Market and the kill switch is not. */
  configured(market: MarketContext, tier: WriterModelTier): boolean;
  /** What the admin AI settings card shows; never the key. */
  setup(market: MarketContext): {
    readonly killSwitch: boolean;
    readonly keyConfigured: boolean;
    readonly models: { readonly fast: string | null; readonly balanced: string | null };
  };
  write(
    market: MarketContext,
    tier: WriterModelTier,
    request: { readonly system: string; readonly input: string; readonly maxOutputTokens: number },
    timeoutMs: number,
  ): Promise<WriterModelAnswer>;
}

export const DESCRIPTION_WRITER_MODEL = Symbol('CATALOG_DESCRIPTION_WRITER_MODEL');

/**
 * The two switches of the writer (ADR-0019 decision 7, R8): the Market's (the settings store,
 * through the settings facade) and the seller's (SEL-25, through the sellers facade). Only an
 * explicit "on" is on: a refusal, an error or a throw is off.
 */
export interface DescriptionWriterSwitches {
  market(
    context: CallContext,
  ): Promise<{ readonly enabled: boolean; readonly tier: WriterModelTier }>;
  seller(context: CallContext, sellerId: Id<'Seller'>): Promise<boolean>;
}

export const DESCRIPTION_WRITER_SWITCHES = Symbol('CATALOG_DESCRIPTION_WRITER_SWITCHES');

/** The Market's calendar: the draft limits are counted per Market day (ADR-0005). */
export interface MarketDayCalendar {
  /** The Market's date at that instant, as `YYYY-MM-DD`. */
  dayOf(market: MarketContext, at: Temporal.Instant): string;
  /** The next midnight of the Market's zone after that instant. */
  nextMidnight(market: MarketContext, at: Temporal.Instant): Temporal.Instant;
  /** The Market's IANA zone, for the "resets at midnight" line. */
  zoneOf(market: MarketContext): string;
}

export const MARKET_DAY_CALENDAR = Symbol('CATALOG_MARKET_DAY_CALENDAR');
