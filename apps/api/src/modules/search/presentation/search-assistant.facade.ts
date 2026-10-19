import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { ListBestsellers } from '../application/use-cases/list-bestsellers.use-case';
import type { ListSpecials } from '../application/use-cases/list-specials.use-case';
import type { SearchProducts } from '../application/use-cases/search-products.use-case';
import type {
  AssistantProduct,
  AssistantSearchFailure,
  AssistantSpecial,
  SearchAssistantFacade,
} from '../contracts';

const productOf = (item: AssistantProduct): AssistantProduct => ({
  offerId: item.offerId,
  productId: item.productId,
  sellerId: item.sellerId,
  name: item.name,
  shortText: item.shortText,
});

/** Any refusal but validation is "unavailable" to the assistant: it says it could not read. */
const failureOf = (code: string): AssistantSearchFailure => ({
  code: code === 'validation.failed' ? 'validation.failed' : 'search.unavailable',
});

/** Passes the caller's `CallContext` unchanged to one storefront use case each, so the gate runs. */
export class SearchAssistantFacadeImplementation implements SearchAssistantFacade {
  constructor(
    private readonly search: SearchProducts,
    private readonly bestsellerShelf: ListBestsellers,
    private readonly specialShelf: ListSpecials,
  ) {}

  async searchProducts(
    context: CallContext,
    query: Parameters<SearchAssistantFacade['searchProducts']>[1],
  ): Promise<Result<readonly AssistantProduct[], AssistantSearchFailure>> {
    const result = await this.search.execute(context, {
      q: query.text ?? undefined,
      category: query.categoryId ?? undefined,
      page: 1,
      pageSize: query.limit,
    });
    return result.ok
      ? { ok: true, value: result.value.items.map(productOf) }
      : { ok: false, error: failureOf(result.error.code) };
  }

  async bestsellers(
    context: CallContext,
    query: Parameters<SearchAssistantFacade['bestsellers']>[1],
  ): Promise<Result<readonly AssistantProduct[], AssistantSearchFailure>> {
    const result = await this.bestsellerShelf.execute(context, {
      category: query.categoryId ?? undefined,
      limit: query.limit,
    });
    return result.ok
      ? { ok: true, value: result.value.items.map(productOf) }
      : { ok: false, error: failureOf(result.error.code) };
  }

  async specials(
    context: CallContext,
    query: Parameters<SearchAssistantFacade['specials']>[1],
  ): Promise<Result<readonly AssistantSpecial[], AssistantSearchFailure>> {
    const result = await this.specialShelf.execute(context, {
      category: query.categoryId ?? undefined,
      limit: query.limit,
    });
    return result.ok
      ? {
          ok: true,
          value: result.value.items.map((item) => ({
            ...productOf(item),
            price: item.price,
            regularPrice: item.regularPrice,
            taxInclusive: item.taxInclusive,
          })),
        }
      : { ok: false, error: failureOf(result.error.code) };
  }
}
