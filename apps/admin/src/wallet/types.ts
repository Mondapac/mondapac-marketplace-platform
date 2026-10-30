// Answers of the wallet admin routes (apps/api wallet presentation). Amounts are minor-unit digit
// strings, always with the currency they are in; ids and instants only.

export const SETTINGS_VIEW = 'wallet.settings.view';
export const SETTINGS_MANAGE = 'wallet.settings.manage';
export const CREDIT_VIEW = 'wallet.credit.view';
export const CREDIT_ISSUE = 'wallet.credit.issue';
export const CREDIT_APPROVE = 'wallet.credit.approve';

export const WALLET_STATES = ['off', 'active', 'paused', 'frozen'] as const;
export type WalletState = (typeof WALLET_STATES)[number];
/** States that carry a reason (the API refuses a reason on the others). */
export const REASON_STATES: readonly WalletState[] = ['paused', 'frozen'];
export const STATUS_REASONS = [
  'wind-down',
  'security-incident',
  'fraud-suspected',
  'legal-hold',
  'maintenance',
  'owner-decision',
] as const;

export const CREDIT_REASONS = ['goodwill', 'service-recovery', 'promotion', 'correction'] as const;
export const REJECT_REASONS = [
  'not-justified',
  'amount-too-high',
  'duplicate',
  'wrong-customer',
  'policy',
] as const;
export const NOTE_MAX = 500;
export const PAGE_SIZE = 20;

export interface WalletSettings {
  readonly status: WalletState;
  readonly reason: string | null;
  readonly updatedAt: string | null;
  /** 0 while never switched; sent back as `expectedVersion` on a save. */
  readonly version: number;
}

export interface CustomerWallet {
  readonly customerAccountId: string;
  readonly currency: string;
  readonly marketStatus: WalletState;
  readonly accountStatus: 'none' | 'active' | 'frozen' | 'closed';
  readonly available: string;
  readonly held: string;
  readonly balanceCap: string;
  readonly roomUnderCap: string;
  readonly issueCap: string;
  readonly dailyCap: string;
  readonly usedToday: string;
}

export type CreditStatus = 'granted' | 'pending' | 'approved' | 'rejected' | 'expired';

export interface AdminCredit {
  readonly id: string;
  readonly customerAccountId: string;
  readonly amount: string;
  readonly currency: string;
  readonly reasonCode: string;
  readonly note: string | null;
  readonly status: CreditStatus;
  readonly approvalReason: string | null;
  readonly requestedBy: string;
  readonly requestedAt: string;
  readonly expiresAt: string | null;
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
  readonly decisionReason: string | null;
  readonly journalId: string | null;
}

export interface CreditList {
  readonly entries: readonly AdminCredit[];
  readonly nextCursor: string | null;
}

export type QueueTab = 'pending' | 'decided' | 'granted';
export const QUEUE_TABS: readonly QueueTab[] = ['pending', 'decided', 'granted'];
