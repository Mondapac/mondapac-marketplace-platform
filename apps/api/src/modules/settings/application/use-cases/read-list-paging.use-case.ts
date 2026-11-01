import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { LIST_PAGING_CODE, type ListPaging } from '../../domain/definitions';
import type { SettingsDependencies } from '../settings-dependencies';
import { readSettingValue } from '../settings-flow';

/**
 * `settings.read-list-paging`: how every list in the panels pages (page numbers, or Previous and
 * Next). Any signed-in panel user reads it; an unreadable store answers Previous and Next.
 */
export class ReadListPaging extends UseCase<Record<string, never>, ListPaging, never> {
  static override readonly access: AccessDeclaration = {
    name: 'settings.read-list-paging',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'allow',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SettingsDependencies,
  ) {
    super(gate);
  }

  protected async handle(context: CallContext): Promise<Result<ListPaging, never>> {
    const value = await readSettingValue(this.deps, context, LIST_PAGING_CODE);
    return ok(value === 'pages' ? 'pages' : 'prev-next');
  }
}
