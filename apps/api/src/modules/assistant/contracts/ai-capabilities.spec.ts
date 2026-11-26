import { TOOL_DECLARATIONS } from '../domain/tools';
import { ASSISTANT_AI_CAPABILITIES } from './ai-capabilities';

// The data categories the buyer chat declares are what the owner's shadow approval covers (AI
// Gateway G6c; ADR-0019 decision 3, R15). They must change with what its requests carry: a new tool
// (an order tool, for example) fails this test until its data is declared and the security review
// (Hassan) has seen it (Hassan 4, Mohammad 7, G6c review).
describe('assistant AI capabilities: declared data categories (G6c)', () => {
  it('declares the customer message only, for the read-only tool set reviewed with it', () => {
    expect(
      ASSISTANT_AI_CAPABILITIES.map((spec) => [
        spec.id,
        spec.dataCategories,
        spec.maxToolRounds > 0,
      ]),
    ).toEqual([['assistant.buyer-chat', ['customer-message'], true]]);
    expect(TOOL_DECLARATIONS.map((tool) => tool.name)).toEqual([
      'search_products',
      'list_bestsellers',
      'list_specials',
      'get_product',
      'get_seller',
      'list_categories',
      'show_page',
      'support_contact',
      'suggest_cart_change',
      'open_support_form',
      'plan_basket',
    ]);
  });
});
