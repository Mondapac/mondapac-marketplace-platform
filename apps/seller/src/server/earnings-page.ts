import 'server-only';
import { redirect } from 'next/navigation';
import type { OwnDispute } from '../disputes/types.ts';
import {
  HISTORY_PAGE,
  type NextPayout,
  type OwnHolds,
  type OwnPayouts,
  type PayoutsInitial,
} from '../earnings/payout-types.ts';
import { EARNINGS_VIEW_PERMISSION, type Ledger } from '../earnings/types.ts';
import { PAYOUT_VIEW_PERMISSION } from '../payout/types.ts';
import { SETUP_ROOT } from '../setup/steps.ts';
import { loadOwnDisputes } from './own-disputes.ts';
import { serverGet } from './server-fetch.ts';
import { requireSession, type SellerSession } from './session.ts';

export type EarningsPage =
  | {
      readonly kind: 'ok';
      readonly session: SellerSession;
      readonly ledger: Ledger;
      readonly disputes: readonly OwnDispute[];
      readonly payouts: PayoutsInitial;
    }
  | { readonly kind: 'no-access'; readonly session: SellerSession }
  | { readonly kind: 'unavailable' };

/** The session and the first page of the seller's own ledger. */
export async function loadEarningsPage(): Promise<EarningsPage> {
  const gate = await requireSession();
  if (gate.kind === 'unavailable') return { kind: 'unavailable' };
  const { session } = gate;
  if (session.sellerAccessState !== 'approved') redirect(SETUP_ROOT);
  if (!session.permissionKeys.includes(EARNINGS_VIEW_PERMISSION)) {
    return { kind: 'no-access', session };
  }
  const [ledger, disputes, next, holds, history] = await Promise.all([
    serverGet<Ledger>('commission-payouts/seller/ledger?limit=20'),
    loadOwnDisputes(),
    serverGet<NextPayout>('commission-payouts/seller/payouts/next'),
    serverGet<OwnHolds>('commission-payouts/seller/payout-holds'),
    serverGet<OwnPayouts>(`commission-payouts/seller/payouts?limit=${HISTORY_PAGE}`),
  ]);
  if (ledger.kind === 'signed-out') redirect('/session-ended');
  if (ledger.kind !== 'ok') return { kind: 'unavailable' };
  // A payout section that cannot be read shows its own retry; it never fails the page.
  const payouts: PayoutsInitial = {
    next: next.kind === 'ok' ? next.body : null,
    holds: holds.kind === 'ok' ? holds.body.holds : null,
    history: history.kind === 'ok' ? history.body : null,
    canOpenAccount: session.permissionKeys.includes(PAYOUT_VIEW_PERMISSION),
  };
  return { kind: 'ok', session, ledger: ledger.body, disputes, payouts };
}
