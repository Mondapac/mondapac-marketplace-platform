import { ok } from '@mondapac/shared-kernel';
import type { Clock, Id, IdGenerator, MarketContext } from '@mondapac/shared-kernel';
import type { SubjectKeyService } from '../../../platform/subject-keys/subject-key-service';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type {
  ChangeReasonRead,
  ExpertReferenceHolder,
  RegistryCipher,
} from '../application/ports/registry-cipher';
import type { CertificationRegistryRepository } from '../application/ports/registry.repository';
import type { ExpertApproval } from '../domain/issuer';
import { CHANGE_REASON_LABEL, EXPERT_REFERENCE_LABELS } from './certification-labels';

/**
 * {@link RegistryCipher} on the platform `SubjectKeyService` (data design CE7, CE8, 3.22).
 *
 * The Market's platform subject is created on first use, in a read-write unit of its own: the row
 * and its key commit together. Two first uses at once race on the row's key; the loser's unit
 * fails and it reads the winner's subject. The subject's key is never destroyed (an erasure of
 * the platform subject is an open item, design 16). A destroyed platform key, an integrity
 * failure or a bad envelope throws: the expert reference has no erased state.
 */
export class SubjectKeyRegistryCipher implements RegistryCipher {
  constructor(
    private readonly keys: SubjectKeyService,
    private readonly unitOfWork: UnitOfWork,
    private readonly registry: CertificationRegistryRepository,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async sealExpertApproval(
    market: MarketContext,
    holder: ExpertReferenceHolder,
    approval: ExpertApproval,
  ): Promise<string> {
    const subject = await this.platformSubject(market);
    const plain = JSON.stringify({
      confirmedBy: approval.confirmedBy,
      reference: approval.reference,
    });
    const sealed = await this.keys.encrypt(market, subject, EXPERT_REFERENCE_LABELS[holder], plain);
    if (!sealed.ok) throw new Error('certification: the platform subject key was destroyed');
    return sealed.value;
  }

  async openExpertApproval(
    market: MarketContext,
    holder: ExpertReferenceHolder,
    sealed: string,
  ): Promise<ExpertApproval> {
    const subject = await this.platformSubject(market);
    const opened = await this.keys.decrypt(
      market,
      subject,
      EXPERT_REFERENCE_LABELS[holder],
      sealed,
    );
    if (!opened.ok) throw new Error('certification: the platform subject key was destroyed');
    const value: unknown = JSON.parse(opened.value);
    if (
      typeof value !== 'object' ||
      value === null ||
      typeof (value as Record<string, unknown>).confirmedBy !== 'string' ||
      typeof (value as Record<string, unknown>).reference !== 'string'
    ) {
      throw new Error('certification: a stored expert reference has an unknown shape');
    }
    const { confirmedBy, reference } = value as { confirmedBy: string; reference: string };
    return { confirmedBy, reference };
  }

  async sealChangeReason(market: MarketContext, holderId: Id, text: string): Promise<string> {
    await this.keys.createKey(market, holderId);
    const sealed = await this.keys.encrypt(market, holderId, CHANGE_REASON_LABEL, text);
    if (!sealed.ok) throw new Error('certification: a new change-reason key was destroyed');
    return sealed.value;
  }

  async openChangeReason(
    market: MarketContext,
    holderId: Id,
    sealed: string,
  ): Promise<ChangeReasonRead> {
    const opened = await this.keys.decrypt(market, holderId, CHANGE_REASON_LABEL, sealed);
    return opened.ok ? { state: 'given', text: opened.value } : { state: 'erased' };
  }

  private async platformSubject(market: MarketContext): Promise<Id> {
    const read = await this.unitOfWork.run(
      market,
      async () => ok(await this.registry.platformSubject(market)),
      { readOnly: true },
    );
    if (read.ok && read.value !== null) return read.value;
    const subjectId = this.ids.next<'CertificationPlatformSubject'>() as Id;
    try {
      const created = await this.unitOfWork.run<Id, never>(market, async () => {
        const existing = await this.registry.platformSubject(market);
        if (existing !== null) return ok(existing);
        await this.registry.addPlatformSubject(market, subjectId, this.clock.now());
        await this.keys.createKey(market, subjectId);
        return ok(subjectId);
      });
      if (created.ok) return created.value;
    } catch (error) {
      // A concurrent first use committed the row; read it below. Anything else rethrows there.
      const again = await this.unitOfWork.run(
        market,
        async () => ok(await this.registry.platformSubject(market)),
        { readOnly: true },
      );
      if (again.ok && again.value !== null) return again.value;
      throw error;
    }
    throw new Error('certification: the platform subject could not be created');
  }
}
