import type { CallContext } from '@mondapac/shared-kernel';
import type { CatalogAssistantFacade } from '../../catalog';
import type { SupportContactFacade } from '../../notifications';
import type { AssistantProduct, AssistantSpecial, SearchAssistantFacade } from '../../search';
import type { AssistantTools, ToolOutcome } from '../application/ports/assistant-tools';
import type { AssistantCard } from '../domain/cards';
import { TOOL_ITEM_LIMIT, type ToolRequest } from '../domain/tools';

const shown = (cards: readonly AssistantCard[], forModel: unknown): ToolOutcome => ({
  forModel: JSON.stringify(forModel),
  isError: false,
  cards,
  notices: [],
});

const failed: ToolOutcome = Object.freeze({
  forModel: JSON.stringify({ error: 'could not read the store; say so and do not guess' }),
  isError: true,
  cards: [],
  notices: ['tool-failed' as const],
});

const productCard = (item: AssistantProduct | AssistantSpecial): AssistantCard => ({
  kind: 'product',
  offerId: item.offerId,
  productId: item.productId,
  sellerId: item.sellerId,
  name: item.name,
  shortText: item.shortText,
  price: 'price' in item ? item.price : null,
  regularPrice: 'regularPrice' in item ? item.regularPrice : null,
  taxInclusive: 'taxInclusive' in item ? item.taxInclusive : null,
});

/** What the model reads of a product: its name and short text only, never a price or stock. */
const forModelOf = (items: readonly AssistantProduct[]) => ({
  shownToBuyer: items.length,
  products: items.map((item) => ({ name: item.name, shortText: item.shortText })),
});

/**
 * {@link AssistantTools} on the READ facades of `search`, `catalog` and `notifications`, each
 * called with the buyer's `CallContext` unchanged (ADR-0019 R3). The buyer gets the cards; the
 * model gets names and short texts only, so it has no price or stock figure to repeat. A failed
 * read is reported as such: nothing is guessed. The two actions not built yet answer "not ready".
 */
export class FacadeAssistantTools implements AssistantTools {
  constructor(
    private readonly search: SearchAssistantFacade,
    private readonly catalog: CatalogAssistantFacade,
    private readonly support: SupportContactFacade,
  ) {}

  async run(context: CallContext, request: ToolRequest): Promise<ToolOutcome> {
    try {
      return await this.dispatch(context, request);
    } catch {
      return failed;
    }
  }

  private async dispatch(context: CallContext, request: ToolRequest): Promise<ToolOutcome> {
    switch (request.tool) {
      case 'search_products': {
        const found = await this.search.searchProducts(context, {
          text: request.text,
          categoryId: request.categoryId,
          limit: TOOL_ITEM_LIMIT,
        });
        if (!found.ok) return failed;
        return shown(found.value.map(productCard), forModelOf(found.value));
      }
      case 'list_bestsellers': {
        const found = await this.search.bestsellers(context, {
          categoryId: request.categoryId,
          limit: TOOL_ITEM_LIMIT,
        });
        if (!found.ok) return failed;
        return shown(found.value.map(productCard), forModelOf(found.value));
      }
      case 'list_specials': {
        const found = await this.search.specials(context, {
          categoryId: request.categoryId,
          limit: TOOL_ITEM_LIMIT,
        });
        if (!found.ok) return failed;
        return shown(found.value.map(productCard), forModelOf(found.value));
      }
      case 'list_categories': {
        const tree = await this.catalog.categories(context);
        if (!tree.ok) return failed;
        return shown([], {
          categories: tree.value.map(({ id, parentId, name }) => ({ id, parentId, name })),
        });
      }
      case 'show_page':
        return shown([{ kind: 'page', page: request.page, categoryId: request.categoryId }], {
          shownToBuyer: 'link card',
        });
      case 'support_contact': {
        const email = await this.support.publicEmail(context);
        return shown([{ kind: 'support', email }], { shownToBuyer: 'support contact card' });
      }
      case 'suggest_cart_change':
        return {
          forModel: JSON.stringify({
            status: 'not ready yet: the buyer changes the cart on the cart page',
          }),
          isError: false,
          cards: [{ kind: 'page', page: 'cart', categoryId: null }],
          notices: ['cart-actions-not-ready'],
        };
      case 'open_support_form': {
        const email = await this.support.publicEmail(context);
        return {
          forModel: JSON.stringify({ status: 'not ready yet: the support contact card is shown' }),
          isError: false,
          cards: [{ kind: 'support', email }],
          notices: ['support-form-not-ready'],
        };
      }
    }
  }
}
