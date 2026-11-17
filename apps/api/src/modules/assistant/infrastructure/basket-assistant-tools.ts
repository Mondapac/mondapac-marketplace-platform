import type { CallContext } from '@mondapac/shared-kernel';
import type { AssistantTools, ToolOutcome } from '../application/ports/assistant-tools';
import type { BasketSources } from '../application/ports/basket-sources';
import {
  attachSellUnits,
  offerIdsOf,
  type SellUnit,
  type SellUnitsByOffer,
} from '../domain/basket-units';
import { planBasket, type BasketItem, type BasketProposal } from '../domain/plan-basket';
import { normaliseText } from '../domain/pack-size';
import type { ToolRequest } from '../domain/tools';

/** Lines are searched this many at a time, and the whole plan is cut after this long. */
const SEARCH_CONCURRENCY = 4;
export const PLAN_TIMEOUT_MS = 12_000;
/** The sell units of a plan are read for at most this long after the plan itself is done. */
export const UNIT_TIMEOUT_MS = 4_000;
/** Plans running at once in this process; more are refused as failed (load shed, not queued). */
export const MAX_CONCURRENT_PLANS = 8;
/** Offers whose sell units one plan reads (a 40-line list has at most 40 picks and 80 options). */
const MAX_UNIT_READS = 60;

const failed: ToolOutcome = Object.freeze({
  forModel: JSON.stringify({ error: 'could not read the store; say so and do not guess' }),
  isError: true,
  cards: [],
  notices: ['tool-failed' as const],
});

/** What the model reads of a plan: how many lines, never a product, store, price or total. */
function summaryForModel(proposal: BasketProposal) {
  const found = proposal.stores.reduce((sum, store) => sum + store.lines.length, 0);
  return {
    shownToBuyer: 'the basket card; the buyer decides what goes into the cart',
    lines: proposal.itemCount,
    found,
    unsure: proposal.uncertain.length,
    notFound: proposal.notFound.length,
    notFoundLines: proposal.notFound.map(({ text }) => text.slice(0, 80)),
    cartMode: proposal.mode,
    ...(proposal.mode === 'single-store'
      ? { otherStoresShown: proposal.alternativeStores.length }
      : {}),
  };
}

/**
 * Adds `plan_basket` to another {@link AssistantTools}: every other tool is passed on unchanged.
 * The model sends only the parsed list; the server searches each line with the buyer's own
 * `CallContext`, plans the basket in the domain and returns a `basket-proposal` card. It reads,
 * never writes: the cart changes only when the buyer clicks in the storefront (R4).
 */
export class BasketAssistantTools implements AssistantTools {
  private running = 0;

  constructor(
    private readonly inner: AssistantTools,
    private readonly sources: BasketSources,
    private readonly timeoutMs = PLAN_TIMEOUT_MS,
    private readonly unitTimeoutMs = UNIT_TIMEOUT_MS,
  ) {}

  async run(context: CallContext, request: ToolRequest): Promise<ToolOutcome> {
    if (request.tool !== 'plan_basket') return this.inner.run(context, request);
    if (this.running >= MAX_CONCURRENT_PLANS) return failed;
    this.running += 1;
    const state = { stopped: false };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          // Stop searching at the next batch: a timed-out plan must not keep working.
          state.stopped = true;
          resolve(null);
        }, this.timeoutMs);
      });
      const planned = await Promise.race([this.plan(context, request.items, state), timeout]);
      clearTimeout(timer);
      if (planned === null) return failed;
      // The sell units have a budget of their own: a slow read leaves units out of the card,
      // it never turns a plan that is done into a failure.
      const units = await this.readUnitsWithin(context, offerIdsOf(planned));
      const proposal = attachSellUnits(planned, units);
      return {
        forModel: JSON.stringify(summaryForModel(proposal)),
        isError: false,
        cards: [{ kind: 'basket-proposal', proposal }],
        notices: [],
      };
    } catch {
      return failed;
    } finally {
      state.stopped = true;
      this.running -= 1;
      clearTimeout(timer);
    }
  }

  private async plan(
    context: CallContext,
    items: readonly BasketItem[],
    state: { stopped: boolean },
  ): Promise<BasketProposal | null> {
    // One search per distinct line text; a repeated line reuses it.
    const keyOf = (item: BasketItem) => normaliseText(item.text).trim();
    const distinct = new Map<string, string>();
    for (const item of items) if (!distinct.has(keyOf(item))) distinct.set(keyOf(item), item.text);
    const keys = [...distinct.keys()];
    const results = new Map<string, Awaited<ReturnType<BasketSources['candidates']>>>();
    for (let start = 0; start < keys.length; start += SEARCH_CONCURRENCY) {
      if (state.stopped) return null;
      const batch = keys.slice(start, start + SEARCH_CONCURRENCY);
      const answers = await Promise.all(
        batch.map((key) => this.sources.candidates(context, distinct.get(key)!)),
      );
      batch.forEach((key, index) => results.set(key, answers[index]!));
    }
    const candidates = [];
    for (const item of items) {
      const answer = results.get(keyOf(item))!;
      if (!answer.ok) return null;
      candidates.push(answer.value);
    }
    const mode = await this.sources.cartMode(context);
    return planBasket({ items, candidates, mode, goal: 'best-match' });
  }

  /**
   * The sell units of the proposed offers, a few at a time, within {@link UNIT_TIMEOUT_MS}; an offer
   * that cannot be read, or is not reached in time, has none (the card then carries null).
   */
  private async readUnitsWithin(
    context: CallContext,
    offerIds: readonly string[],
  ): Promise<SellUnitsByOffer> {
    const units = new Map<string, readonly SellUnit[]>();
    const state = { stopped: false };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        state.stopped = true;
        resolve();
      }, this.unitTimeoutMs);
    });
    const reading = (async () => {
      const wanted = offerIds.slice(0, MAX_UNIT_READS);
      for (let start = 0; start < wanted.length; start += SEARCH_CONCURRENCY) {
        if (state.stopped) break;
        const batch = wanted.slice(start, start + SEARCH_CONCURRENCY);
        const answers = await Promise.all(
          batch.map((id) => this.sources.units(context, id).catch(() => null)),
        );
        batch.forEach((id, index) => {
          const answer = answers[index];
          // A batch that ends after the deadline is dropped with the rest.
          if (!state.stopped && answer?.ok) units.set(id, answer.value);
        });
      }
    })();
    try {
      await Promise.race([reading, expired]);
    } finally {
      state.stopped = true;
      clearTimeout(timer);
    }
    return new Map(units);
  }
}
