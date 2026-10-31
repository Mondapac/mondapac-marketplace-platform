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

/** The audit target type of a platform import job. */
export const CATALOG_PLATFORM_IMPORT_TARGET = 'catalog.platform-import';

/**
 * An admin confirmed a platform import (design 14a): the file was checked, the choice made and the
 * run queued. Counts and the choice only; the file's SHA-256 is on the job row (`file_sha256`), which
 * the audit target id points to, because the audit vocabulary has no text field.
 */
export const PlatformImportStartedAudit = defineAuditAction({
  action: 'catalog.platform-import.started',
  targetType: CATALOG_PLATFORM_IMPORT_TARGET,
  actors: ['authenticated'],
  before: { state: auditField.enumOf(['checked'] as const) },
  after: {
    state: auditField.enumOf(['queued'] as const),
    startAs: auditField.enumOf(['inactive', 'active'] as const),
    skipErrors: auditField.boolean(),
    rows: auditField.integer(),
    toImport: auditField.integer(),
    errorRows: auditField.integer(),
  },
});

/** The audit target type of a saved filter. */
export const CATALOG_SAVED_FILTER_TARGET = 'catalog.saved-filter';

const savedFilterVisibility = auditField.enumOf(['me', 'everyone'] as const);

/** The lists a saved filter can belong to (the keys of `SAVED_FILTER_LISTS`). */
export const SAVED_FILTER_AUDIT_LISTS = ['admin.catalog.products'] as const;
export type SavedFilterAuditList = (typeof SAVED_FILTER_AUDIT_LISTS)[number];
const savedFilterList = auditField.enumOf(SAVED_FILTER_AUDIT_LISTS);

/** An admin saved a filter for everyone (design 9.2d). The name is not audited: ids and codes only. */
export const SavedFilterSharedAudit = defineAuditAction({
  action: 'catalog.saved-filter.shared',
  targetType: CATALOG_SAVED_FILTER_TARGET,
  actors: ['authenticated'],
  after: { listKey: savedFilterList, visibility: savedFilterVisibility },
});

/**
 * An admin changed a filter that is, or was, shared with everyone: renamed it or moved it between
 * "me" and "everyone". `ownedByActor` is false when an admin with the share key changed somebody
 * else's filter.
 */
export const SavedFilterChangedAudit = defineAuditAction({
  action: 'catalog.saved-filter.changed',
  targetType: CATALOG_SAVED_FILTER_TARGET,
  actors: ['authenticated'],
  before: { visibility: savedFilterVisibility },
  after: {
    listKey: savedFilterList,
    visibility: savedFilterVisibility,
    renamed: auditField.boolean(),
    ownedByActor: auditField.boolean(),
  },
});

/** An admin deleted a filter that was shared with everyone. */
export const SavedFilterRemovedAudit = defineAuditAction({
  action: 'catalog.saved-filter.removed',
  targetType: CATALOG_SAVED_FILTER_TARGET,
  actors: ['authenticated'],
  before: { listKey: savedFilterList, visibility: savedFilterVisibility },
  after: { ownedByActor: auditField.boolean() },
});

export const CATALOG_AUDIT_ACTIONS = [
  ProductPausedAudit,
  ProductResumedAudit,
  ProductWithdrawnAudit,
  ProductRetiredAudit,
  PlatformImportStartedAudit,
  SavedFilterSharedAudit,
  SavedFilterChangedAudit,
  SavedFilterRemovedAudit,
] as const;
