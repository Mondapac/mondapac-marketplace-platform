// Buyers, their address books, open carts and orders of the AU scenario (operational test data
// design, phase 2, PR 3). Alex Nguyen and the five orders of the buyer site's account sample
// (apps/web/src/storefront/sample-account.ts) come first, so the live account page shows what the
// sample showed; the other buyers fill the admin and seller order lists with every state the
// local environment can reach. Every person is fictional: .example addresses and 07 5550 phone
// numbers (the range reserved for fiction). Addresses are sample streets inside the Greater
// Brisbane service area.
//
// An order is one checkout of one cart, so it may span several stores. Every part is collected in
// person (pickup): the local environment has no courier, and a delivering method needs a fleet
// quote (future enhancements register). Lines are [store, product, quantity, variant index].
//
// The outcome of an order is how far the loader takes it, through the same API the buyer site,
// the seller panel and the admin panel call:
//   paid             card authorised, Stripe's event delivered, the order confirmed (captured)
//   ready            ... and the store marked it ready: the buyer's pickup code is live
//   collected        ... and the store confirmed the pickup with the buyer's code
//   refunded         ... collected, then the admin refunded one line (damaged)
//   cancelled        ... paid, then the admin cancelled it before it was ready (every line
//                    refunded; the order itself stays confirmed)
//   declined         the bank refused the card (Stripe test card); nothing was charged
//   requires-action  the card asks for 3D Secure, which only a browser can answer: the order
//                    waits for payment until its pay-by time
//
// Cards are Stripe's test payment methods (pm_card_*); no card number is ever written here.

/** The Stripe test payment method of each card name of the scenario. */
export const CARDS = {
  visa: 'pm_card_visa',
  mastercard: 'pm_card_mastercard',
  declined: 'pm_card_chargeDeclined',
  '3ds': 'pm_card_authenticationRequired',
};

const buyer = (key, firstName, lastName, phone, line1, suburb, postcode, more = {}) => ({
  key,
  firstName,
  lastName,
  email: `${firstName}.${lastName}`.toLowerCase().replace(/[^a-z.]/g, '') + '@buyers.example',
  phone,
  addresses: [{ line1, suburb, postcode }],
  ...more,
});

export const BUYERS = [
  buyer('alex', 'Alex', 'Nguyen', '0755502001', '12 Example Street', 'Kedron', '4031', {
    // The sample account's second address: a work address under another recipient name.
    addresses: [
      { line1: '12 Example Street', suburb: 'Kedron', postcode: '4031' },
      {
        line1: 'Level 3, 100 Sample Road',
        suburb: 'Brisbane City',
        postcode: '4000',
        firstName: 'Sam',
      },
    ],
  }),
  buyer('fatima', 'Fatima', 'Haddad', '0755502002', '8 Sample Lane', 'Sunnybank', '4109'),
  buyer('omar', 'Omar', 'Siddiqui', '0755502003', '41 Example Avenue', 'Inala', '4077'),
  buyer('leila', 'Leila', 'Karimi', '0755502004', '3 Sample Court', 'Moorooka', '4105'),
  buyer('yusuf', 'Yusuf', 'Ali', '0755502005', '27 Example Road', 'Mount Gravatt', '4122'),
  buyer('mariam', 'Mariam', 'Hassan', '0755502006', '15 Sample Street', 'Coorparoo', '4151'),
  buyer('daniel', 'Daniel', 'Brooks', '0755502007', '9 Example Place', 'Paddington', '4064'),
  buyer('sophie', 'Sophie', 'Tran', '0755502008', '62 Sample Parade', 'Indooroopilly', '4068'),
  buyer('ibrahim', 'Ibrahim', 'Yilmaz', '0755502009', '5 Example Close', 'Annerley', '4103'),
  buyer('zara', 'Zara', 'Ahmed', '0755502010', '18 Sample Terrace', 'Chermside', '4032'),
  buyer('hamza', 'Hamza', 'Rahimi', '0755502011', '33 Example Street', 'Carindale', '4152'),
  buyer('noor', 'Noor', 'Saleh', '0755502012', '7 Sample Way', 'Sherwood', '4075'),
  buyer('james', 'James', 'Wilson', '0755502013', '120 Example Road', 'Wynnum', '4178'),
  buyer('aisha', 'Aisha', 'Malik', '0755502014', '44 Sample Street', 'Salisbury', '4107'),
  buyer(
    'khalid',
    'Khalid',
    'Nasser',
    '0755502015',
    '2 Example Lane',
    'Upper Mount Gravatt',
    '4122',
  ),
  buyer('emma', 'Emma', 'Clarke', '0755502016', '81 Sample Avenue', 'Rocklea', '4106'),
  buyer('reza', 'Reza', 'Moradi', '0755502017', '16 Example Crescent', 'Kedron', '4031'),
  buyer('hana', 'Hana', 'Okafor', '0755502018', '29 Sample Road', 'Greenslopes', '4120'),
  buyer('tariq', 'Tariq', 'Bashir', '0755502019', '6 Example Street', 'Sunnybank', '4109'),
  buyer('lina', 'Lina', 'Chen', '0755502020', '53 Sample Street', 'Nundah', '4012'),
  buyer('samir', 'Samir', 'Aziz', '0755502021', '11 Example Drive', 'Taringa', '4068'),
  buyer('grace', 'Grace', 'Murphy', '0755502022', '70 Sample Road', 'West End', '4101'),
  buyer('adam', 'Adam', 'Farouk', '0755502023', '24 Example Street', 'Mount Gravatt', '4122'),
  buyer('salma', 'Salma', 'Idris', '0755502024', '38 Sample Avenue', 'Inala', '4077'),
  buyer('ryan', 'Ryan', 'Patel', '0755502025', '4 Example Court', 'Coorparoo', '4151'),
  buyer('amira', 'Amira', 'Jaber', '0755502026', '90 Sample Street', 'Annerley', '4103'),
  buyer('bilal', 'Bilal', 'Qureshi', '0755502027', '13 Example Road', 'Moorooka', '4105'),
  buyer('chloe', 'Chloe', 'Bennett', '0755502028', '57 Sample Lane', 'Paddington', '4064'),
  buyer('mustafa', 'Mustafa', 'Demir', '0755502029', '21 Example Street', 'Chermside', '4032'),
  buyer('yasmin', 'Yasmin', 'Rahman', '0755502030', '36 Sample Place', 'Sunnybank', '4109'),
];

const order = (key, buyerKey, outcome, card, lines, more = {}) => ({
  key,
  buyer: buyerKey,
  outcome,
  card,
  lines,
  ...more,
});

export const ORDERS = [
  // The account sample's orders (MP-20481, MP-20503, MP-20412, MP-20377, MP-20290).
  order(
    'alex-1',
    'alex',
    'paid',
    'visa',
    [
      ['kedron', 'whole-chicken', 1],
      ['kedron', 'brisket', 1],
      ['mt-gravatt', 'bananas', 2],
      ['mt-gravatt', 'fruit-box', 1],
    ],
    { notes: { kedron: 'Please ring the bell twice.' } },
  ),
  order('alex-2', 'alex', 'ready', 'visa', [['paddington', 'sourdough', 1]]),
  order('alex-3', 'alex', 'paid', 'mastercard', [
    ['inala', 'medjool', 1],
    ['inala', 'saffron', 2],
  ]),
  order('alex-4', 'alex', 'collected', 'visa', [['paddington', 'sourdough', 2]], { address: 1 }),
  order('alex-5', 'alex', 'cancelled', 'visa', [
    ['sunnybank', 'basmati', 1, 1],
    ['sunnybank', 'olive-oil', 1],
  ]),
  // Waiting for the stores.
  order('fatima-1', 'fatima', 'paid', 'visa', [
    ['sunnybank-meats', 'goat-curry', 1],
    ['sunnybank-meats', 'chicken-thigh', 1],
  ]),
  order('omar-1', 'omar', 'paid', 'mastercard', [
    ['inala', 'tahini', 1],
    ['inala', 'sumac', 2],
    ['coorparoo', 'zaatar', 1],
  ]),
  order('leila-1', 'leila', 'paid', 'visa', [
    ['moorooka', 'hummus', 2],
    ['moorooka', 'cheese', 1],
    ['moorooka', 'eggs', 1, 1],
  ]),
  order('yusuf-1', 'yusuf', 'paid', 'visa', [
    ['logan-road', 'rump-steak', 1],
    ['logan-road', 'lamb-kofta', 2],
  ]),
  order('mariam-1', 'mariam', 'paid', 'visa', [
    ['indooroopilly', 'baklava', 1],
    ['indooroopilly', 'maamoul', 1],
  ]),
  order('sophie-1', 'sophie', 'paid', 'mastercard', [
    ['redcliffe', 'chicken-biryani', 2],
    ['redcliffe', 'lamb-tagine', 1],
  ]),
  order('zara-1', 'zara', 'paid', 'visa', [
    ['chermside', 'cardamom', 1],
    ['chermside', 'black-tea', 1],
    ['chermside', 'arabic-coffee', 1],
  ]),
  order('james-1', 'james', 'paid', 'visa', [
    ['wynnum', 'chicken-wings', 2],
    ['wynnum', 'chicken-skewers', 1],
  ]),
  // Ready to collect: the pickup code is live in the buyer's order.
  order('daniel-1', 'daniel', 'ready', 'visa', [
    ['paddington', 'croissants', 1],
    ['paddington', 'flatbread', 2],
  ]),
  order('ibrahim-1', 'ibrahim', 'ready', 'mastercard', [
    ['annerley', 'black-tea', 1],
    ['annerley', 'freekeh', 2],
    ['annerley', 'semolina', 1],
  ]),
  order('hamza-1', 'hamza', 'ready', 'visa', [
    ['carindale', 'turkish-bread', 2],
    ['carindale', 'wraps', 1],
  ]),
  order('noor-1', 'noor', 'ready', 'visa', [
    ['sherwood', 'parsley', 2],
    ['sherwood', 'salad-mix', 2],
    ['sherwood', 'cucumbers', 2],
  ]),
  order('aisha-1', 'aisha', 'ready', 'visa', [
    ['ipswich-road-dairy', 'labneh', 2],
    ['ipswich-road-dairy', 'haloumi', 2],
    ['ipswich-road-dairy', 'pita-chips', 1],
  ]),
  // Collected in person.
  order('khalid-1', 'khalid', 'collected', 'visa', [['logan-road', 'bbq-pack', 1]]),
  order('emma-1', 'emma', 'collected', 'mastercard', [
    ['toowoomba', 'mangoes', 2],
    ['toowoomba', 'potatoes', 1],
    ['toowoomba', 'cheese', 1],
  ]),
  order('reza-1', 'reza', 'collected', 'visa', [
    ['kedron', 'lamb-shoulder', 1],
    ['kedron', 'lamb-mince', 2],
  ]),
  order('hana-1', 'hana', 'collected', 'visa', [
    ['inala', 'almonds', 1, 1],
    ['inala', 'apricots', 1],
  ]),
  order('tariq-1', 'tariq', 'collected', 'visa', [
    ['sunnybank', 'jasmine-rice', 1],
    ['sunnybank', 'coconut-milk', 2],
    ['sunnybank', 'chickpeas', 4],
  ]),
  order('lina-1', 'lina', 'collected', 'mastercard', [
    ['moorooka', 'yoghurt', 2],
    ['moorooka', 'baba-ghanoush', 1],
    ['moorooka', 'milk', 1],
  ]),
  order('fatima-2', 'fatima', 'collected', 'visa', [
    ['mt-gravatt', 'barramundi', 1],
    ['mt-gravatt', 'apples', 2],
  ]),
  order('omar-2', 'omar', 'collected', 'visa', [
    ['coorparoo', 'baharat', 1],
    ['coorparoo', 'foul', 3],
  ]),
  // Refunded after collection (one line, damaged; the store bears it).
  order('samir-1', 'samir', 'refunded', 'visa', [
    ['wynnum', 'whole-chicken', 1],
    ['wynnum', 'chicken-breast', 1],
  ]),
  order('grace-1', 'grace', 'refunded', 'mastercard', [
    ['indooroopilly', 'turkish-delight', 1],
    ['indooroopilly', 'orange-cake', 1],
  ]),
  // Cancelled by the admin while waiting for the store.
  order('adam-1', 'adam', 'cancelled', 'visa', [['sunnybank-meats', 'goat-leg', 1]]),
  // Refused by the bank; and waiting for 3D Secure.
  order('salma-1', 'salma', 'declined', 'declined', [['chermside', 'saffron', 3]]),
  order('ryan-1', 'ryan', 'declined', 'declined', [['carindale', 'sourdough', 2]]),
  order('amira-1', 'amira', 'requires-action', '3ds', [
    ['annerley', 'medjool', 2],
    ['annerley', 'arabic-coffee', 1],
  ]),
  order('bilal-1', 'bilal', 'requires-action', '3ds', [['paddington', 'cheese-pastries', 2]]),
];

/** Carts the buyers filled and did not check out (the cart page and abandoned-cart lists). */
export const OPEN_CARTS = [
  {
    buyer: 'alex',
    // The sample cart: Kedron and Mount Gravatt lines, the sample's "weekly basics".
    lines: [
      ['kedron', 'diced-lamb', 1],
      ['paddington', 'flatbread', 1],
      ['mt-gravatt', 'bananas', 1],
    ],
  },
  {
    buyer: 'chloe',
    lines: [
      ['paddington', 'croissants', 1],
      ['carindale', 'wraps', 2],
    ],
  },
  {
    buyer: 'mustafa',
    lines: [
      ['chermside', 'zaatar', 1],
      ['chermside', 'cumin', 1, 1],
    ],
  },
  {
    buyer: 'yasmin',
    lines: [
      ['sunnybank', 'honey', 1],
      ['sunnybank', 'lentils', 2, 1],
    ],
  },
  { buyer: 'leila', lines: [['ipswich-road-dairy', 'fetta', 1]] },
  {
    buyer: 'james',
    lines: [
      ['redcliffe', 'falafel', 2],
      ['redcliffe', 'tabouli', 1],
    ],
  },
];
