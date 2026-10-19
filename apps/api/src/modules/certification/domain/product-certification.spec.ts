import { Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import {
  approvalEvent,
  approvalRefusal,
  coverageProblems,
  isProductDraftEditable,
  MAX_COVERED_PRODUCTS,
  parseProductDraft,
  productApprovalBoundary,
  resolveCoverage,
  sameCoverage,
  statusAfterProductDecision,
  statusAfterProductSubmit,
  submitRefusal,
  type CoverageEntry,
  type ProductSubmitInput,
} from './product-certification';
import type { TimeZoneId } from './claim-types';

// The pure rules of a manufacturer certificate (certification design 2.1, 3.4; ADR-0012 d3,
// ADR-0028 d7; AC 20; slice 14). Every case that depends on a zone runs on AU and ZZ.

const id = <K extends string>(s: string): Id<K> => s as Id<K>;
const P1 = id<'Product'>('0197f2a0-0000-7000-8000-000000000001');
const P2 = id<'Product'>('0197f2a0-0000-7000-8000-000000000002');
const R1 = id<'ProductRevision'>('0197f2a0-0000-7000-8000-0000000000a1');
const R2 = id<'ProductRevision'>('0197f2a0-0000-7000-8000-0000000000a2');
const V1 = id<'Variant'>('0197f2a0-0000-7000-8000-0000000000b1');
const V2 = id<'Variant'>('0197f2a0-0000-7000-8000-0000000000b2');
const ISSUER = '0197f2a0-0000-7000-8000-0000000000c1';

const MARKETS = [
  { code: 'AU', zone: 'Australia/Brisbane' as TimeZoneId, boundary: '2027-06-30T14:00:00Z' },
  { code: 'ZZ', zone: 'Asia/Tokyo' as TimeZoneId, boundary: '2027-06-30T15:00:00Z' },
] as const;

const body = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  manufacturerName: '  Maker Pty Ltd ',
  issuerId: ISSUER,
  certificateNumber: 'HC-1234',
  issueDate: '2026-01-01',
  expiryDate: '2027-06-30',
  coverage: [{ productId: P1, variantIds: null }],
  ...over,
});

describe('parseProductDraft', () => {
  it('reads a complete draft, trimming text', () => {
    const parsed = parseProductDraft(body());
    expect(parsed.ok && parsed.value).toEqual({
      manufacturerName: 'Maker Pty Ltd',
      issuerId: ISSUER,
      certificateNumber: 'HC-1234',
      issueDate: Temporal.PlainDate.from('2026-01-01'),
      expiryDate: Temporal.PlainDate.from('2027-06-30'),
      coverage: [{ productId: P1, variantIds: null }],
    });
  });

  it('keeps the stored number when the key is absent and clears it on null', () => {
    const rest: Record<string, unknown> = { ...body() };
    delete rest.certificateNumber;
    const kept = parseProductDraft(rest);
    expect(kept.ok && kept.value.certificateNumber).toBeUndefined();
    const cleared = parseProductDraft(body({ certificateNumber: null }));
    expect(cleared.ok && cleared.value.certificateNumber).toBeNull();
  });

  it('refuses malformed fields by path, never echoing a value', () => {
    const parsed = parseProductDraft(
      body({
        manufacturerName: 'x'.repeat(201),
        issuerId: 'not-an-id',
        certificateNumber: 'a‮b',
        issueDate: '2027-07-01',
        expiryDate: '2027-06-30',
        coverage: 'all',
      }),
    );
    expect(!parsed.ok && parsed.error.map((f) => `${f.path}:${f.code}`).sort()).toEqual(
      [
        'certificateNumber:invalid-character',
        'coverage:type',
        'expiryDate:before-issue-date',
        'issuerId:format',
        'manufacturerName:too-long',
      ].sort(),
    );
  });

  it('refuses a duplicate product, an empty or repeated variant list and too many products', () => {
    const dup = parseProductDraft(
      body({
        coverage: [
          { productId: P1, variantIds: null },
          { productId: P1, variantIds: [V1] },
        ],
      }),
    );
    expect(!dup.ok && dup.error).toEqual([{ path: 'coverage[1].productId', code: 'duplicate' }]);
    const empty = parseProductDraft(body({ coverage: [{ productId: P1, variantIds: [] }] }));
    expect(!empty.ok && empty.error).toEqual([{ path: 'coverage[0].variantIds', code: 'length' }]);
    const repeated = parseProductDraft(
      body({ coverage: [{ productId: P1, variantIds: [V1, V1] }] }),
    );
    expect(!repeated.ok && repeated.error).toEqual([
      { path: 'coverage[0].variantIds[1]', code: 'duplicate' },
    ]);
    const many = parseProductDraft(
      body({
        coverage: Array.from({ length: MAX_COVERED_PRODUCTS + 1 }, (_, i) => ({
          productId: `0197f2a0-0000-7000-8000-${String(i).padStart(12, '0')}`,
          variantIds: null,
        })),
      }),
    );
    expect(!many.ok && many.error).toEqual([{ path: 'coverage', code: 'length' }]);
  });

  it('refuses unknown keys on a coverage entry and a body that is not an object', () => {
    const extra = parseProductDraft(
      body({ coverage: [{ productId: P1, variantIds: null, productRevisionId: R1 }] }),
    );
    // The product revision is never taken from the client (M3): it is read from catalog.
    expect(!extra.ok && extra.error).toEqual([{ path: 'coverage[0]', code: 'unknown-key' }]);
    expect(parseProductDraft(null).ok).toBe(false);
    expect(parseProductDraft([]).ok).toBe(false);
  });
});

describe('resolveCoverage (M3: the published product revision from catalog)', () => {
  const published = new Map([
    [P1, R1],
    [P2, R2],
  ]);
  const variants = new Map([
    [P1, new Set([V1, V2])],
    [P2, new Set<Id<'Variant'>>()],
  ]);

  it('records each product at its current published revision, whole or narrowed', () => {
    const resolved = resolveCoverage(
      [
        { productId: P1, variantIds: [V2, V1] },
        { productId: P2, variantIds: null },
      ],
      published,
      variants,
    );
    expect(resolved.ok && resolved.value).toEqual([
      { productId: P1, productRevisionId: R1, variantId: V2 },
      { productId: P1, productRevisionId: R1, variantId: V1 },
      { productId: P2, productRevisionId: R2, variantId: null },
    ]);
  });

  it('refuses a product with no published revision and a variant not on it', () => {
    const unknownProduct = id<'Product'>('0197f2a0-0000-7000-8000-000000000009');
    const resolved = resolveCoverage(
      [
        { productId: unknownProduct, variantIds: null },
        { productId: P1, variantIds: [id<'Variant'>('0197f2a0-0000-7000-8000-0000000000bf')] },
      ],
      published,
      variants,
    );
    expect(!resolved.ok && resolved.error).toEqual([
      { path: 'coverage[0].productId', code: 'product-unknown' },
      { path: 'coverage[1].variantIds[0]', code: 'variant-unknown' },
    ]);
  });
});

describe('coverageProblems (the aggregate invariants of 2.1)', () => {
  const whole: CoverageEntry = { productId: P1, productRevisionId: R1, variantId: null };
  it('accepts whole-product and variant entries of different products', () => {
    expect(
      coverageProblems([whole, { productId: P2, productRevisionId: R2, variantId: V1 }]),
    ).toEqual([]);
  });
  it('refuses an empty list: brand alone is not coverage', () => {
    expect(coverageProblems([])).toEqual(['coverage-empty']);
  });
  it('refuses whole and variant entries for one product (Q-C7) and two revisions of one product', () => {
    expect(coverageProblems([whole, { ...whole, variantId: V1 }])).toEqual(['coverage-mixed']);
    expect(coverageProblems([whole, { ...whole, productRevisionId: R2 }])).toEqual([
      'coverage-mixed',
    ]);
    expect(coverageProblems([whole, whole])).toEqual(['coverage-duplicate']);
  });
});

describe('sameCoverage and approvalEvent', () => {
  const a: CoverageEntry = { productId: P1, productRevisionId: R1, variantId: null };
  const b: CoverageEntry = { productId: P2, productRevisionId: R2, variantId: V1 };
  it('compares as sets', () => {
    expect(sameCoverage([a, b], [b, a])).toBe(true);
    expect(sameCoverage([a], [a, b])).toBe(false);
    expect(sameCoverage([a], [{ ...a, productRevisionId: R2 }])).toBe(false);
  });
  it('is approved for a first approval or a renewal, coverage-changed when coverage moved (T3)', () => {
    expect(approvalEvent(null, [a])).toBe('approved');
    expect(approvalEvent([a], [a])).toBe('approved');
    expect(approvalEvent([a], [a, b])).toBe('coverage-changed');
  });
});

describe('the record status (design 3.4)', () => {
  it('is editable without a pending revision unless terminal', () => {
    for (const status of ['draft', 'approved', 'expired', 'suspended'] as const) {
      expect(isProductDraftEditable(status, null)).toBe(true);
      expect(isProductDraftEditable(status, 'pending')).toBe(false);
    }
    for (const status of ['rejected', 'revoked', 'in-review'] as const) {
      expect(isProductDraftEditable(status, null)).toBe(false);
    }
  });
  it('moves draft to in-review at submission and keeps an approved record approved (T3)', () => {
    expect(statusAfterProductSubmit('draft')).toBe('in-review');
    expect(statusAfterProductSubmit('approved')).toBe('approved');
    expect(statusAfterProductSubmit('suspended')).toBe('suspended');
    expect(statusAfterProductSubmit('expired')).toBe('expired');
  });
  it('approves to approved; a rejection ends a never-approved record only', () => {
    expect(statusAfterProductDecision('in-review', false, 'approved')).toBe('approved');
    expect(statusAfterProductDecision('expired', true, 'approved')).toBe('approved');
    expect(statusAfterProductDecision('suspended', true, 'approved')).toBe('approved');
    expect(statusAfterProductDecision('in-review', false, 'rejected')).toBe('rejected');
    expect(statusAfterProductDecision('approved', true, 'rejected')).toBe('approved');
    expect(statusAfterProductDecision('expired', true, 'rejected')).toBe('expired');
  });
});

describe.each(MARKETS)('Market $code', ({ zone, boundary }) => {
  const now = Temporal.Instant.from('2027-01-01T00:00:00Z');

  it('stores the boundary of the expiry date in the Market zone (2.4 rule 3)', () => {
    expect(productApprovalBoundary(Temporal.PlainDate.from('2027-06-30'), zone)).toEqual({
      at: Temporal.Instant.from(boundary),
      zone,
    });
    expect(productApprovalBoundary(null, zone)).toEqual({ at: null, zone: null });
  });

  const submit = (over: Partial<ProductSubmitInput> = {}): ProductSubmitInput => ({
    draft: {
      manufacturerName: 'Maker',
      issuerId: id('i1'),
      certificateNumberSet: true,
      issueDate: Temporal.PlainDate.from('2026-01-01'),
      expiryDate: Temporal.PlainDate.from('2027-06-30'),
      coverage: [{ productId: P1, productRevisionId: R1, variantId: null }],
    },
    type: {
      status: 'active',
      verificationMode: 'THIRD_PARTY_DOCUMENT',
      requiresIssuerRegistry: true,
      requiresDocument: false,
      requiresExpiry: true,
    },
    issuer: { state: 'active', typeMatches: true },
    hasApproval: false,
    documentCount: 0,
    marketZone: zone,
    now,
    ...over,
  });

  it('accepts a complete draft', () => {
    expect(submitRefusal(submit())).toBeNull();
  });

  it('refuses a self-declaration type: no manufacturer basis (CERT-40)', () => {
    expect(
      submitRefusal(submit({ type: { ...submit().type, verificationMode: 'SELF_DECLARATION' } })),
    ).toEqual({ code: 'type.manufacturer-basis-not-allowed' });
  });

  it('refuses an inactive type for a new record only (CERT-03)', () => {
    const inactive = { ...submit().type, status: 'inactive' as const };
    expect(submitRefusal(submit({ type: inactive }))).toEqual({ code: 'type.inactive' });
    expect(submitRefusal(submit({ type: inactive, hasApproval: true }))).toBeNull();
  });

  it('names every missing field', () => {
    const refusal = submitRefusal(
      submit({
        draft: {
          manufacturerName: null,
          issuerId: null,
          certificateNumberSet: false,
          issueDate: null,
          expiryDate: null,
          coverage: [],
        },
        type: { ...submit().type, requiresDocument: true },
      }),
    );
    expect(refusal).toEqual({
      code: 'certificate.incomplete',
      fields: [
        { path: 'manufacturerName', code: 'required' },
        { path: 'issuerId', code: 'required' },
        { path: 'certificateNumber', code: 'required' },
        { path: 'expiryDate', code: 'required' },
        { path: 'documents', code: 'required' },
        { path: 'coverage', code: 'coverage-empty' },
      ],
    });
  });

  it('refuses an issuer that is not active or of another type', () => {
    for (const issuer of [
      { state: 'proposed' as const, typeMatches: true },
      { state: 'closed-to-new' as const, typeMatches: true },
      { state: 'derecognised' as const, typeMatches: true },
      { state: 'active' as const, typeMatches: false },
      null,
    ]) {
      expect(submitRefusal(submit({ issuer }))).toEqual({ code: 'issuer.not-active' });
    }
  });

  it('refuses a boundary at or before now, exactly at the instant', () => {
    expect(submitRefusal(submit({ now: Temporal.Instant.from(boundary) }))).toEqual({
      code: 'certificate.expired',
    });
    expect(
      submitRefusal(submit({ now: Temporal.Instant.from(boundary).subtract({ seconds: 1 }) })),
    ).toBeNull();
  });

  describe('approvalRefusal (another person; AC 20)', () => {
    const input = (over: Partial<Parameters<typeof approvalRefusal>[0]> = {}) => ({
      actorAccountId: 'reviewer',
      authorAccountId: 'author',
      editorAccountIds: ['editor-1', 'editor-2'],
      status: 'in-review' as const,
      issuer: { state: 'active' as const, typeMatches: true },
      typeActive: true,
      hasApproval: false,
      boundary: Temporal.Instant.from(boundary),
      now,
      missingChecks: [] as readonly string[],
      documentMissing: false,
      ...over,
    });

    it('allows another person', () => {
      expect(approvalRefusal(input())).toBeNull();
    });

    it('refuses the creator and every admin who edited the revision', () => {
      for (const actor of ['author', 'editor-1', 'editor-2']) {
        expect(approvalRefusal(input({ actorAccountId: actor }))).toEqual({
          code: 'approval.same-admin',
        });
      }
    });

    it('refuses a terminal record, an inactive issuer and a passed boundary', () => {
      expect(approvalRefusal(input({ status: 'rejected' }))).toEqual({
        code: 'certificate.closed',
      });
      expect(approvalRefusal(input({ status: 'revoked' }))).toEqual({
        code: 'certificate.closed',
      });
      expect(
        approvalRefusal(input({ issuer: { state: 'derecognised', typeMatches: true } })),
      ).toEqual({ code: 'issuer.not-active' });
      expect(approvalRefusal(input({ now: Temporal.Instant.from(boundary) }))).toEqual({
        code: 'certificate.expired',
      });
      expect(approvalRefusal(input({ typeActive: false }))).toEqual({ code: 'type.inactive' });
      expect(approvalRefusal(input({ typeActive: false, hasApproval: true }))).toBeNull();
    });

    it('refuses a revision without its required document or with a required check open', () => {
      expect(approvalRefusal(input({ documentMissing: true }))).toEqual({
        code: 'certificate.incomplete',
      });
      expect(approvalRefusal(input({ missingChecks: ['seal-read', 'validity-read'] }))).toEqual({
        code: 'review.checks-incomplete',
        checks: ['seal-read', 'validity-read'],
      });
      // Another person comes first: an editor learns nothing about the checks.
      expect(
        approvalRefusal(input({ actorAccountId: 'editor-1', missingChecks: ['seal-read'] })),
      ).toEqual({ code: 'approval.same-admin' });
    });
  });
});
