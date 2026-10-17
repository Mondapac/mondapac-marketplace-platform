import type { Id } from '@mondapac/shared-kernel';
import {
  answerRefusal,
  issuerRequestTypeRefusal,
  MAX_TYPED_ISSUER_NAME_LENGTH,
  parseTypedIssuerName,
  type IssuerRequestState,
} from './issuer-request';
import type { TypeSettings } from './seller-certificate';

const TYPE = '01990000-0000-7000-8000-00000000c101' as Id<'CertificationType'>;
const OTHER_TYPE = '01990000-0000-7000-8000-00000000c102' as Id<'CertificationType'>;
const ISSUER = '01990000-0000-7000-8000-00000000d101' as Id<'Issuer'>;

const type = (over: Partial<TypeSettings> = {}): TypeSettings => ({
  typeId: TYPE,
  code: 'halal',
  status: 'active',
  revisionId: '01990000-0000-7000-8000-00000000c201' as Id<'CertificationTypeRevision'>,
  verificationMode: 'THIRD_PARTY_DOCUMENT',
  requiresIssuerRegistry: true,
  requiresDocument: true,
  requiresExpiry: true,
  ...over,
});

describe('the typed issuer name (brief s4 a 3)', () => {
  it('keeps the trimmed text of 1 to 200 characters', () => {
    expect(parseTypedIssuerName('  Halal Council of Somewhere  ')).toEqual({
      ok: true,
      value: 'Halal Council of Somewhere',
    });
    expect(parseTypedIssuerName('ع'.repeat(MAX_TYPED_ISSUER_NAME_LENGTH)).ok).toBe(true);
  });

  it.each([
    [undefined, 'required'],
    [null, 'required'],
    ['   ', 'required'],
    [42, 'type'],
    ['x'.repeat(MAX_TYPED_ISSUER_NAME_LENGTH + 1), 'too-long'],
    ['Name\u0000with control', 'invalid-character'],
    ['Name‮with bidi override', 'invalid-character'],
  ])('refuses %p as %s', (value, code) => {
    expect(parseTypedIssuerName(value)).toEqual({ ok: false, error: { code } });
  });
});

describe('which types take a request', () => {
  it('takes an active registry type only', () => {
    expect(issuerRequestTypeRefusal(type())).toBeNull();
    expect(issuerRequestTypeRefusal(type({ status: 'inactive' }))).toEqual({
      code: 'type.inactive',
    });
    expect(
      issuerRequestTypeRefusal(
        type({ verificationMode: 'SELF_DECLARATION', requiresIssuerRegistry: false }),
      ),
    ).toEqual({ code: 'type.no-issuer-registry' });
  });
});

describe('the answer guard (design 2.1, 3.5)', () => {
  const reasonCodes = ['issuer-not-recognised', 'issuer-not-identified'];
  const guard = (
    state: IssuerRequestState,
    answer: Parameters<typeof answerRefusal>[0]['answer'],
    issuer: Parameters<typeof answerRefusal>[0]['issuer'] = null,
  ) => answerRefusal({ state, typeId: TYPE, answer, issuer, reasonCodes });

  it('answers an open request with an active issuer of its own type', () => {
    expect(
      guard(
        'open',
        { outcome: 'issuer-added', issuerId: ISSUER },
        { typeId: TYPE, state: 'active' },
      ),
    ).toBeNull();
  });

  it('answers an open request as not accepted with a reason code of the Market', () => {
    expect(guard('open', { outcome: 'not-accepted', reasonCode: 'issuer-not-identified' })).toBe(
      null,
    );
    expect(guard('open', { outcome: 'not-accepted', reasonCode: 'seal-blurred' })).toEqual({
      code: 'issuer-request.reason-unknown',
    });
  });

  it.each(['issuer-added', 'not-accepted'] as const)(
    'never answers a %s request again',
    (state) => {
      expect(
        guard(
          state,
          { outcome: 'issuer-added', issuerId: ISSUER },
          { typeId: TYPE, state: 'active' },
        ),
      ).toEqual({ code: 'issuer-request.already-answered' });
      expect(
        guard(state, { outcome: 'not-accepted', reasonCode: 'issuer-not-identified' }),
      ).toEqual({ code: 'issuer-request.already-answered' });
    },
  );

  it('refuses an unknown issuer and an issuer of another type alike', () => {
    const added = { outcome: 'issuer-added', issuerId: ISSUER } as const;
    expect(guard('open', added, null)).toEqual({ code: 'issuer.not-found' });
    expect(guard('open', added, { typeId: OTHER_TYPE, state: 'active' })).toEqual({
      code: 'issuer.not-found',
    });
  });

  it.each(['proposed', 'closed-to-new', 'derecognised'] as const)(
    'refuses an issuer in state %s: the seller could not choose it',
    (state) => {
      expect(
        guard('open', { outcome: 'issuer-added', issuerId: ISSUER }, { typeId: TYPE, state }),
      ).toEqual({ code: 'issuer.not-active' });
    },
  );
});
