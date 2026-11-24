import 'server-only';
import type { DashboardSource } from '@mondapac/ui';
import { redirect } from 'next/navigation';
import type { CategoryTree } from '../../catalog/products-list-types.ts';
import { EARNINGS_VIEW_PERMISSION } from '../../earnings/types.ts';
import type { NextPayout } from '../../earnings/payout-types.ts';
import { ORDER_VIEW_PERMISSION } from '../../orders/types.ts';
import { HEALTH_PATH, type OwnHealth } from '../../performance/types.ts';
import { serverGet, type ServerGet } from '../../server/server-fetch.ts';
import type { SellerSession } from '../../server/session.ts';
import type { Widget } from '../types.ts';
import {
  KPIS_PATH,
  NET_EARNINGS_PATH,
  type Period,
  type SellerKpis,
  type SellerNetEarnings,
} from './types.ts';

export interface SellerKpiSources {
  readonly kpis: DashboardSource<Widget<SellerKpis>>;
  /** The public category tree, to name the top categories; a failure leaves the ids unnamed. */
  readonly categories: DashboardSource<CategoryTree | null>;
  /** The seller's own health (no key: every approved seller sees it). */
  readonly health: DashboardSource<Widget<OwnHealth>>;
  /**
   * The seller's net earnings of the period (key `commission-payouts.earnings.view`); null without
   * the key, or once the API refuses (the card is then left out).
   */
  readonly netEarnings: DashboardSource<Widget<SellerNetEarnings> | null> | null;
  /** The estimated next payout (the earnings key too); null like `netEarnings`. */
  readonly nextPayout: DashboardSource<Widget<NextPayout> | null> | null;
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
 * Starts the reads of the KPI section, or null when the session may not read the seller's orders
 * (the figures are sums of them). One call each; the cards stream in on their own.
 */
export function startSellerKpis(session: SellerSession, period: Period): SellerKpiSources | null {
  if (!session.permissionKeys.includes(ORDER_VIEW_PERMISSION)) return null;
  const kpis = serverGet<SellerKpis>(`${KPIS_PATH}?period=${period}`).then(widgetOf);
  const health = serverGet<OwnHealth>(HEALTH_PATH).then(widgetOf);
  const categories = serverGet<CategoryTree>('catalog/categories', { anonymous: true }).then(
    (answer) => (answer.kind === 'ok' ? answer.body : null),
  );
  const earnings = session.permissionKeys.includes(EARNINGS_VIEW_PERMISSION);
  const netEarnings = earnings
    ? serverGet<SellerNetEarnings>(`${NET_EARNINGS_PATH}?period=${period}`).then(optionalWidgetOf)
    : null;
  const nextPayout = earnings
    ? serverGet<NextPayout>('commission-payouts/seller/payouts/next').then(optionalWidgetOf)
    : null;
  // The page reads them while it streams; a rejection (the redirect) is not unhandled until then.
  for (const read of [kpis, health, categories, netEarnings, nextPayout]) {
    read?.catch(() => undefined);
  }
  return { kpis, categories, health, netEarnings, nextPayout };
}
