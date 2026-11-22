import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../../platform/authz';

/** Who is looking at the dashboard, as identity describes the caller (`describeActor`). */
export interface DashboardViewer {
  readonly population: 'customer' | 'seller' | 'admin';
  readonly sellerId: string | null;
  /** The seller's access state (seller panel; null for an admin): part of the cache key. */
  readonly sellerAccessState: string | null;
  readonly permissionKeys: readonly string[];
}

/**
 * The caller's own permission set, read through identity's facade with the caller's context
 * unchanged. The dashboard uses it only to choose which queues to ask and to key its cache;
 * every owner checks its own rule again.
 */
export interface ViewerPermissions {
  describe(context: CallContext): Promise<Result<DashboardViewer, AccessDenied>>;
}

export const VIEWER_PERMISSIONS = Symbol('VIEWER_PERMISSIONS');
