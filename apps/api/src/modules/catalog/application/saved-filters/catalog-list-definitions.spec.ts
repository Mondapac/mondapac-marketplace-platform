import type { ListDefinition } from '../../../lists';
import { LISTS_AUDIT_LIST_KEYS } from '../../../lists/domain/audit';
import {
  CATALOG_OWN_SAVED_FILTER_SHARE,
  CATALOG_SAVED_FILTER_SHARE,
} from '../../contracts/permissions';
import { AdminVariantsList } from '../use-cases/admin-variants-list.use-case';
import { AttributeAdminList } from '../use-cases/attribute-admin-list.use-case';
import { AttributeSuggestionList } from '../use-cases/attribute-suggestion-list.use-case';
import { BrandList } from '../use-cases/brand-list.use-case';
import { BusinessActivityList } from '../use-cases/business-activity-list.use-case';
import { CategoryProposalList } from '../use-cases/category-proposal-list.use-case';
import { OwnAttributeSuggestionsList } from '../use-cases/own-attribute-suggestions-list.use-case';
import { OwnTopicSuggestionsList } from '../use-cases/own-topic-suggestions-list.use-case';
import { ProductsMissingDetailsList } from '../use-cases/products-missing-details-list.use-case';
import { ReviewQueueList } from '../use-cases/review-queue-list.use-case';
import { TopicList } from '../use-cases/topic-list.use-case';
import { TopicSuggestionList } from '../use-cases/topic-suggestion-list.use-case';
import { VariantRequestList } from '../use-cases/variant-request-list.use-case';
import { CATALOG_PHASE2_LISTS } from './catalog-list-definitions';

// The saved-filter documents of the catalog lists of super list phase 2: closed and versioned, in
// the shape the panels save (`{ v: 1, filters?, q?, sort, direction }`, no tabs here).

const byKey = (key: string): ListDefinition => {
  const list = CATALOG_PHASE2_LISTS.find((candidate) => candidate.listKey === key);
  if (list === undefined) throw new Error(`missing ${key}`);
  return list;
};
const fieldsOf = (list: ListDefinition, payload: unknown) => {
  const result = list.parsePayload(payload);
  return result.ok ? null : result.error.fields;
};
const UUID = '0199aaaa-0000-7000-8000-000000000001';

describe('the catalog phase 2 saved-filter lists', () => {
  it('registers the eleven admin lists and the two seller lists, each in the audit vocabulary', () => {
    expect(CATALOG_PHASE2_LISTS.map((list) => list.listKey)).toEqual([
      'admin.catalog.variants',
      'admin.catalog.variant-requests',
      'admin.catalog.attributes',
      'admin.catalog.products-missing-details',
      'admin.catalog.attribute-suggestions',
      'admin.catalog.brands',
      'admin.catalog.business-activities',
      'admin.catalog.tags',
      'admin.catalog.tag-suggestions',
      'admin.catalog.category-proposals',
      'admin.catalog.review-queue',
      'seller.catalog.attribute-suggestions',
      'seller.catalog.topic-suggestions',
    ]);
    for (const list of CATALOG_PHASE2_LISTS) {
      expect(LISTS_AUDIT_LIST_KEYS as readonly string[]).toContain(list.listKey);
      expect(list.listKey.startsWith(`${list.population}.`)).toBe(true);
      expect(list.columns).toBeUndefined();
      expect(list.listKey).toMatch(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*){1,3}$/);
      expect(list.listKey.length).toBeLessThanOrEqual(64);
    }
  });

  it('guards each list with the key its own list use case checks', () => {
    const rules: readonly [string, { access: { rule: unknown } }][] = [
      ['admin.catalog.variants', AdminVariantsList],
      ['admin.catalog.variant-requests', VariantRequestList],
      ['admin.catalog.attributes', AttributeAdminList],
      ['admin.catalog.products-missing-details', ProductsMissingDetailsList],
      ['admin.catalog.attribute-suggestions', AttributeSuggestionList],
      ['admin.catalog.brands', BrandList],
      ['admin.catalog.business-activities', BusinessActivityList],
      ['admin.catalog.tags', TopicList],
      ['admin.catalog.tag-suggestions', TopicSuggestionList],
      ['admin.catalog.category-proposals', CategoryProposalList],
      ['admin.catalog.review-queue', ReviewQueueList],
      ['seller.catalog.attribute-suggestions', OwnAttributeSuggestionsList],
      ['seller.catalog.topic-suggestions', OwnTopicSuggestionsList],
    ];
    for (const [key, useCase] of rules) {
      expect(useCase.access.rule).toEqual({ kind: 'permissions', allOf: [byKey(key).viewKey] });
    }
  });

  it('shares admin filters with one key and seller filters with the store key', () => {
    for (const list of CATALOG_PHASE2_LISTS) {
      if (list.population === 'admin') {
        expect(list.shareKey).toBe(CATALOG_SAVED_FILTER_SHARE.key);
        expect(list.scope).toBeUndefined();
      } else {
        expect(list.shareKey).toBe(CATALOG_OWN_SAVED_FILTER_SHARE.key);
        expect(list.scope).toBe('store');
      }
    }
  });

  describe.each([
    ['admin.catalog.variant-requests', 'created'],
    ['admin.catalog.attribute-suggestions', 'created'],
    ['admin.catalog.tag-suggestions', 'created'],
    ['admin.catalog.category-proposals', 'created'],
  ])('%s (search only)', (key, sort) => {
    const list = byKey(key);

    it('keeps the trimmed search, canonical and stable', () => {
      const result = list.parsePayload({ v: 1, q: '  nuts ', sort, direction: 'desc' });
      expect(result).toEqual({
        ok: true,
        value: { v: 1, q: 'nuts', filters: {}, sort, direction: 'desc' },
      });
      if (result.ok) expect(list.parsePayload(result.value)).toEqual(result);
    });

    it.each([
      [{ v: 1, sort, direction: 'asc', q: 'a'.repeat(121) }, 'payload.q', 'length'],
      [{ v: 1, sort, direction: 'asc', q: 'a\u0007b' }, 'payload.q', 'format'],
      [
        { v: 1, sort, direction: 'asc', filters: { status: 'open' } },
        'payload.filters.status',
        'unknown',
      ],
      [{ v: 1, view: 'all', sort, direction: 'asc' }, 'payload.view', 'unknown'],
      [{ v: 1, sort: 'name', direction: 'asc' }, 'payload.sort', 'value'],
      [{ v: 1, sort, direction: 'up' }, 'payload.direction', 'value'],
      [{ v: 1, direction: 'asc' }, 'payload.sort', 'required'],
    ])('refuses %j', (payload, path, code) => {
      expect(fieldsOf(list, payload)).toEqual([{ path, code }]);
    });
  });

  describe('admin.catalog.variants', () => {
    const list = byKey('admin.catalog.variants');
    it('keeps the type and the issue', () => {
      const payload = {
        v: 1,
        q: 'size',
        filters: { typeCode: 'size', issue: 'missing-gtin' },
        sort: 'newest',
        direction: 'desc',
      };
      const result = list.parsePayload(payload);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(list.parsePayload(result.value)).toEqual(result);
        expect(result.value).toMatchObject({ filters: { typeCode: 'size' } });
      }
    });
    it('refuses what the list refuses', () => {
      expect(
        fieldsOf(list, {
          v: 1,
          filters: { typeCode: 'Not A Code' },
          sort: 'newest',
          direction: 'asc',
        }),
      ).toEqual([{ path: 'payload.filters.typeCode', code: 'format' }]);
      expect(
        fieldsOf(list, { v: 1, filters: { issue: 'nope' }, sort: 'newest', direction: 'asc' }),
      ).toEqual([{ path: 'payload.filters.issue', code: 'value' }]);
    });
  });

  describe('admin.catalog.attributes', () => {
    const list = byKey('admin.catalog.attributes');
    it('keeps the filters the list reads and refuses the rest', () => {
      const payload = {
        v: 1,
        q: 'colour',
        filters: { type: 'select', status: 'active', usedIn: UUID, missing: 'fa' },
        sort: 'code',
        direction: 'asc',
      };
      const result = list.parsePayload(payload);
      expect(result).toEqual({ ok: true, value: payload });
      expect(
        fieldsOf(list, { v: 1, filters: { type: 'blob' }, sort: 'code', direction: 'asc' }),
      ).toEqual([{ path: 'payload.filters.type', code: 'unknown' }]);
      expect(
        fieldsOf(list, { v: 1, filters: { status: 'gone' }, sort: 'code', direction: 'asc' }),
      ).toEqual([{ path: 'payload.filters.status', code: 'unknown' }]);
      expect(
        fieldsOf(list, { v: 1, filters: { usedIn: 'x' }, sort: 'code', direction: 'asc' }),
      ).toEqual([{ path: 'payload.filters.usedIn', code: 'format' }]);
      expect(
        fieldsOf(list, {
          v: 1,
          filters: { missing: 'NOT A LOCALE' },
          sort: 'code',
          direction: 'asc',
        }),
      ).toEqual([{ path: 'payload.filters.missing', code: 'unknown' }]);
    });
  });

  describe('admin.catalog.products-missing-details', () => {
    const list = byKey('admin.catalog.products-missing-details');
    it('keeps the seller and the family, and lowercases the seller id', () => {
      const result = list.parsePayload({
        v: 1,
        filters: { sellerId: UUID.toUpperCase(), familyCode: 'food' },
        sort: 'missing',
        direction: 'desc',
      });
      expect(result).toEqual({
        ok: true,
        value: {
          v: 1,
          filters: { sellerId: UUID, familyCode: 'food' },
          sort: 'missing',
          direction: 'desc',
        },
      });
    });
    it('refuses a seller that is no id and a family that is no code', () => {
      expect(
        fieldsOf(list, { v: 1, filters: { sellerId: 'x' }, sort: 'code', direction: 'asc' }),
      ).toEqual([{ path: 'payload.filters.sellerId', code: 'format' }]);
      expect(
        fieldsOf(list, { v: 1, filters: { familyCode: 'Food' }, sort: 'code', direction: 'asc' }),
      ).toEqual([{ path: 'payload.filters.familyCode', code: 'format' }]);
    });
  });

  describe('admin.catalog.brands', () => {
    const list = byKey('admin.catalog.brands');
    it('keeps the status, the country and the created range', () => {
      const payload = {
        v: 1,
        q: 'al',
        filters: {
          status: 'active',
          originCountry: 'AU',
          createdFrom: '2026-11-01T00:00:00Z',
          createdTo: '2026-11-30T00:00:00Z',
        },
        sort: 'name',
        direction: 'asc',
      };
      const result = list.parsePayload(payload);
      expect(result.ok).toBe(true);
      if (result.ok) expect(list.parsePayload(result.value)).toEqual(result);
    });
    it.each([
      [{ status: 'x' }, 'payload.filters.status', 'unknown'],
      [{ originCountry: 'au' }, 'payload.filters.originCountry', 'format'],
    ])('refuses %j', (filters, path, code) => {
      expect(fieldsOf(list, { v: 1, filters, sort: 'name', direction: 'asc' })).toEqual([
        { path, code },
      ]);
    });
  });

  describe('admin.catalog.business-activities and admin.catalog.tags', () => {
    it.each(['admin.catalog.business-activities', 'admin.catalog.tags', 'admin.catalog.brands'])(
      '%s reads the search like its list: 120 characters, no control characters',
      (key) => {
        const list = byKey(key);
        const sort =
          key === 'admin.catalog.tags' ? 'slug' : key.endsWith('brands') ? 'name' : 'code';
        const base = { v: 1, sort, direction: 'asc' };
        expect(list.parsePayload({ ...base, q: 'a'.repeat(120) }).ok).toBe(true);
        expect(fieldsOf(list, { ...base, q: 'a'.repeat(121) })).toEqual([
          { path: 'payload.q', code: 'length' },
        ]);
        expect(fieldsOf(list, { ...base, q: 'a\nb' })).toEqual([
          { path: 'payload.q', code: 'format' },
        ]);
      },
    );
    it.each([
      ['admin.catalog.business-activities', 'code'],
      ['admin.catalog.tags', 'slug'],
    ])('%s keeps the created range and the preset id, and refuses bad ones', (key, sort) => {
      const list = byKey(key);
      const base = { sort, direction: 'asc' };
      const filters = {
        created: 'last-7-days',
        createdFrom: '2026-11-01T00:00:00+10:00',
        createdTo: '2026-11-30T00:00:00Z',
      };
      const saved = list.parsePayload({ v: 1, filters, ...base });
      expect(saved.ok && (saved.value as { filters: unknown }).filters).toEqual({
        created: 'last-7-days',
        createdFrom: '2026-10-31T14:00:00Z',
        createdTo: '2026-11-30T00:00:00Z',
      });
      expect(fieldsOf(list, { v: 1, filters: { createdFrom: '2026-11-01' }, ...base })).toEqual([
        { path: 'payload.filters.createdFrom', code: 'format' },
      ]);
      expect(fieldsOf(list, { v: 1, filters: { created: 'Last 7 Days' }, ...base })).toEqual([
        { path: 'payload.filters.created', code: 'format' },
      ]);
      expect(
        fieldsOf(list, {
          v: 1,
          filters: { createdFrom: '2026-12-01T00:00:00Z', createdTo: '2026-11-01T00:00:00Z' },
          ...base,
        }),
      ).toEqual([{ path: 'payload.filters.createdTo', code: 'range' }]);
    });
    it('keeps the status of an activity and refuses a bad one', () => {
      const list = byKey('admin.catalog.business-activities');
      expect(
        list.parsePayload({ v: 1, filters: { status: 'active' }, sort: 'code', direction: 'asc' }),
      ).toEqual({
        ok: true,
        value: { v: 1, filters: { status: 'active' }, sort: 'code', direction: 'asc' },
      });
      expect(
        fieldsOf(list, { v: 1, filters: { status: 'x' }, sort: 'code', direction: 'asc' }),
      ).toEqual([{ path: 'payload.filters.status', code: 'unknown' }]);
    });
    it('keeps the status and the group of a tag and refuses bad ones', () => {
      const list = byKey('admin.catalog.tags');
      expect(
        list.parsePayload({
          v: 1,
          filters: { status: 'active', group: 'cuisine' },
          sort: 'slug',
          direction: 'asc',
        }).ok,
      ).toBe(true);
      expect(
        fieldsOf(list, { v: 1, filters: { group: 'nope' }, sort: 'slug', direction: 'asc' }),
      ).toEqual([{ path: 'payload.filters.group', code: 'unknown' }]);
      expect(
        fieldsOf(list, { v: 1, filters: { status: 'nope' }, sort: 'slug', direction: 'asc' }),
      ).toEqual([{ path: 'payload.filters.status', code: 'unknown' }]);
    });
  });

  describe('admin.catalog.review-queue', () => {
    const list = byKey('admin.catalog.review-queue');
    it('keeps the kind, the seller and the revision flags', () => {
      const payload = {
        v: 1,
        filters: {
          kind: 'product-revision',
          sellerId: UUID,
          firstPublication: 'true',
          hasImages: 'false',
        },
        sort: 'submitted',
        direction: 'asc',
      };
      expect(list.parsePayload(payload)).toEqual({ ok: true, value: payload });
    });
    it('refuses what the queue refuses, and has no search', () => {
      expect(
        fieldsOf(list, { v: 1, filters: { kind: 'x' }, sort: 'submitted', direction: 'asc' }),
      ).toEqual([{ path: 'payload.filters.kind', code: 'unknown' }]);
      expect(
        fieldsOf(list, {
          v: 1,
          filters: { hasImages: 'yes' },
          sort: 'submitted',
          direction: 'asc',
        }),
      ).toEqual([{ path: 'payload.filters.hasImages', code: 'type' }]);
      expect(
        fieldsOf(list, {
          v: 1,
          filters: { kind: 'offer-first-publication', hasImages: 'true' },
          sort: 'submitted',
          direction: 'asc',
        }),
      ).toEqual([{ path: 'payload.filters.hasImages', code: 'not-allowed' }]);
    });
  });

  describe.each(['seller.catalog.attribute-suggestions', 'seller.catalog.topic-suggestions'])(
    '%s',
    (key) => {
      const list = byKey(key);
      it('keeps the status, the label search and the sort', () => {
        const payload = {
          v: 1,
          q: 'sea salt',
          filters: { status: 'open' },
          sort: 'label',
          direction: 'asc',
        };
        expect(list.parsePayload(payload)).toEqual({ ok: true, value: payload });
      });
      it('refuses a status the list does not know and a sort it does not have', () => {
        expect(
          fieldsOf(list, { v: 1, filters: { status: 'done' }, sort: 'created', direction: 'asc' }),
        ).toEqual([{ path: 'payload.filters.status', code: 'enum' }]);
        expect(fieldsOf(list, { v: 1, sort: 'code', direction: 'asc' })).toEqual([
          { path: 'payload.sort', code: 'value' },
        ]);
      });
    },
  );
});
