/** The team list as `GET identity/seller/team` answers (SellerTeamPageView); instants are ISO strings. */
export const TEAM_VIEW_PERMISSION = 'identity.team-member.view';
export const TEAM_INVITE_PERMISSION = 'identity.team-member.invite';
export const TEAM_ASSIGN_PERMISSION = 'identity.team-member.assign-role';
export const ROLE_VIEW_PERMISSION = 'identity.seller-role.view';

export interface ActionHint {
  readonly allowed: boolean;
  readonly code: string | null;
}

export interface TeamRole {
  readonly roleId: string;
  readonly kind: 'system' | 'default' | 'custom';
  readonly seedCode: string | null;
}

export interface MemberRow {
  readonly type: 'account';
  readonly accountId: string;
  readonly email: string;
  readonly displayName: string | null;
  readonly self: boolean;
  readonly role: TeamRole | null;
  readonly actions: { readonly changeRole: ActionHint; readonly remove: ActionHint };
}

export interface InvitationRow {
  readonly type: 'invitation';
  readonly invitationId: string;
  readonly email: string;
  readonly role: TeamRole | null;
  readonly invitedByAccountId: string | null;
  readonly status: 'pending' | 'expired';
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly actions: { readonly resend: ActionHint; readonly revoke: ActionHint };
}

export type TeamRow = MemberRow | InvitationRow;

export interface TeamPage {
  readonly items: readonly TeamRow[];
  readonly next: string | null;
}

/** One entry of `GET identity/seller/roles`. `grantable` is a hint; the commands check again. */
export interface SellerRole {
  readonly roleId: string;
  readonly kind: 'system' | 'default' | 'custom';
  readonly seedCode: string | null;
  /** The name of a custom role; null for a seeded one. */
  readonly name: string | null;
  readonly permissionCount: number;
  readonly grantable: boolean;
}
