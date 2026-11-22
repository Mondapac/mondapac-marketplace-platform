// The AU scenario of the operational test data (operational test data design, phase 2): one file
// set per Market, so a second Market adds its own folder and nothing else. Every name is plain
// grocery wording: catalog claim-checks all text, and a claim is made only through a certificate.
// Emails use the reserved .example domain; mail reaches only Mailpit.
import { CATALOG } from './catalog.mjs';
import { HELD, OFFERS, PRODUCTS, TAGGED_DEPARTMENTS } from './products.mjs';
import { SELLERS } from './sellers.mjs';
import { CONTENT } from './content.mjs';

export const SCENARIO = {
  market: 'AU',
  locale: 'en-AU',
  currency: 'AUD',
  timeZone: 'Australia/Brisbane',
  admin: { email: 'admin@ops.example', displayName: 'Ops Admin' },
  // The second admin: approves what waits for a second admin's approval (System requests).
  reviewer: { email: 'reviewer@ops.example', displayName: 'Ops Reviewer' },
  catalog: CATALOG,
  sellers: SELLERS,
  products: PRODUCTS,
  offers: OFFERS,
  taggedDepartments: TAGGED_DEPARTMENTS,
  held: HELD,
  content: CONTENT,
};
