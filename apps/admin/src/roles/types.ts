/** One role of `GET identity/admin/roles` (RoleView). A custom role's name is personal data. */
export interface RoleHint {
  readonly allowed: boolean;
  readonly code: string | null;
}

export interface RoleRecord {
  readonly roleId: string;
  readonly kind: 'system' | 'default' | 'custom';
  readonly seedCode: string | null;
  readonly name: string | null;
  readonly permissionCount: number;
  readonly permissionKeys: readonly string[];
  readonly grantable: boolean;
  readonly version: number;
  readonly actions: { readonly edit: RoleHint; readonly delete: RoleHint };
}

export interface RoleCatalogue {
  /** Whether an edit of a custom role is reviewed (then a note is required). */
  readonly review?: { readonly reviewed: boolean; readonly risk: 'low' | 'medium' | 'high' };
  readonly items: readonly RoleRecord[];
  readonly keys: readonly {
    readonly key: string;
    readonly protected: boolean;
    readonly grantable: boolean;
  }[];
}
