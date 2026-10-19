import type { ReactNode } from 'react';
import { ConsentBar } from '../consent/consent-bar.tsx';
import type { Consent } from '../consent/consent.ts';
import type { TextSize } from '../preferences/preferences.ts';
import type { StorefrontContent } from '../storefront/types.ts';
import { BrowsePanel } from './browse-panel.tsx';
import { Footer } from './footer.tsx';
import { Header } from './header.tsx';
import { PageFrame } from './page-frame.tsx';
import { Rail } from './rail.tsx';
import { SearchView } from './search-view.tsx';
import { StoreProvider } from './store-context.tsx';
import { TabBar } from './tab-bar.tsx';

/** The locked frame of every buyer page: header, side rail, footer, the cookie bar and the bottom bar, overlays. */
export function StoreShell({
  content,
  textSize,
  consent,
  children,
}: {
  readonly content: StorefrontContent;
  readonly textSize: TextSize;
  readonly consent: Consent | null;
  readonly children: ReactNode;
}) {
  return (
    <StoreProvider>
      <div className="page">
        <BrowsePanel categories={content.categories} />
        <SearchView popular={content.popularSearches} />
        <PageFrame>
          <Header delivery={content.delivery} />
          <div className="body">
            <Rail />
            <main className="main" id="main">
              {children}
            </main>
          </div>
          <Footer area={content.delivery.label} textSize={textSize} />
          <div className="dock">
            <ConsentBar initial={consent} />
            <TabBar />
          </div>
        </PageFrame>
      </div>
    </StoreProvider>
  );
}
