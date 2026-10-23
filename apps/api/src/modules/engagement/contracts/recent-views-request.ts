import type { IncomingHttpHeaders } from 'node:http';
import type { MarketId } from '@mondapac/shared-kernel';
import {
  engagementConsentOf,
  engagementGuestTokenOf,
  globalPrivacyControlOf,
} from '../presentation/guest-cookie';
import type { RecentViewsRequest } from './engagement.facade';

/**
 * Reads the privacy signals of a request the way the recording route does (`Sec-GPC`,
 * `Engagement-Consent`, the `__Host-engagement-guest-<market>` cookie), so every route that reads
 * a subject's views agrees with the route that records them. Pure: it sets and clears nothing.
 * The token is returned only to be passed to `EngagementFacade.recentViews`; never log it.
 */
export function recentViewsRequestOf(
  headers: IncomingHttpHeaders,
  marketId: MarketId,
): RecentViewsRequest {
  return {
    globalPrivacyControl: globalPrivacyControlOf(headers['sec-gpc']),
    consent: engagementConsentOf(headers['engagement-consent']),
    guestToken: engagementGuestTokenOf(headers.cookie, marketId),
  };
}
