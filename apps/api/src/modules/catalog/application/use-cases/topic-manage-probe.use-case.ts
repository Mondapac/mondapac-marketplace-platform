import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CATALOG_TOPIC_MANAGE } from '../../contracts/permissions';

/**
 * `catalog.topic-manage-probe`: asks the gate whether the caller holds the key `catalog.topic.manage`. It reads
 * and writes nothing. The lists call it to name the row actions the caller may run (the
 * row Actions menu); `access.denied` means "no". The action itself checks its key again when it
 * runs.
 */
export class TopicManageProbe extends UseCase<
  Record<string, never>,
  { readonly held: true },
  { readonly code: 'access.denied' }
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.topic-manage-probe',
    rule: { kind: 'permissions', allOf: [CATALOG_TOPIC_MANAGE.key] },
  };

  constructor(gate: UseCaseGate) {
    super(gate);
  }

  protected handle(
    context: CallContext,
  ): Promise<Result<{ readonly held: true }, { readonly code: 'access.denied' }>> {
    void context;
    return Promise.resolve(ok({ held: true }));
  }
}
