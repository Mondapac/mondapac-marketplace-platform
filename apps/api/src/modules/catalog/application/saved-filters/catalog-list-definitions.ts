import {
  canonicalQuery,
  savedListPayloadParser,
  type ListDefinition,
  type ListQueryField,
} from '../../../lists';
import { parseNamedInstantRange } from '../../../../platform/list-query';
import {
  CATALOG_ATTRIBUTE_SUGGESTION_DECIDE,
  CATALOG_ATTRIBUTE_VIEW,
  CATALOG_BRAND_READ,
  CATALOG_BUSINESS_ACTIVITY_READ,
  CATALOG_CATEGORY_PROPOSAL_DECIDE,
  CATALOG_OWN_PRODUCT_VIEW,
  CATALOG_OWN_SAVED_FILTER_SHARE,
  CATALOG_PRODUCT_VIEW,
  CATALOG_SAVED_FILTER_SHARE,
  CATALOG_TOPIC_READ,
  CATALOG_TOPIC_SUGGESTION_REVIEW,
  CATALOG_VARIANT_REQUEST_REVIEW,
  CATALOG_VARIANT_VIEW,
} from '../../contracts/permissions';
import { listFilterOf } from '../attributes/attribute-admin-views';
import { BRAND_FILTER_KEYS, brandListFilterOf } from '../brands/brand-views';
import { statusOf as activityStatusOf } from '../business-activities/business-activity-views';
import { ACTIVITY_SORTS } from '../ports/business-activity.reader';
import { BRAND_SORTS } from '../ports/brand.reader';
import { OWN_SUGGESTION_SORTS } from '../ports/own-suggestion-page';
import { TOPIC_SORTS } from '../ports/topic.reader';
import { VARIANT_SORTS } from '../ports/variant-admin.reader';
import type { ValidationFailure } from '../own-reads/own-reads.shared';
import { topicGroupOf, topicStatusOf } from '../topics/topic-views';
import { ATTRIBUTE_SORTS } from '../use-cases/attribute-admin-list.use-case';
import { SUGGESTION_SORTS } from '../use-cases/attribute-suggestion-list.use-case';
import { PROPOSAL_SORTS } from '../use-cases/category-proposal-list.use-case';
import { GAP_SORTS } from '../use-cases/products-missing-details-list.use-case';
import {
  parseQueueSearch,
  REVIEW_QUEUE_KINDS,
  REVIEW_QUEUE_SORTS,
} from '../use-cases/review-queue-list.use-case';
import { TOPIC_SUGGESTION_SORTS } from '../use-cases/topic-suggestion-list.use-case';
import { VARIANT_REQUEST_SORTS } from '../use-cases/variant-request-list.use-case';
import { parseFilter as parseVariantsFilter } from '../variants/variant-admin.shared';
import { parseOfferReviewReasons } from '../offer-changes/review-reasons-filter';
import { OFFER_CHANGES_SORTS } from '../use-cases/admin-offer-changes-list.use-case';
import {
  OFFER_POST_REVIEW_VIEWS,
  parsePostReviewReasons,
} from '../offer-post-review/post-review-rows';
import { OFFER_POST_REVIEWS_SORTS } from '../use-cases/admin-offer-post-reviews-list.use-case';

// The catalog lists of super list phase 2 register with `lists` so they have saved filters through
// the generic routes (B0-1b): the admin lists 3 to 13 (the Product review queue and the Revision
// queue are one list, told apart by `kind`) and the seller suggestion lists 34 and 35. A saved
// filter holds the list's tab (none here), `q`, its filter keys, the sort and its direction; each
// list's own reading of those keys checks the values, so a saved value is exactly one the list
// accepts. The keys are the ones that guard each list. Paging and columns are not saved.

type Query = Readonly<Record<string, string>>;
type Read = ReturnType<Parameters<typeof savedListPayloadParser>[0]['read']>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE = /^[a-z][a-z0-9_-]{0,63}$/;
const LOCALE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

const fieldsOf = (failure: ValidationFailure): readonly ListQueryField[] =>
  failure.fields.map((field) => ({ path: field.path, code: field.code }));

const refused = (path: string, code: string): Read => ({ fields: [{ path, code }], canonical: {} });

/** The search text as the lists read it: at most `max` code points, trimmed, blank left out. */
function textOf(query: Query, max: number): { text: string | null; refusal: Read | null } {
  const raw = query['q'];
  if (raw === undefined) return { text: null, refusal: null };
  const trimmed = raw.trim();
  if ([...trimmed].length > max) return { text: null, refusal: refused('q', 'length') };
  return { text: trimmed === '' ? null : trimmed, refusal: null };
}

const PRESET = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * The date filter of a list in a saved filter: the instants the list reads (`<from>` inclusive,
 * `<to>` exclusive), and `preset`, the id of the panel's date preset (for example `last-7-days`).
 * The panel stores the preset id so a saved "Last 7 days" keeps moving, and turns it into instants
 * on each load; the server keeps the id as an opaque token and never resolves it.
 */
function dateFilterOf(
  query: Query,
  keys: { readonly from: string; readonly to: string; readonly preset: string },
): { refusal: Read | null; canonical: Record<string, { toString(): string } | null> } {
  const range = parseNamedInstantRange(query, keys.from, keys.to);
  if (!range.ok) {
    return { refusal: { fields: range.error.fields, canonical: {} }, canonical: {} };
  }
  const preset = query[keys.preset];
  if (preset !== undefined && !PRESET.test(preset)) {
    return { refusal: refused(keys.preset, 'format'), canonical: {} };
  }
  return {
    refusal: null,
    canonical: {
      [keys.from]: range.value.from,
      [keys.to]: range.value.to,
      [keys.preset]: preset ?? null,
    },
  };
}

const SUBMITTED_KEYS = ['submittedFrom', 'submittedTo', 'submitted'] as const;
const SUBMITTED = { from: 'submittedFrom', to: 'submittedTo', preset: 'submitted' } as const;
const CREATED_KEYS = ['createdFrom', 'createdTo', 'created'] as const;
const CREATED = { from: 'createdFrom', to: 'createdTo', preset: 'created' } as const;

/** A list whose filters are its search text and the created range. */
function searchAndCreated(max: number): (query: Query) => Read {
  return (query) => {
    const { text, refusal } = textOf(query, max);
    const date = dateFilterOf(query, CREATED);
    return (
      refusal ??
      date.refusal ?? { fields: [], canonical: canonicalQuery({ q: text, ...date.canonical }) }
    );
  };
}

const VARIANTS: ListDefinition = {
  listKey: 'admin.catalog.variants',
  population: 'admin',
  viewKey: CATALOG_VARIANT_VIEW.key,
  shareKey: CATALOG_SAVED_FILTER_SHARE.key,
  parsePayload: savedListPayloadParser({
    views: null,
    filterKeys: ['typeCode', 'issue'],
    sorts: VARIANT_SORTS,
    read(query) {
      const parsed = parseVariantsFilter({ ...query });
      if (!parsed.ok) return { fields: fieldsOf(parsed.error), canonical: {} };
      const { text, typeCode, issue } = parsed.value;
      return { fields: [], canonical: canonicalQuery({ q: text, typeCode, issue }) };
    },
  }),
};

const VARIANT_REQUESTS: ListDefinition = {
  listKey: 'admin.catalog.variant-requests',
  population: 'admin',
  viewKey: CATALOG_VARIANT_REQUEST_REVIEW.key,
  shareKey: CATALOG_SAVED_FILTER_SHARE.key,
  parsePayload: savedListPayloadParser({
    views: null,
    filterKeys: CREATED_KEYS,
    sorts: VARIANT_REQUEST_SORTS,
    read: searchAndCreated(100),
  }),
};

const ATTRIBUTES: ListDefinition = {
  listKey: 'admin.catalog.attributes',
  population: 'admin',
  viewKey: CATALOG_ATTRIBUTE_VIEW.key,
  shareKey: CATALOG_SAVED_FILTER_SHARE.key,
  parsePayload: savedListPayloadParser({
    views: null,
    filterKeys: ['type', 'status', 'usedIn', 'missing'],
    sorts: ATTRIBUTE_SORTS,
    read(query) {
      const missing = query['missing'];
      // The Market's locales are not known here; the list refuses a locale it does not support,
      // and a saved one that was dropped later simply matches nothing.
      if (missing !== undefined && !LOCALE.test(missing)) return refused('missing', 'unknown');
      const parsed = listFilterOf(
        {
          search: query['q'],
          type: query['type'],
          status: query['status'],
          usedIn: query['usedIn'],
          missing,
        },
        { default: missing ?? 'en', supported: missing === undefined ? [] : [missing] },
      );
      if (!parsed.ok) {
        return {
          fields: fieldsOf(parsed.error).map((field) =>
            field.path === 'search' ? { ...field, path: 'q' } : field,
          ),
          canonical: {},
        };
      }
      const { search, dataType, status, usedIn } = parsed.value;
      return {
        fields: [],
        canonical: canonicalQuery({
          q: search,
          type: dataType,
          status,
          usedIn,
          missing: missing ?? null,
        }),
      };
    },
  }),
};

const MISSING_DETAILS: ListDefinition = {
  listKey: 'admin.catalog.products-missing-details',
  population: 'admin',
  viewKey: CATALOG_ATTRIBUTE_VIEW.key,
  shareKey: CATALOG_SAVED_FILTER_SHARE.key,
  parsePayload: savedListPayloadParser({
    views: null,
    filterKeys: ['sellerId', 'familyCode'],
    sorts: GAP_SORTS,
    read(query) {
      const sellerId = query['sellerId'];
      if (sellerId !== undefined && !UUID.test(sellerId)) return refused('sellerId', 'format');
      const familyCode = query['familyCode'];
      if (familyCode !== undefined && !CODE.test(familyCode)) {
        return refused('familyCode', 'format');
      }
      const { text, refusal } = textOf(query, 120);
      return (
        refusal ?? {
          fields: [],
          canonical: canonicalQuery({
            q: text,
            sellerId: sellerId === undefined ? null : sellerId.toLowerCase(),
            familyCode: familyCode ?? null,
          }),
        }
      );
    },
  }),
};

const ATTRIBUTE_SUGGESTIONS: ListDefinition = {
  listKey: 'admin.catalog.attribute-suggestions',
  population: 'admin',
  viewKey: CATALOG_ATTRIBUTE_SUGGESTION_DECIDE.key,
  shareKey: CATALOG_SAVED_FILTER_SHARE.key,
  parsePayload: savedListPayloadParser({
    views: null,
    filterKeys: CREATED_KEYS,
    sorts: SUGGESTION_SORTS,
    read: searchAndCreated(100),
  }),
};

const BRANDS: ListDefinition = {
  listKey: 'admin.catalog.brands',
  population: 'admin',
  viewKey: CATALOG_BRAND_READ.key,
  shareKey: CATALOG_SAVED_FILTER_SHARE.key,
  parsePayload: savedListPayloadParser({
    views: null,
    filterKeys: BRAND_FILTER_KEYS,
    sorts: BRAND_SORTS,
    read(query) {
      const parsed = brandListFilterOf(query);
      if (!parsed.ok) return { fields: fieldsOf(parsed.error), canonical: {} };
      const { status, originCountry, createdFrom, createdTo } = parsed.value;
      const { text, refusal } = textOf(query, 120);
      return (
        refusal ?? {
          fields: [],
          canonical: canonicalQuery({ q: text, status, originCountry, createdFrom, createdTo }),
        }
      );
    },
  }),
};

const BUSINESS_ACTIVITIES: ListDefinition = {
  listKey: 'admin.catalog.business-activities',
  population: 'admin',
  viewKey: CATALOG_BUSINESS_ACTIVITY_READ.key,
  shareKey: CATALOG_SAVED_FILTER_SHARE.key,
  parsePayload: savedListPayloadParser({
    views: null,
    filterKeys: ['status', ...CREATED_KEYS],
    sorts: ACTIVITY_SORTS,
    read(query) {
      let status: string | null = null;
      if (query['status'] !== undefined) {
        const parsed = activityStatusOf(query['status'], 'status');
        if (!parsed.ok) return { fields: fieldsOf(parsed.error), canonical: {} };
        status = parsed.value;
      }
      const { text, refusal } = textOf(query, 120);
      const date = dateFilterOf(query, CREATED);
      return (
        refusal ??
        date.refusal ?? {
          fields: [],
          canonical: canonicalQuery({ q: text, status, ...date.canonical }),
        }
      );
    },
  }),
};

const TAGS: ListDefinition = {
  listKey: 'admin.catalog.tags',
  population: 'admin',
  viewKey: CATALOG_TOPIC_READ.key,
  shareKey: CATALOG_SAVED_FILTER_SHARE.key,
  parsePayload: savedListPayloadParser({
    views: null,
    filterKeys: ['status', 'group', ...CREATED_KEYS],
    sorts: TOPIC_SORTS,
    read(query) {
      let status: string | null = null;
      if (query['status'] !== undefined) {
        const parsed = topicStatusOf(query['status'], 'status');
        if (!parsed.ok) return { fields: fieldsOf(parsed.error), canonical: {} };
        status = parsed.value;
      }
      let group: string | null = null;
      if (query['group'] !== undefined) {
        const parsed = topicGroupOf(query['group'], 'group');
        if (!parsed.ok) return { fields: fieldsOf(parsed.error), canonical: {} };
        group = parsed.value;
      }
      const { text, refusal } = textOf(query, 120);
      const date = dateFilterOf(query, CREATED);
      return (
        refusal ??
        date.refusal ?? {
          fields: [],
          canonical: canonicalQuery({ q: text, status, group, ...date.canonical }),
        }
      );
    },
  }),
};

const TAG_SUGGESTIONS: ListDefinition = {
  listKey: 'admin.catalog.tag-suggestions',
  population: 'admin',
  viewKey: CATALOG_TOPIC_SUGGESTION_REVIEW.key,
  shareKey: CATALOG_SAVED_FILTER_SHARE.key,
  parsePayload: savedListPayloadParser({
    views: null,
    filterKeys: CREATED_KEYS,
    sorts: TOPIC_SUGGESTION_SORTS,
    read: searchAndCreated(100),
  }),
};

const CATEGORY_PROPOSALS: ListDefinition = {
  listKey: 'admin.catalog.category-proposals',
  population: 'admin',
  viewKey: CATALOG_CATEGORY_PROPOSAL_DECIDE.key,
  shareKey: CATALOG_SAVED_FILTER_SHARE.key,
  parsePayload: savedListPayloadParser({
    views: null,
    filterKeys: CREATED_KEYS,
    sorts: PROPOSAL_SORTS,
    read: searchAndCreated(120),
  }),
};

const FLAGS = ['true', 'false'];

const REVIEW_QUEUE: ListDefinition = {
  listKey: 'admin.catalog.review-queue',
  population: 'admin',
  viewKey: CATALOG_PRODUCT_VIEW.key,
  shareKey: CATALOG_SAVED_FILTER_SHARE.key,
  parsePayload: savedListPayloadParser({
    views: null,
    filterKeys: [
      'kind',
      'sellerId',
      'firstPublication',
      'hasImages',
      'reasons',
      'categoryId',
      ...SUBMITTED_KEYS,
    ],
    sorts: REVIEW_QUEUE_SORTS,
    read(query) {
      const kind = query['kind'];
      if (kind !== undefined && !(REVIEW_QUEUE_KINDS as readonly string[]).includes(kind)) {
        return refused('kind', 'unknown');
      }
      const sellerId = query['sellerId'];
      if (sellerId !== undefined && !UUID.test(sellerId)) return refused('sellerId', 'format');
      for (const key of ['firstPublication', 'hasImages']) {
        const value = query[key];
        if (value === undefined) continue;
        if (!FLAGS.includes(value)) return refused(key, 'type');
        // These are revision fields: asked of first publications they are refused, as the list does.
        if (kind === 'offer-first-publication') return refused(key, 'not-allowed');
      }
      // Offer fields, as the list reads them: refused for revisions and with a revision field.
      const offerFields = offerFieldsOf(query);
      if (offerFields.refusal !== null) return offerFields.refusal;
      const revisionField =
        query['firstPublication'] !== undefined || query['hasImages'] !== undefined;
      for (const key of ['reasons', 'categoryId']) {
        if (query[key] !== undefined && (kind === 'product-revision' || revisionField)) {
          return refused(key, 'not-allowed');
        }
      }
      const date = dateFilterOf(query, SUBMITTED);
      if (date.refusal !== null) return date.refusal;
      // The list's own reading of `q` (2 to 100 characters once trimmed), so a saved text is one
      // the list accepts.
      const text = parseQueueSearch(query['q']);
      if (!text.ok) return { fields: fieldsOf(text.error), canonical: {} };
      return {
        fields: [],
        canonical: canonicalQuery({
          ...date.canonical,
          q: text.value,
          kind: kind ?? null,
          sellerId: sellerId === undefined ? null : sellerId.toLowerCase(),
          firstPublication: query['firstPublication'] ?? null,
          hasImages: query['hasImages'] ?? null,
          ...offerFields.canonical,
        }),
      };
    },
  }),
};

const none = { reasons: null, categoryId: null };

/**
 * The Offer review filters shared by the first-publication queue and the held-edit list: `reasons`
 * (one or more review reason codes, comma-separated, as the lists read them) and `categoryId`.
 */
function offerFieldsOf(query: Query): {
  refusal: Read | null;
  canonical: { reasons: string | null; categoryId: string | null };
} {
  const reasons = parseOfferReviewReasons(query['reasons']);
  if (!reasons.ok) {
    return { refusal: { fields: fieldsOf(reasons.error), canonical: {} }, canonical: none };
  }
  const categoryId = query['categoryId'];
  if (categoryId !== undefined && !UUID.test(categoryId)) {
    return { refusal: refused('categoryId', 'format'), canonical: none };
  }
  return {
    refusal: null,
    canonical: {
      reasons: reasons.value === null ? null : reasons.value.join(','),
      categoryId: categoryId === undefined ? null : categoryId.toLowerCase(),
    },
  };
}
/** The "Waiting longer than" presets of the held-edit list (the panel turns each into instants). */
const OFFER_CHANGE_AGES = ['older-24h', 'older-48h', 'older-7d'];

/**
 * The held edits of live Offers (risk-based Offer approval slice 5): reasons, the age preset,
 * seller, category and the review queue's search text. The age is kept as its preset id only, as
 * the panel resolves it into instants on each load.
 */
const OFFER_CHANGES: ListDefinition = {
  listKey: 'admin.catalog.offer-changes',
  population: 'admin',
  viewKey: CATALOG_PRODUCT_VIEW.key,
  shareKey: CATALOG_SAVED_FILTER_SHARE.key,
  parsePayload: savedListPayloadParser({
    views: null,
    filterKeys: ['reasons', 'age', 'sellerId', 'categoryId'],
    sorts: OFFER_CHANGES_SORTS,
    read(query) {
      const offerFields = offerFieldsOf(query);
      if (offerFields.refusal !== null) return offerFields.refusal;
      const age = query['age'];
      if (age !== undefined && !OFFER_CHANGE_AGES.includes(age)) return refused('age', 'enum');
      const sellerId = query['sellerId'];
      if (sellerId !== undefined && !UUID.test(sellerId)) return refused('sellerId', 'format');
      const text = parseQueueSearch(query['q']);
      if (!text.ok) return { fields: fieldsOf(text.error), canonical: {} };
      return {
        fields: [],
        canonical: canonicalQuery({
          q: text.value,
          ...offerFields.canonical,
          age: age ?? null,
          sellerId: sellerId === undefined ? null : sellerId.toLowerCase(),
        }),
      };
    },
  }),
};

/**
 * The post-publication review list (risk-based Offer approval slice 6): the status (`open` by
 * default, `all` for every row), reasons, the age preset, seller, category and the review queue's
 * search text. The age is kept as its preset id only (the panel resolves it into `openedFrom` /
 * `openedTo` on each load), as the held edits list.
 */
const OFFER_POST_REVIEWS: ListDefinition = {
  listKey: 'admin.catalog.offer-post-reviews',
  population: 'admin',
  viewKey: CATALOG_PRODUCT_VIEW.key,
  shareKey: CATALOG_SAVED_FILTER_SHARE.key,
  parsePayload: savedListPayloadParser({
    views: null,
    filterKeys: ['status', 'reasons', 'age', 'sellerId', 'categoryId'],
    sorts: OFFER_POST_REVIEWS_SORTS,
    read(query) {
      const status = query['status'];
      if (
        status !== undefined &&
        !(OFFER_POST_REVIEW_VIEWS as readonly string[]).includes(status)
      ) {
        return refused('status', 'enum');
      }
      const reasons = parsePostReviewReasons(query['reasons']);
      if (!reasons.ok) return { fields: fieldsOf(reasons.error), canonical: {} };
      const age = query['age'];
      if (age !== undefined && !OFFER_CHANGE_AGES.includes(age)) return refused('age', 'enum');
      for (const key of ['sellerId', 'categoryId']) {
        const value = query[key];
        if (value !== undefined && !UUID.test(value)) return refused(key, 'format');
      }
      const text = parseQueueSearch(query['q']);
      if (!text.ok) return { fields: fieldsOf(text.error), canonical: {} };
      return {
        fields: [],
        canonical: canonicalQuery({
          q: text.value,
          status: status ?? null,
          reasons: reasons.value === null ? null : reasons.value.join(','),
          age: age ?? null,
          sellerId: query['sellerId']?.toLowerCase() ?? null,
          categoryId: query['categoryId']?.toLowerCase() ?? null,
        }),
      };
    },
  }),
};

const OWN_SUGGESTION_STATUSES = ['open', 'approved', 'mapped', 'rejected'];

/** The seller's own suggestion lists: the status and the label search, one set per store. */
const ownSuggestionList = (listKey: string): ListDefinition => ({
  listKey,
  population: 'seller',
  scope: 'store',
  viewKey: CATALOG_OWN_PRODUCT_VIEW.key,
  shareKey: CATALOG_OWN_SAVED_FILTER_SHARE.key,
  parsePayload: savedListPayloadParser({
    views: null,
    filterKeys: ['status', ...CREATED_KEYS],
    sorts: OWN_SUGGESTION_SORTS,
    read(query) {
      const status = query['status'];
      if (status !== undefined && !OWN_SUGGESTION_STATUSES.includes(status)) {
        return refused('status', 'enum');
      }
      const { text, refusal } = textOf(query, 100);
      const date = dateFilterOf(query, CREATED);
      return (
        refusal ??
        date.refusal ?? {
          fields: [],
          canonical: canonicalQuery({ q: text, status: status ?? null, ...date.canonical }),
        }
      );
    },
  }),
});

export const CATALOG_PHASE2_LISTS: readonly ListDefinition[] = [
  VARIANTS,
  VARIANT_REQUESTS,
  ATTRIBUTES,
  MISSING_DETAILS,
  ATTRIBUTE_SUGGESTIONS,
  BRANDS,
  BUSINESS_ACTIVITIES,
  TAGS,
  TAG_SUGGESTIONS,
  CATEGORY_PROPOSALS,
  REVIEW_QUEUE,
  OFFER_CHANGES,
  OFFER_POST_REVIEWS,
  ownSuggestionList('seller.catalog.attribute-suggestions'),
  ownSuggestionList('seller.catalog.topic-suggestions'),
];
