import 'server-only';
import { validateRange, type DashboardSource } from '@mondapac/ui';
import { redirect } from 'next/navigation';
import type { CategoryTree } from '../../catalog/products-list-types.ts';
import { EARNINGS_VIEW_PERMISSION } from '../../earnings/types.ts';
import type { NextPayout } from '../../earnings/payout-types.ts';
import { ORDER_VIEW_PERMISSION } from '../../orders/types.ts';
import { HEALTH_PATH, type OwnHealth } from '../../performance/types.ts';
import { serverGet, type ServerGet } from '../../server/server-fetch.ts';
import type { SellerSession } from '../../server/session.ts';
import type { Widget } from '../types.ts';
import { periodQuery, type Selection } from './range.ts';
import {
  KPIS_PATH,
  NET_EARNINGS_PATH,
  SELLER_GOAL_MANAGE_PERMISSION,
  type SellerKpis,
  type SellerNetEarnings,
} from './types.ts';

export interface SellerKpiSources {
  /**
   * The custom range in the address is not valid: no figure of the period is read, and the page
   * says so in one line (the reason is under the field in the header).
   */
  readonly refused: boolean;
  /** The sales figures (key `ordering.seller-order.view`); null without it. */
  readonly kpis: DashboardSource<Widget<SellerKpis>> | null;
  /** The public category tree, to name the top categories; a failure leaves the ids unnamed. */
  readonly categories: DashboardSource<CategoryTree | null> | null;
  /** The seller's own health (no key: every approved seller sees it). */
  readonly health: DashboardSource<Widget<OwnHealth>>;
  /**
   * The seller's net earnings of the period (key `commission-payouts.earnings.view`); null without
   * the key, or once the API refuses (the card is then left out).
   */
  readonly netEarnings: DashboardSource<Widget<SellerNetEarnings> | null> | null;
  /** The estimated next payout (the earnings key too); null like `netEarnings`. */
  readonly nextPayout: DashboardSource<Widget<NextPayout> | null> | null;
  /**
   * What the Monthly goal card (from the KPI read) needs to edit the goal: whether the session holds
   * `reporting.seller-goal.manage`, and the CSRF token of the write. Absent: the card is read-only.
   */
  readonly goal?: { readonly canManage: boolean; readonly csrfToken: string };
}

function widgetOf<T>(answer: ServerGet<T>): Widget<T> {
  if (answer.kind === 'ok') return { kind: 'ok', value: answer.body };
  if (answer.kind === 'signed-out') redirect('/session-ended');
  return { kind: 'error' };
}

/** Like `widgetOf`, but a refusal leaves the card out (null) instead of showing an error. */
function optionalWidgetOf<T>(answer: ServerGet<T>): Widget<T> | null {
  return answer.kind === 'forbidden' ? null : widgetOf(answer);
}

/**
 * Starts the reads of the KPI section, or null when the session holds neither the orders key (the
 * sales figures are sums of the orders) nor the earnings key (net earnings and the next payout).
 * Each group is asked for on its own key: a member with only the earnings key still gets the
 * earnings cards. One call each; the cards stream in on their own. A custom range that is not
 * valid reads no figure of the period (the API would refuse it too). The net earnings read takes
 * the same period query as the sales figures, a custom range included.
 */
export function startSellerKpis(
  session: SellerSession,
  selection: Selection,
  today: string,
): SellerKpiSources | null {
  const orders = session.permissionKeys.includes(ORDER_VIEW_PERMISSION);
  const earnings = session.permissionKeys.includes(EARNINGS_VIEW_PERMISSION);
  if (!orders && !earnings) return null;
  const refused =
    selection.id === 'custom' &&
    validateRange({ from: selection.from, to: selection.to, today }).length > 0;
  const query = periodQuery(selection).toString();
  const kpis =
    orders && !refused ? serverGet<SellerKpis>(`${KPIS_PATH}?${query}`).then(widgetOf) : null;
  const health = serverGet<OwnHealth>(HEALTH_PATH).then(widgetOf);
  const categories =
    orders && !refused
      ? serverGet<CategoryTree>('catalog/categories', { anonymous: true }).then((answer) =>
          answer.kind === 'ok' ? answer.body : null,
        )
      : null;
  const netEarnings =
    earnings && !refused
      ? serverGet<SellerNetEarnings>(`${NET_EARNINGS_PATH}?${query}`).then(optionalWidgetOf)
      : null;
  const nextPayout = earnings
    ? serverGet<NextPayout>('commission-payouts/seller/payouts/next').then(optionalWidgetOf)
    : null;
  // The page reads them while it streams; a rejection (the redirect) is not unhandled until then.
  for (const read of [kpis, health, categories, netEarnings, nextPayout]) {
    read?.catch(() => undefined);
  }
  const goal = {
    canManage: session.permissionKeys.includes(SELLER_GOAL_MANAGE_PERMISSION),
    csrfToken: session.csrfToken,
  };
  return { refused, kpis, categories, health, netEarnings, nextPayout, goal };
}
