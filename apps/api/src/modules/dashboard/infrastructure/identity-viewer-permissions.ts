import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import type { IdentityFacade } from '../../identity';
import type { DashboardViewer, ViewerPermissions } from '../application/ports/viewer-permissions';

/**
 * {@link ViewerPermissions} through `identity.describeActor` (rule `own-resources`), with the
 * caller's context unchanged. A thrown read is `access.unavailable`: the work queue then fails as
 * a whole (503) rather than guessing a permission set.
 */
export class IdentityViewerPermissions implements ViewerPermissions {
  constructor(private readonly identity: Pick<IdentityFacade, 'describeActor'>) {}

  async describe(context: CallContext): Promise<Result<DashboardViewer, AccessDenied>> {
    try {
      const described = await this.identity.describeActor(context);
      if (!described.ok) return err(described.error);
      const { population, sellerId, permissionKeys } = described.value;
      return ok({ population, sellerId, permissionKeys: [...permissionKeys] });
    } catch {
      return err({ code: 'access.unavailable' });
    }
  }
}
