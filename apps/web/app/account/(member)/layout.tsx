import type { ReactNode } from 'react';
import { AccountArea } from '../../../src/account/account-area.tsx';
import { loadAccount } from '../../../src/storefront/source.ts';

// The signed-in account pages (Overview, Orders, Addresses, Saved lists, Settings). Navigation is
// the global menu only (the rail; the Account tab's panel below 900px): no side menu or tabs.
export default async function AccountLayout({ children }: { children: ReactNode }) {
  return <AccountArea source={await loadAccount()}>{children}</AccountArea>;
}
