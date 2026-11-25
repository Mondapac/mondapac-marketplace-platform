import { CATALOG_PRODUCT_APPROVE } from '../../src/modules/catalog/contracts/permissions';
import { OFFER_REVIEW_ALERT_KEY } from '../../src/modules/identity/application/use-cases/offer-review-alert-recipients.use-case';

// identity does not import catalog, so the key whose holders get the Offer review queue backlog
// mail (slice 8b) is written in identity. It must stay the key catalog declares for approving
// Offers: a renamed key there would otherwise leave the mail with no recipients.
describe('the Offer review backlog mail key (slice 8b)', () => {
  it('is catalog’s Offer approve permission, a platform (admin) key', () => {
    expect(OFFER_REVIEW_ALERT_KEY).toBe(CATALOG_PRODUCT_APPROVE.key);
    expect(CATALOG_PRODUCT_APPROVE.scope).toBe('platform');
  });
});
