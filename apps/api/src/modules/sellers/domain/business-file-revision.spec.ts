import { Temporal } from '@mondapac/shared-kernel';
import type { ContentHash, Id, MarketId } from '@mondapac/shared-kernel';
import {
  CONTENT_SCHEMA_VERSION,
  canTransition,
  canonicalContent,
  canonicalContentBytes,
  evaluateSubmission,
  newPendingRevision,
  parseContent,
  registerSnapshotOf,
  superseded,
  withdrawn,
  type BusinessFileContent,
  type NewPendingRevisionInput,
  type RevisionStatus,
  REVISION_STATUSES,
} from './business-file-revision';
import { identifierIndexKeyOf, type DraftIdentifier } from './business-identifier';
import { registerCheckAfter } from './register-check';
import type { Sealed, SealedField } from './sealed';
import { EMPTY_DRAFT, type DraftRequirements, type SellerFileDraft } from './seller-file';
import type { ShopSlug } from './shop-slug';
import { parseStoreName } from './store-name';

// The revision of a seller's business file (sellers design 2.4, 3.1; data design 3.2): canonical
// content, the keyed hash input, the submission check and the status rules. Run for the shapes
// of both Market fixtures (AU and the synthetic ZZ); the domain itself names no Market.

const T0 = Temporal.Instant.from('2026-10-08T00:00:00Z');
const SELLER = '01928a3c-0000-7000-8000-000000000001' as Id<'Seller'>;
const ACCOUNT = '01928a3c-0000-7000-8000-0000000000a1' as Id<'Account'>;
const REVISION = '01928a3c-0000-7000-8000-0000000000b1' as Id<'BusinessFileRevision'>;
const HASH = `hmac-sha256:${'a'.repeat(64)}` as ContentHash;

const sealed = <F extends SealedField>(field: F) => `v1.${field}` as Sealed<F>;
const storeName = (raw: string) => {
  const parsed = parseStoreName(raw);
  if (!parsed.ok) throw new Error('fixture store name refused');
  return parsed.value;
};

const FIXTURES = [
  {
    marketId: 'AU' as MarketId,
    operatingZone: 'Australia/Lindeman',
    addressZone: 'Australia/Brisbane',
    area: 'greater-brisbane',
    requirements: { identifierRequired: true, identifierScheme: 'abn' } satisfies DraftRequirements,
    address: { street: '1 Example St', suburb: 'Sunnybank', state: 'QLD', postcode: '4109' },
    identifier: '51824753556',
  },
  {
    marketId: 'ZZ' as MarketId,
    operatingZone: 'Pacific/Chatham',
    addressZone: 'Pacific/Auckland',
    area: 'zz-central',
    requirements: {
      identifierRequired: false,
      identifierScheme: 'zz-corp-no',
    } satisfies DraftRequirements,
    address: { line1: 'Test Road 5', locality: 'Zedville', zone: 'Z2', code: 'ZZ-77' },
    identifier: 'ZZ0000001',
  },
] as const;

type Fixture = (typeof FIXTURES)[number];

const identifierOf = (scheme: string, n = 1): DraftIdentifier => ({
  scheme,
  sealed: `v1.identifier-${n}` as Sealed<'identifier'>,
  index: identifierIndexKeyOf(new Uint8Array(32).fill(n)),
});

function completeDraft(f: Fixture, overrides: Partial<SellerFileDraft> = {}): SellerFileDraft {
  return {
    ...EMPTY_DRAFT,
    storeName: storeName('Al Noor'),
    businessName: sealed('business-name'),
    phone: sealed('phone'),
    address: sealed('address'),
    serviceAreaCode: f.area,
    zone: {
      operatingTimezone: f.operatingZone,
      timezoneSource: 'seller',
      addressTimezone: f.addressZone,
    },
    slug: 'al-noor' as ShopSlug,
    identifier: identifierOf(f.requirements.identifierScheme),
    ...overrides,
  };
}

const contentOf = (
  f: Fixture,
  overrides: Partial<BusinessFileContent> = {},
): BusinessFileContent => ({
  schemaVersion: CONTENT_SCHEMA_VERSION,
  storeName: 'Al Noor',
  businessName: 'Al Noor Trading Pty Ltd',
  phone: '+61700000000',
  contactEmail: null,
  address: { ...f.address },
  registeredAddress: null,
  identifier: { scheme: f.requirements.identifierScheme, value: f.identifier },
  registeredForIndirectTax: true,
  ...overrides,
});

describe('canonical content (design 2.4 rule 2)', () => {
  it.each(FIXTURES)(
    'sorts keys, so the order of the object never changes the bytes in $marketId',
    (f) => {
      const a = canonicalContent(contentOf(f));
      const reversed = Object.fromEntries(
        Object.entries(contentOf(f)).reverse(),
      ) as unknown as BusinessFileContent;
      const b = canonicalContent(reversed);
      expect(a).toEqual(b);
      expect(a.ok && a.value.startsWith('{"address":')).toBe(true);
      // No insignificant whitespace: a space only ever appears inside a value.
      expect(a.ok && a.value).not.toMatch(/[:,{}[\]] /);
    },
  );

  it.each(FIXTURES)('changes when any member changes in $marketId', (f) => {
    const base = canonicalContent(contentOf(f));
    for (const changed of [
      contentOf(f, { storeName: 'Al Noor 2' }),
      contentOf(f, { phone: '+61700000001' }),
      contentOf(f, { contactEmail: 'a@example.test' }),
      contentOf(f, { registeredForIndirectTax: false }),
      contentOf(f, { identifier: null }),
      contentOf(f, { registeredAddress: { ...f.address } }),
    ]) {
      expect(canonicalContent(changed)).not.toEqual(base);
    }
  });

  it('gives bytes that are the UTF-8 of the canonical text', () => {
    const f = FIXTURES[0];
    const text = canonicalContent(contentOf(f));
    const bytes = canonicalContentBytes(contentOf(f));
    expect(text.ok && bytes.ok && new TextDecoder().decode(bytes.value)).toBe(
      text.ok ? text.value : null,
    );
  });

  it('refuses a content the encoding cannot carry, and another schema version', () => {
    const f = FIXTURES[0];
    expect(canonicalContent(contentOf(f, { storeName: '\ud800' }))).toEqual({
      ok: false,
      error: { code: 'revision-content.invalid' },
    });
    expect(
      canonicalContent({ ...contentOf(f), schemaVersion: 2 } as unknown as BusinessFileContent),
    ).toEqual({ ok: false, error: { code: 'revision-content.invalid' } });
  });

  it.each(FIXTURES)('reads back exactly what it wrote in $marketId, and nothing else', (f) => {
    const written = canonicalContent(contentOf(f));
    expect(written.ok && parseContent(written.value)).toEqual({ ok: true, value: contentOf(f) });
    const invalid = { ok: false, error: { code: 'revision-content.invalid' } };
    expect(parseContent('not json')).toEqual(invalid);
    expect(parseContent('[]')).toEqual(invalid);
    expect(parseContent('{}')).toEqual(invalid);
    expect(parseContent(JSON.stringify({ ...contentOf(f), extra: 1 }))).toEqual(invalid);
    expect(parseContent(JSON.stringify({ ...contentOf(f), schemaVersion: 2 }))).toEqual(invalid);
    expect(parseContent(JSON.stringify({ ...contentOf(f), phone: 5 }))).toEqual(invalid);
    expect(parseContent(JSON.stringify({ ...contentOf(f), address: { a: 1 } }))).toEqual(invalid);
    expect(parseContent(JSON.stringify({ ...contentOf(f), identifier: { scheme: 'x' } }))).toEqual(
      invalid,
    );
  });
});

describe.each(FIXTURES)('evaluateSubmission in $marketId', (f) => {
  it('accepts a complete draft in an onboarding-enabled area and copies the zones as the file holds them', () => {
    const result = evaluateSubmission(completeDraft(f), f.requirements, true);
    expect(result).toEqual({
      ok: true,
      value: {
        operatingTimezone: f.operatingZone,
        serviceAreaCode: f.area,
        // The zone derived from the address, never the chosen operating zone (guardrail 3).
        addressTimezone: f.addressZone,
        identifierIndex: identifierOf(f.requirements.identifierScheme).index,
      },
    });
  });

  it('refuses an incomplete draft with the missing parts in form order', () => {
    const result = evaluateSubmission(
      completeDraft(f, { phone: null, slug: null, storeName: null }),
      f.requirements,
      true,
    );
    expect(result).toEqual({
      ok: false,
      error: { code: 'file.incomplete', missing: ['storeName', 'phone', 'slug'] },
    });
  });

  it('asks for the identifier only where the Market requires it, and of the Market scheme', () => {
    const none = completeDraft(f, { identifier: null });
    const other = completeDraft(f, { identifier: identifierOf('other-scheme') });
    for (const draft of [none, other]) {
      const result = evaluateSubmission(draft, f.requirements, true);
      if (f.requirements.identifierRequired) {
        expect(result).toEqual({
          ok: false,
          error: { code: 'file.incomplete', missing: ['identifier'] },
        });
      } else {
        // Not required: complete, and a value of another scheme is not carried into the revision.
        expect(result.ok && result.value.identifierIndex).toBeNull();
      }
    }
  });

  it('refuses a missing zone or address as incomplete', () => {
    expect(evaluateSubmission(completeDraft(f, { zone: null }), f.requirements, true)).toEqual({
      ok: false,
      error: { code: 'file.incomplete', missing: ['timezone'] },
    });
    expect(evaluateSubmission(completeDraft(f, { address: null }), f.requirements, true)).toEqual({
      ok: false,
      error: { code: 'file.incomplete', missing: ['address'] },
    });
  });

  it('refuses an address outside every onboarding-enabled area, failing closed on anything but true', () => {
    for (const enabled of [false, null]) {
      expect(evaluateSubmission(completeDraft(f), f.requirements, enabled)).toEqual({
        ok: false,
        error: { code: 'service-area.outside' },
      });
    }
    expect(
      evaluateSubmission(completeDraft(f, { serviceAreaCode: null }), f.requirements, true),
    ).toEqual({ ok: false, error: { code: 'service-area.outside' } });
  });
});

describe.each([
  { marketId: 'AU', maxResultAgeDays: 30 },
  { marketId: 'ZZ', maxResultAgeDays: 3 },
])('registerSnapshotOf in $marketId', ({ maxResultAgeDays: max }) => {
  const by = { kind: 'seller', accountId: ACCOUNT } as const;
  const V = 4;

  it('keeps a current active result with its flags and instant', () => {
    const check = registerCheckAfter(null, 'active', ['postcode'], T0, by, V);
    expect(registerSnapshotOf(check, T0, max, T0, V)).toEqual({
      outcome: 'active',
      mismatches: ['postcode'],
      checkedAt: T0,
    });
  });

  it('writes not-performed, with no instant and no flag, for no result', () => {
    expect(registerSnapshotOf(null, T0, max, T0, V)).toEqual({
      outcome: 'not-performed',
      mismatches: [],
      checkedAt: null,
    });
  });

  it('never writes a clean active for a result compared against another file version', () => {
    const check = registerCheckAfter(null, 'active', [], T0, by, V);
    // Same instant, another version: the edit that instants cannot see.
    expect(registerSnapshotOf(check, T0, max, T0, V + 1)).toEqual({
      outcome: 'not-performed',
      mismatches: [],
      checkedAt: null,
    });
  });

  it('writes not-performed for an aged active result', () => {
    const check = registerCheckAfter(null, 'active', [], T0, by, V);
    const aged = T0.add({ hours: max * 24, seconds: 1 });
    expect(registerSnapshotOf(check, aged, max, T0, V).outcome).toBe('not-performed');
  });

  it('keeps unavailable and a definite negative as they are, whatever the version', () => {
    const unavailable = registerCheckAfter(null, 'unavailable', [], T0, by, V);
    const negative = registerCheckAfter(null, 'not-found', [], T0, by, V);
    expect(registerSnapshotOf(unavailable, T0, max, T0, V + 3)).toEqual({
      outcome: 'unavailable',
      mismatches: [],
      checkedAt: T0,
    });
    expect(registerSnapshotOf(negative, T0, max, T0, V + 3)).toMatchObject({
      outcome: 'not-found',
      mismatches: [],
    });
  });
});

describe.each(FIXTURES)('revision status rules in $marketId', (f) => {
  const pending = (overrides: Partial<NewPendingRevisionInput> = {}) =>
    newPendingRevision({
      id: REVISION,
      sellerId: SELLER,
      kind: 'onboarding',
      revisionNo: 1,
      authorKind: 'seller',
      authorAccountId: ACCOUNT,
      snapshot: {
        operatingTimezone: f.operatingZone,
        serviceAreaCode: f.area,
        addressTimezone: f.addressZone,
        identifierIndex: identifierIndexKeyOf(new Uint8Array(32).fill(3)),
      },
      contentHash: HASH,
      register: { outcome: 'not-performed', mismatches: [], checkedAt: null },
      now: T0,
      ...overrides,
    });

  it('creates a pending revision whose status instant equals its creation instant', () => {
    const revision = pending();
    expect(revision).toMatchObject({
      status: 'pending',
      revisionNo: 1,
      createdAt: T0,
      statusChangedAt: T0,
      decidedAt: null,
      decidedByAccountId: null,
      identityDecisionId: null,
      rejectReasonCode: null,
      withdrawal: null,
      contentSchemaVersion: CONTENT_SCHEMA_VERSION,
      addressTimezone: f.addressZone,
    });
  });

  it('refuses what the table would refuse', () => {
    expect(() => pending({ revisionNo: 0 })).toThrow(RangeError);
    expect(() => pending({ revisionNo: 1.5 })).toThrow(RangeError);
    expect(() => pending({ kind: 'x' as never })).toThrow(TypeError);
    expect(() => pending({ authorKind: 'robot' as never })).toThrow(TypeError);
    expect(() =>
      pending({ register: { outcome: 'not-performed', mismatches: [], checkedAt: T0 } }),
    ).toThrow(TypeError);
    expect(() =>
      pending({ register: { outcome: 'active', mismatches: [], checkedAt: null } }),
    ).toThrow(TypeError);
    expect(() =>
      pending({ register: { outcome: 'unavailable', mismatches: ['postcode'], checkedAt: T0 } }),
    ).toThrow(TypeError);
  });

  it('lists the transitions of design 3.1 and no others', () => {
    const allowed: [RevisionStatus, RevisionStatus][] = [
      ['pending', 'approved'],
      ['pending', 'rejected'],
      ['pending', 'withdrawn'],
      ['approved', 'superseded'],
    ];
    for (const from of REVISION_STATUSES) {
      for (const to of REVISION_STATUSES) {
        expect(canTransition(from, to)).toBe(allowed.some(([a, b]) => a === from && b === to));
      }
    }
  });

  it('withdraws a pending revision with its cause, who caused it and when', () => {
    const later = T0.add({ minutes: 3 });
    const result = withdrawn(pending(), 'edited', 'admin', later);
    expect(result.ok && result.value).toMatchObject({
      status: 'withdrawn',
      statusChangedAt: later,
      createdAt: T0,
      withdrawal: { cause: 'edited', byKind: 'admin', at: later },
    });
  });

  it('refuses to withdraw or supersede anything else', () => {
    const done = withdrawn(pending(), 'cancelled', 'seller', T0);
    expect(done.ok && withdrawn(done.value, 'edited', 'seller', T0)).toEqual({
      ok: false,
      error: { code: 'revision.transition-forbidden' },
    });
    expect(superseded(pending(), T0)).toEqual({
      ok: false,
      error: { code: 'revision.transition-forbidden' },
    });
    expect(() => withdrawn(pending(), 'bored' as never, 'seller', T0)).toThrow(TypeError);
    expect(() => withdrawn(pending(), 'edited', 'robot' as never, T0)).toThrow(TypeError);
  });

  it('supersedes an approved revision and keeps the instant it was decided', () => {
    const decidedAt = T0.add({ hours: 1 });
    const approved = { ...pending(), status: 'approved' as const, decidedAt };
    const later = T0.add({ hours: 2 });
    const result = superseded(approved, later);
    expect(result.ok && result.value).toMatchObject({
      status: 'superseded',
      decidedAt,
      statusChangedAt: later,
    });
  });
});
