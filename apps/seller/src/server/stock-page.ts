import 'server-only';
import { redirect } from 'next/navigation';
import { STOCK_VIEW_PERMISSION, type SourcesView, type StockFormOptions } from '../stock/types.ts';
import type { FormDescriptors } from '../setup/types.ts';
import { SETUP_ROOT } from '../setup/steps.ts';
import { serverGet } from './server-fetch.ts';
import { requireSession, type SellerSession } from './session.ts';

export type StockPage =
  | {
      readonly kind: 'ok';
      readonly session: SellerSession;
      readonly view: SourcesView;
      readonly options: StockFormOptions;
    }
  | { readonly kind: 'no-access'; readonly session: SellerSession }
  | { readonly kind: 'unavailable' };

/** The distinct zone ids of every region, sorted, for the optional zone of a location. */
export function zonesOf(timezones: FormDescriptors['timezones']): string[] {
  return [...new Set(Object.values(timezones).flat())].sort();
}

/** The session, the stock locations and the Market's address form for the stock locations page. */
export async function loadStockPage(): Promise<StockPage> {
  const gate = await requireSession();
  if (gate.kind === 'unavailable') return { kind: 'unavailable' };
  const { session } = gate;
  if (session.sellerAccessState !== 'approved') redirect(SETUP_ROOT);
  if (!session.permissionKeys.includes(STOCK_VIEW_PERMISSION))
    return { kind: 'no-access', session };
  const [sources, descriptors] = await Promise.all([
    serverGet<SourcesView>('inventory/seller/sources'),
    serverGet<FormDescriptors>('sellers/my-file/form-descriptors'),
  ]);
  if (sources.kind === 'signed-out' || descriptors.kind === 'signed-out') {
    redirect('/session-ended');
  }
  if (sources.kind !== 'ok' || descriptors.kind !== 'ok') return { kind: 'unavailable' };
  const { address, timezones } = descriptors.body;
  return {
    kind: 'ok',
    session,
    view: sources.body,
    options: {
      fields: address.fields,
      regionField: address.regionField,
      regions: address.regions,
      zones: zonesOf(timezones),
    },
  };
}
