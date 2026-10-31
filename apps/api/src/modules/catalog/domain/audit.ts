import { auditField, defineAuditAction } from '@mondapac/shared-kernel';
import type { ProductScope } from './product';

// The audited actions of catalog (catalog design 11.3), registered at boot with
// `registerAuditActions('catalog', CATALOG_AUDIT_ACTIONS)`. Ids, codes, counts and booleans only:
// no name, no text, no reason text. The actor is the admin of the context.

/** The audit target type of a product. */
export const CATALOG_PRODUCT_TARGET = 'catalog.product';

const scope = auditField.enumOf(['platform', 'seller'] as const);

/** The audit code of a product scope (audit enums are lower-case codes). */
export const scopeCode = (value: ProductScope): 'platform' | 'seller' =>
  value === 'PLATFORM' ? 'platform' : 'seller';

/** An admin paused a published product (design 4.1a); its Offers went off sale with it. */
export const ProductPausedAudit = defineAuditAction({
  action: 'catalog.product.paused',
  targetType: CATALOG_PRODUCT_TARGET,
  actors: ['authenticated'],
  before: { paused: auditField.boolean() },
  after: { paused: auditField.boolean(), scope, offerCount: auditField.integer() },
});

/** An admin resumed a paused product (design 4.1a); its Offers were asked again and listed. */
export const ProductResumedAudit = defineAuditAction({
  action: 'catalog.product.resumed',
  targetType: CATALOG_PRODUCT_TARGET,
  actors: ['authenticated'],
  before: { paused: auditField.boolean() },
  after: { paused: auditField.boolean(), scope, offerCount: auditField.integer() },
});

/** A SELLER product was withdrawn by an admin (design 4.1); its Offer was deleted. */
export const ProductWithdrawnAudit = defineAuditAction({
  action: 'catalog.product.withdrawn',
  targetType: CATALOG_PRODUCT_TARGET,
  actors: ['authenticated'],
  before: { status: auditField.enumOf(['unpublished', 'published'] as const) },
  after: {
    status: auditField.enumOf(['withdrawn'] as const),
    scope,
    offerCount: auditField.integer(),
  },
});

/** A PLATFORM product was retired (design 4.1; CAT-48) with the Offer count the admin confirmed. */
export const ProductRetiredAudit = defineAuditAction({
  action: 'catalog.product.retired',
  targetType: CATALOG_PRODUCT_TARGET,
  actors: ['authenticated'],
  before: { status: auditField.enumOf(['published'] as const), paused: auditField.boolean() },
  after: {
    status: auditField.enumOf(['retired'] as const),
    scope,
    offerCount: auditField.integer(),
    confirmedOfferCount: auditField.integer(),
  },
});

export const CATALOG_AUDIT_ACTIONS = [
  ProductPausedAudit,
  ProductResumedAudit,
  ProductWithdrawnAudit,
  ProductRetiredAudit,
] as const;
