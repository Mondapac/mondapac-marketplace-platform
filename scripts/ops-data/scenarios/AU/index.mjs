// The AU scenario of the operational test data (operational test data design, phase 2): one file
// set per Market, so a second Market adds its own folder and nothing else. Every name is plain
// grocery wording: catalog claim-checks all text, and a claim is made only through a certificate.
// Emails use the reserved .example domain; mail reaches only Mailpit.
import { CATALOG } from './catalog.mjs';

export const SCENARIO = {
  market: 'AU',
  locale: 'en-AU',
  currency: 'AUD',
  timeZone: 'Australia/Brisbane',
  admin: { email: 'admin@ops.example', displayName: 'Ops Admin' },
  catalog: CATALOG,
};
