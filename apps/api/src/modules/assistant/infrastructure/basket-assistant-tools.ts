import type { CallContext } from '@mondapac/shared-kernel';
import type { AssistantTools, ToolOutcome } from '../application/ports/assistant-tools';
import type { BasketSources } from '../application/ports/basket-sources';
import { planBasket, type BasketItem, type BasketProposal } from '../domain/plan-basket';
import { normaliseText } from '../domain/pack-size';
import type { ToolRequest } from '../domain/tools';

/** Lines are searched this many at a time, and the whole plan is cut after this long. */
const SEARCH_CONCURRENCY = 4;
export const PLAN_TIMEOUT_MS = 12_000;

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
  constructor(
    private readonly inner: AssistantTools,
    private readonly sources: BasketSources,
    private readonly timeoutMs = PLAN_TIMEOUT_MS,
  ) {}

  async run(context: CallContext, request: ToolRequest): Promise<ToolOutcome> {
    if (request.tool !== 'plan_basket') return this.inner.run(context, request);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<ToolOutcome>((resolve) => {
        timer = setTimeout(() => resolve(failed), this.timeoutMs);
      });
      return await Promise.race([this.plan(context, request.items), timeout]);
    } catch {
      return failed;
    } finally {
      clearTimeout(timer);
    }
  }

  private async plan(context: CallContext, items: readonly BasketItem[]): Promise<ToolOutcome> {
    // One search per distinct line text; a repeated line reuses it.
    const keyOf = (item: BasketItem) => normaliseText(item.text).trim();
    const distinct = new Map<string, string>();
    for (const item of items) if (!distinct.has(keyOf(item))) distinct.set(keyOf(item), item.text);
    const keys = [...distinct.keys()];
    const results = new Map<string, Awaited<ReturnType<BasketSources['candidates']>>>();
    for (let start = 0; start < keys.length; start += SEARCH_CONCURRENCY) {
      const batch = keys.slice(start, start + SEARCH_CONCURRENCY);
      const answers = await Promise.all(
        batch.map((key) => this.sources.candidates(context, distinct.get(key)!)),
      );
      batch.forEach((key, index) => results.set(key, answers[index]!));
    }
    const candidates = [];
    for (const item of items) {
      const answer = results.get(keyOf(item))!;
      if (!answer.ok) return failed;
      candidates.push(answer.value);
    }
    const mode = await this.sources.cartMode(context);
    const proposal = planBasket({ items, candidates, mode, goal: 'best-match' });
    return {
      forModel: JSON.stringify(summaryForModel(proposal)),
      isError: false,
      cards: [{ kind: 'basket-proposal', proposal }],
      notices: [],
    };
  }
}
