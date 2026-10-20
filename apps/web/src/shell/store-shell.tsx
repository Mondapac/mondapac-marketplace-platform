import type { ReactNode } from 'react';
import { AccountDrawer } from '../account/account-drawer.tsx';
import { LoginModal } from '../account/login-modal.tsx';
import { CartDrawer } from '../cart/cart-drawer.tsx';
import { ConsentBar } from '../consent/consent-bar.tsx';
import type { Consent } from '../consent/consent.ts';
import type { CartSource, CheckoutCustomer, StorefrontContent } from '../storefront/types.ts';
import { BrowsePanel } from './browse-panel.tsx';
import { Footer } from './footer.tsx';
import { Header } from './header.tsx';
import { PageFrame } from './page-frame.tsx';
import { Rail } from './rail.tsx';
import { SearchView } from './search-view.tsx';
import { StoreProvider } from './store-context.tsx';
import { TabBar } from './tab-bar.tsx';

/** The locked frame of every buyer page: header, side rail, footer, the cookie bar and the bottom bar, overlays (the cart drawer, the log-in dialog and the account menu among them). */
export function StoreShell({
  content,
  cartSource,
  consent,
  signIn,
  children,
}: {
  readonly content: StorefrontContent;
  readonly cartSource: CartSource;
  readonly consent: Consent | null;
  /** The account the sample log-in signs in to, until customer sessions are wired. */
  readonly signIn: CheckoutCustomer;
  readonly children: ReactNode;
}) {
  return (
    <StoreProvider cartSource={cartSource}>
      <div className="page">
        <BrowsePanel categories={content.categories} />
        <CartDrawer />
        <LoginModal customer={signIn} />
        <AccountDrawer />
        <SearchView popular={content.popularSearches} />
        <PageFrame>
          <Header delivery={content.delivery} />
          <div className="body">
            <Rail />
            <main className="main" id="main">
              {children}
            </main>
          </div>
          <Footer area={content.delivery.label} />
          <div className="dock">
            <ConsentBar initial={consent} />
            <TabBar />
          </div>
        </PageFrame>
      </div>
    </StoreProvider>
  );
}
