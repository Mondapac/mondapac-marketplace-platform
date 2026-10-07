// What a module may use from `platform/authz` (identity design 5.2; security review of slice
// 1c, M1). A module imports from this file only (dependency-cruiser
// `modules-reach-authz-through-its-barrel`): the base class, the declaration types, the
// permission helpers, the answers and the gate's token and type. The gate's factory, the
// AuthorisationCheck port and the declaration checks stay inside `platform/`.
export type { AccessDenied } from './access-denied';
export type {
  AccessDeclaration,
  AccessRule,
  PermissionKey,
  WhenSellerNotApproved,
} from './access-rule';
export {
  declarePermissions,
  definePermission,
  type PermissionCatalogue,
  type PermissionDeclaration,
  type PermissionScope,
} from './permission';
export { UseCase, UseCaseDefinitionError } from './use-case';
export type { UseCaseGate } from './use-case-gate';
export { USE_CASE_GATE } from './use-case-gate.token';
