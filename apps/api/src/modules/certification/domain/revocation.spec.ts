import { Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import type { ReviewPolicy } from './review';
import { revocationReason, revocationRefusal, REVOCABLE_STATUSES } from './revocation';
import { sellerStatusOf } from './seller-certificate';
import {
  sellerCertificateValidAt,
  type SellerCertificationStatus,
  type SellerCertificationView,
} from './validity';

// The pure rules of revoking a seller certificate (certification design 3.1 last row, 7.3; brief
// CERT-16, AC 16), on two policies shaped like the two Market fixtures (AU-like and ZZ-like codes).

const POLICIES: Record<'AU' | 'ZZ', ReviewPolicy> = {
  AU: {
    checks: [{ code: 'issuer', required: true, modes: ['THIRD_PARTY_DOCUMENT'] }],
    reasons: [
      {
        code: 'approved-in-error',
        check: null,
        nextStep: 'contact-support',
        label: 'The certificate was approved in error.',
        outcomes: ['revoked'],
      },
      {
        code: 'signs-of-tampering',
        check: 'issuer',
        nextStep: 'contact-support',
        label: 'Altered.',
        outcomes: ['declined', 'revoked'],
      },
      {
        code: 'unreadable',
        check: null,
        nextStep: 'upload-clearer-file',
        label: 'Unreadable.',
        outcomes: ['changes-requested'],
      },
    ],
    issuerRequestReasons: [],
  },
  ZZ: {
    checks: [],
    reasons: [
      {
        code: 'body-withdrew',
        check: null,
        nextStep: 'ask-support',
        label: 'The body withdrew it.',
        outcomes: ['revoked'],
      },
      {
        code: 'forged',
        check: null,
        nextStep: 'ask-support',
        label: 'Forged.',
        outcomes: ['declined'],
      },
    ],
    issuerRequestReasons: [],
  },
};

const REVOKE_CODE = { AU: 'approved-in-error', ZZ: 'body-withdrew' } as const;
const DECLINE_ONLY = { AU: 'unreadable', ZZ: 'forged' } as const;

describe.each(['AU', 'ZZ'] as const)('revoking a seller certificate, policy %s', (market) => {
  const policy = POLICIES[market];

  describe('which records can be revoked (design 3.1)', () => {
    it('allows only an approved or expired record that holds an approved submission', () => {
      expect(REVOCABLE_STATUSES).toEqual(['approved', 'expired']);
      expect(revocationRefusal({ status: 'approved', hasApproval: true })).toBeNull();
      expect(revocationRefusal({ status: 'expired', hasApproval: true })).toBeNull();
    });

    it.each<SellerCertificationStatus>(['draft', 'in-review', 'changes-needed', 'declined'])(
      'refuses a %s record',
      (status) => {
        expect(revocationRefusal({ status, hasApproval: false })).toEqual({
          code: 'certificate.not-revocable',
        });
      },
    );

    it('refuses a record that is already revoked (terminal; no transition out of it)', () => {
      expect(revocationRefusal({ status: 'revoked', hasApproval: true })).toEqual({
        code: 'certificate.revoked',
      });
    });

    it('refuses an approved status without an approved submission (fail closed)', () => {
      expect(revocationRefusal({ status: 'approved', hasApproval: false })).toEqual({
        code: 'certificate.not-revocable',
      });
    });
  });

  describe('the reason (AC 16: no revoke without a reason)', () => {
    it("accepts a code of the Market's list that is listed for revoke", () => {
      expect(revocationReason(policy, REVOKE_CODE[market])).toMatchObject({
        ok: true,
        value: { code: REVOKE_CODE[market] },
      });
    });

    it('refuses a missing, empty or non-string reason as required', () => {
      for (const raw of [undefined, null, '', 7, {}]) {
        expect(revocationReason(policy, raw)).toEqual({ ok: false, code: 'required' });
      }
    });

    it('refuses a code listed only for another outcome, an unknown code and the other policy codes', () => {
      expect(revocationReason(policy, DECLINE_ONLY[market])).toEqual({
        ok: false,
        code: 'unknown',
      });
      expect(revocationReason(policy, 'no-such-reason')).toEqual({ ok: false, code: 'unknown' });
      const other = market === 'AU' ? 'ZZ' : 'AU';
      expect(revocationReason(policy, REVOKE_CODE[other])).toEqual({
        ok: false,
        code: 'unknown',
      });
    });
  });

  describe('effect (design 2.4 rule 1; brief s4 "effect like expiry")', () => {
    const now = Temporal.Instant.from('2026-10-17T00:00:00Z');
    const view = (status: SellerCertificationStatus): SellerCertificationView => ({
      certificateId: 'c' as Id,
      status,
      approved: {
        submissionId: 's' as Id,
        typeRevisionId: 'r' as Id,
        verificationMode: 'THIRD_PARTY_DOCUMENT',
        requiresExpiry: true,
        expiryDate: Temporal.PlainDate.from('2028-01-01'),
        zoneAtApproval: 'Australia/Brisbane' as never,
        issuerId: 'i' as Id,
        issuerState: 'active',
        issuerDisplayName: 'Authority',
        verifiedWithIssuer: true,
      },
    });

    it('is not valid at once, though the approved submission is still within its dates', () => {
      expect(sellerCertificateValidAt(view('approved'), zonesFor(), now).valid).toBe(true);
      expect(sellerCertificateValidAt(view('revoked'), zonesFor(), now)).toEqual({
        valid: false,
        reason: 'not-approved',
      });
    });

    it('shows the seller the revoked code, never an approved one', () => {
      expect(
        sellerStatusOf(
          {
            status: 'revoked',
            pendingKind: null,
            approvedBoundaryAt: Temporal.Instant.from('2028-01-01T14:00:00Z'),
            hasApproval: true,
            approvedIssuerState: 'active',
            issuerRequestOpen: false,
            latestOutcome: 'withdrawn',
          },
          now,
        ),
      ).toEqual({ code: 'revoked', submitBy: null });
    });
  });
});

function zonesFor() {
  return { zone: 'Australia/Brisbane', addressZone: 'Australia/Brisbane' } as never;
}
