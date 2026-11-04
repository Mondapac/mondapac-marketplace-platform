import type { ReactNode } from 'react';
import { AssistantWidget } from '../assistant/assistant-widget.tsx';
import type { AssistantSetup } from '../assistant/assistant.ts';
import { AccountDrawer } from '../account/account-drawer.tsx';
import { LoginModal } from '../account/login-modal.tsx';
import { CartDrawer } from '../cart/cart-drawer.tsx';
import { ConsentBar } from '../consent/consent-bar.tsx';
import type { Consent } from '../consent/consent.ts';
import { DeliverModal } from '../delivery/deliver-modal.tsx';
import type { DeliverTo } from '../delivery/deliver-to.ts';
import { OfflineBanner } from '../errors/offline-banner.tsx';
import type {
  CartSource,
  CheckoutCustomer,
  DeliveryLocatorSource,
  StorefrontContent,
} from '../storefront/types.ts';
import { BrowsePanel } from './browse-panel.tsx';
import { FocusHeader } from './checkout-focus.tsx';
import { Dock } from './dock.tsx';
import { Footer } from './footer.tsx';
import { Header } from './header.tsx';
import { PageFrame } from './page-frame.tsx';
import { Rail } from './rail.tsx';
import { SearchView } from './search-view.tsx';
import type { LiveCart } from '../cart/live-cart.ts';
import { StoreProvider, type PhotoBase } from './store-context.tsx';
import { TabBar } from './tab-bar.tsx';

/** The locked frame of every buyer page: header, side rail, footer, the cookie bar and the bottom bar, overlays (the cart drawer, the log-in dialog and the account menu among them) and the buyer assistant when it is on. */
export function StoreShell({
  content,
  cartSource,
  liveCart = null,
  photoBase = null,
  locator,
  deliverTo,
  consent,
  analyticsAvailable = false,
  signIn,
  live = false,
  assistant = null,
  children,
}: {
  readonly content: StorefrontContent;
  readonly cartSource: CartSource;
  /** Live: the buyer's cart as this page's server read it; null reads it in the browser. */
  readonly liveCart?: LiveCart | null;
  readonly photoBase?: PhotoBase | null;
  readonly locator: DeliveryLocatorSource;
  readonly deliverTo: DeliverTo | null;
  readonly consent: Consent | null;
  /** The Market has a GA4 measurement ID: the cookie bar offers analytics too. */
  readonly analyticsAvailable?: boolean;
  /** The account the sample log-in signs in to, until customer sessions are wired. */
  readonly signIn: CheckoutCustomer;
  /** The storefront talks to the API: sign-in, sign-out and the session are real. */
  readonly live?: boolean;
  /** The buyer assistant's setup; null (off) renders nothing. */
  readonly assistant?: AssistantSetup | null;
  readonly children: ReactNode;
}) {
  return (
    <StoreProvider
      cartSource={cartSource}
      initialLiveCart={liveCart}
      photoBase={photoBase}
      initialDeliverTo={deliverTo}
      live={live}
    >
      <div className="page">
        <BrowsePanel categories={content.categories} />
        <CartDrawer />
        <DeliverModal source={locator} />
        <LoginModal customer={signIn} />
        <AccountDrawer />
        <SearchView popular={content.popularSearches} />
        <PageFrame>
          <Header delivery={content.delivery} />
          <FocusHeader />
          <div className="body">
            <Rail />
            <main className="main" id="main">
              <OfflineBanner />
              {children}
            </main>
          </div>
          <Footer area={content.delivery.label} />
          <Dock>
            <ConsentBar initial={consent} analyticsAvailable={analyticsAvailable} />
            <TabBar />
          </Dock>
        </PageFrame>
        {assistant ? <AssistantWidget setup={assistant} /> : null}
      </div>
    </StoreProvider>
  );
}
