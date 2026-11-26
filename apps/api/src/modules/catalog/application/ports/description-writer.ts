import type { CallContext, Id, MarketContext, Temporal } from '@mondapac/shared-kernel';

export type WriterModelAnswer =
  | { readonly ok: true; readonly text: string }
  | {
      readonly ok: false;
      /** `incomplete`: the model stopped early or refused; its text is never used. */
      readonly failure: 'not-configured' | 'timeout' | 'unavailable' | 'incomplete';
    };

/** Whom the writer drafts for: a seller for its own product, or an admin for platform content. */
export type WriterAudience =
  { readonly kind: 'seller'; readonly sellerId: Id<'Seller'> } | { readonly kind: 'admin' };

/**
 * The model behind the AI description writer (AIS-03), bound to `platform/ai`'s gateway by the
 * only catalog file on its boundary allow-list, as one capability per audience. One call, text in
 * and text out: no tools, no images, no history (ADR-0019 R4, R9). Never called inside a unit of
 * work (decision 6).
 */
export interface DescriptionWriterModel {
  /**
   * The gateway would run the writer for this caller: the caller fits the audience and is not
   * acting as a seller, the kill switch is not set, the seller's own switch (SEL-25) is on for a
   * seller, and the Market's list for the write task type has a usable route (no list: off).
   */
  available(context: CallContext, audience: WriterAudience): Promise<boolean>;
  /** What the admin AI settings card shows; never the key. */
  setup(market: MarketContext): { readonly killSwitch: boolean; readonly keyConfigured: boolean };
  write(
    context: CallContext,
    audience: WriterAudience,
    request: { readonly system: string; readonly input: string; readonly maxOutputTokens: number },
    timeoutMs: number,
  ): Promise<WriterModelAnswer>;
}

export const DESCRIPTION_WRITER_MODEL = Symbol('CATALOG_DESCRIPTION_WRITER_MODEL');

/**
 * The Market's switch of the writer (ADR-0019 decision 7, R8), from the settings store through the
 * settings facade (platform-ai.md section 5). The seller's switch is evaluated by the gateway, and
 * the models are the Market's list for the write task type. Only an explicit "on" is on: a
 * refusal, an error or a throw is off.
 */
export interface DescriptionWriterSwitches {
  market(context: CallContext): Promise<{ readonly enabled: boolean }>;
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
