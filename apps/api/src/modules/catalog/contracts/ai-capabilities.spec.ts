import { CATALOG_AI_CAPABILITIES } from './ai-capabilities';

// The data categories catalog's capabilities declare are what the owner's shadow approval covers (AI
// Gateway G6c; ADR-0019 decision 3, R15). A change needs the security review (Hassan 4, G6c review).
describe('catalog AI capabilities: declared data categories (G6c)', () => {
  it('declares seller texts only: the writer sends the form data, with no tools', () => {
    expect(
      CATALOG_AI_CAPABILITIES.map((spec) => [spec.id, spec.dataCategories, spec.maxToolRounds]),
    ).toEqual([
      ['catalog.description-writer.seller', ['seller-text'], 0],
      ['catalog.description-writer.admin', ['seller-text'], 0],
    ]);
  });
});
