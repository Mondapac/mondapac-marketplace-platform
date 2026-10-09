import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketId } from '@mondapac/shared-kernel';
import { BusinessFileSubmitted, BusinessFileWithdrawn } from './events';
import { SellerFile } from './seller-file';
import type { ShopSlug } from './shop-slug';

// Recording a submission or a withdrawal on the file (sellers design 3.1, 7.4; slice 5b): the file
// version rises once per unit and the event carries that version, so the outbox key
// (aggregate id, aggregate version) is never taken twice. Run for both Market fixtures.

const T0 = Temporal.Instant.from('2026-10-08T00:00:00Z');
const T1 = T0.add({ minutes: 5 });
const SELLER = '01928a3c-0000-7000-8000-000000000001' as Id<'Seller'>;
const REVISION = '01928a3c-0000-7000-8000-0000000000b1' as Id<'BusinessFileRevision'>;

describe.each(['AU', 'ZZ'] as const)(
  'the submission and withdrawal records of a file in %s',
  (code) => {
    const marketId = code as MarketId;
    const fileAt = (version: number, hasApprovedRevision = false): SellerFile => {
      const created = SellerFile.create({
        sellerId: SELLER,
        marketId,
        origin: 'self',
        approvalRequiredAtRegistration: true,
        now: T0,
      });
      return SellerFile.restore({ ...created.state, version, hasApprovedRevision });
    };
    const submission = {
      revisionId: REVISION,
      kind: 'onboarding',
      authorKind: 'seller',
      resubmission: false,
    } as const;

    it('raises the version once and records the submission event at that version', () => {
      const file = fileAt(4);

      expect(file.recordSubmission(submission, T1)).toEqual({ ok: true, value: undefined });

      expect(file.persistedVersion).toBe(4);
      expect(file.state.version).toBe(5);
      expect(file.state.lastChangedAt).toEqual(T1);
      expect(file.pendingEvents).toEqual([
        expect.objectContaining({
          type: BusinessFileSubmitted.type,
          aggregateType: 'seller-file',
          aggregateId: SELLER,
          aggregateVersion: 5,
          occurredAt: T1,
          payload: {
            sellerId: SELLER,
            revisionId: REVISION,
            kind: 'onboarding',
            authorKind: 'seller',
            resubmission: false,
          },
        }),
      ]);
    });

    it('carries the resubmission flag and the author kind into the event', () => {
      const file = fileAt(3);

      file.recordSubmission({ ...submission, authorKind: 'admin', resubmission: true }, T1);

      expect(file.pendingEvents[0]!.payload).toMatchObject({
        authorKind: 'admin',
        resubmission: true,
      });
    });

    it('refuses an onboarding submission on a file with an approved revision, and records nothing', () => {
      const file = fileAt(4, true);

      expect(file.recordSubmission(submission, T1)).toEqual({
        ok: false,
        error: { code: 'file.change-request-required' },
      });
      expect(file.state.version).toBe(4);
      expect(file.pendingEvents).toEqual([]);
    });

    it('records a withdrawal after an edit at the version the edit already raised', () => {
      const file = fileAt(4);
      file.saveSlug('al-noor' as ShopSlug, T1, {
        identifierRequired: false,
        identifierScheme: 'x',
      });
      expect(file.state.version).toBe(5);

      file.recordWithdrawal({ revisionId: REVISION, cause: 'edited', byKind: 'seller' }, T1);

      expect(file.state.version).toBe(5);
      expect(file.pendingEvents).toEqual([
        expect.objectContaining({
          type: BusinessFileWithdrawn.type,
          aggregateVersion: 5,
          payload: { sellerId: SELLER, revisionId: REVISION, cause: 'edited', byKind: 'seller' },
        }),
      ]);
    });

    it('raises the version for a withdrawal that edits nothing', () => {
      const file = fileAt(4);

      file.recordWithdrawal({ revisionId: REVISION, cause: 'cancelled', byKind: 'seller' }, T1);

      expect(file.state.version).toBe(5);
      expect(file.persistedVersion).toBe(4);
      expect(file.state.lastChangedAt).toEqual(T1);
      expect(file.pendingEvents[0]!.aggregateVersion).toBe(5);
    });

    it('refuses a cause or a kind outside the closed lists (programmer error)', () => {
      const file = fileAt(4);

      expect(() =>
        file.recordWithdrawal(
          { revisionId: REVISION, cause: 'because' as never, byKind: 'seller' },
          T1,
        ),
      ).toThrow(TypeError);
      expect(() =>
        file.recordWithdrawal(
          { revisionId: REVISION, cause: 'edited', byKind: 'staff' as never },
          T1,
        ),
      ).toThrow(TypeError);
      expect(() => file.recordSubmission({ ...submission, kind: 'other' as never }, T1)).toThrow(
        TypeError,
      );
    });
  },
);
