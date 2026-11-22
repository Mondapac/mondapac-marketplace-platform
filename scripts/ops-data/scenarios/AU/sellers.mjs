// The sellers of the AU scenario: the eighteen stores of the storefront's sample data
// (apps/web/src/storefront/sample-home.ts, sample-seller.ts, sample-sellers.ts), plus four
// sellers in the other onboarding states so the admin queues have rows. Store names, business
// names and About texts never use a claim word of the Market (halal, kosher, vegan, organic and
// their terms): a claim is made through a certificate, never in free text, so the sample's
// "Kedron Halal Butchers" is "Kedron Family Butchers" here and shows the Halal badge from its
// certificate instead.

/**
 * An 11-digit ABN with a valid checksum, built from a 9-digit core. The cores are small made-up
 * numbers (000000101 and up) and every phone number is in ACMA's range for drama and fiction
 * (07 5550 xxxx), so no sample seller carries a real business's ABN or a real line.
 */
export function abn(core) {
  const weights = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
  for (let prefix = 10; prefix <= 99; prefix += 1) {
    const digits = `${prefix}${core}`.split('').map(Number);
    digits[0] -= 1;
    if (digits.reduce((sum, digit, index) => sum + digit * weights[index], 0) % 89 === 0) {
      return `${prefix}${core}`;
    }
  }
  throw new Error(`no ABN for ${core}`);
}

/**
 * state: approved (the default), in-review (submitted, left for the admin), rejected (submitted
 * and rejected with a reason), suspended (approved, then suspended) or draft (signed up, file not
 * submitted). certificate: a halal certificate the seller submits and the reviewer approves.
 * minimum: the minimum order in minor units, or null for none. colour: the logo tile.
 */
const row = (key, storeName, owner, suburb, line1, postcode, core, phone, about, more = {}) => ({
  key,
  storeName,
  owner,
  email: `${owner.split(' ')[0].toLowerCase()}@${key}.ops.example`,
  businessName: `${storeName} Pty Ltd`,
  slug: key,
  phone,
  abn: abn(core),
  address: { line1, suburb, state: 'QLD', postcode },
  stockName: `${suburb} store`,
  about,
  state: 'approved',
  certificate: null,
  minimum: null,
  colour: '#0f766e',
  ...more,
});

const halal = (number, issueDate, expiryDate) => ({ type: 'halal', number, issueDate, expiryDate });

export const SELLERS = [
  // The six stores of the home page.
  row(
    'kedron',
    'Kedron Family Butchers',
    'Amina Rahman',
    'Kedron',
    '412 Gympie Road',
    '4031',
    '000000101',
    '0755500001',
    'Family-run butchery in Kedron. We cut and trim every piece ourselves and deliver across Greater Brisbane. Lamb, beef, goat and free-range chicken, cut to order and packed the same morning.',
    {
      certificate: halal('HC-2025-0142', '2025-07-01', '2027-06-30'),
      minimum: 4000,
      colour: '#9f1239',
    },
  ),
  row(
    'paddington',
    'Paddington Bakehouse',
    'Layla Haddad',
    'Paddington',
    '187 Given Terrace',
    '4064',
    '000000102',
    '0755500002',
    'Small neighbourhood bakehouse in Paddington. Sourdough, Lebanese and Turkish breads and pastries, baked every morning and delivered the same day.',
    { colour: '#b45309' },
  ),
  row(
    'sunnybank',
    'Sunnybank Pantry Co',
    'Wei Chen',
    'Sunnybank',
    '3 Mains Road',
    '4109',
    '000000103',
    '0755500003',
    'Pantry staples from Sunnybank: rice, lentils, oils, canned goods and noodles, packed to order and delivered across Greater Brisbane.',
    { minimum: 3000, colour: '#4d7c0f' },
  ),
  row(
    'inala',
    'Inala Spice House',
    'Omar Siddiqui',
    'Inala',
    '25 Wirraway Parade',
    '4077',
    '000000104',
    '0755500004',
    'Spices, nuts, dried fruit and syrups from Inala, ground and packed in small batches each week.',
    { colour: '#c2410c' },
  ),
  row(
    'moorooka',
    'Moorooka Dairy',
    'Hana Yilmaz',
    'Moorooka',
    '160 Beaudesert Road',
    '4105',
    '000000105',
    '0755500005',
    'Eggs, cheese, yoghurt and dips from Moorooka, delivered chilled the same day.',
    { minimum: 2500, colour: '#1d4ed8' },
  ),
  row(
    'mt-gravatt',
    'Mt Gravatt Fresh Produce',
    'Daniel Nguyen',
    'Mount Gravatt',
    '1380 Logan Road',
    '4122',
    '000000106',
    '0755500006',
    'Fruit, vegetables and fresh fish from the Mt Gravatt markets, picked each morning for delivery the next day.',
    { minimum: 3000, colour: '#15803d' },
  ),
  // The sellers page's other stores.
  row(
    'logan-road',
    'Logan Road Meats',
    'Bilal Ahmed',
    'Upper Mount Gravatt',
    '2010 Logan Road',
    '4122',
    '000000107',
    '0755500007',
    'Butcher on Logan Road. Beef, lamb and chicken, cut to order.',
    { minimum: 3500, colour: '#7f1d1d' },
  ),
  row(
    'coorparoo',
    'Coorparoo Pantry',
    'Sara Karimi',
    'Coorparoo',
    '280 Old Cleveland Road',
    '4151',
    '000000108',
    '0755500008',
    'New to Mondapac. Pantry staples and spices from local suppliers.',
    { colour: '#65a30d' },
  ),
  row(
    'sunnybank-meats',
    'Sunnybank Meats',
    'Yusuf Demir',
    'Sunnybank',
    '41 McCullough Street',
    '4109',
    '000000109',
    '0755500009',
    'Butcher in Sunnybank. Beef, lamb, goat and chicken, cut to order.',
    {
      certificate: halal('HC-2024-0388', '2024-04-01', '2027-03-31'),
      minimum: 3500,
      colour: '#991b1b',
    },
  ),
  row(
    'indooroopilly',
    'Indooroopilly Sweets',
    'Rania Saleh',
    'Indooroopilly',
    '99 Station Road',
    '4068',
    '000000110',
    '0755500010',
    'Baklava, maamoul and cakes from Indooroopilly, baked in small batches.',
    { minimum: 2000, colour: '#a21caf' },
  ),
  row(
    'redcliffe',
    'Redcliffe Kitchen',
    'Tariq Hassan',
    'Redcliffe',
    '120 Redcliffe Parade',
    '4020',
    '000000111',
    '0755500011',
    'New to Mondapac. Ready meals from Redcliffe, cooked fresh each morning.',
    { minimum: 4500, colour: '#0e7490' },
  ),
  row(
    'toowoomba',
    'Toowoomba Farm Direct',
    'Grace Wilson',
    'Rocklea',
    '385 Sherwood Road',
    '4106',
    '000000112',
    '0755500012',
    // Onboarding needs an address inside the Greater Brisbane service area: the farm sells from its
    // stall at the Rocklea markets.
    'Fruit, vegetables, milk and cheese straight from farms around Toowoomba, from our stall at the Rocklea markets.',
    { minimum: 5000, colour: '#3f6212' },
  ),
  row(
    'annerley',
    'Annerley Grocer',
    'Mariam Aziz',
    'Annerley',
    '475 Ipswich Road',
    '4103',
    '000000113',
    '0755500013',
    'Grocer in Annerley with a butcher counter and pantry staples.',
    {
      certificate: halal('HC-2025-0217', '2025-02-01', '2027-01-31'),
      minimum: 3000,
      colour: '#047857',
    },
  ),
  row(
    'wynnum',
    'Wynnum Poultry',
    'Ali Rezaei',
    'Wynnum',
    '128 Edith Street',
    '4178',
    '000000114',
    '0755500014',
    'Free-range chicken and turkey from Wynnum, prepared to order.',
    {
      certificate: halal('HC-2026-0051', '2026-06-01', '2027-05-31'),
      minimum: 3000,
      colour: '#a16207',
    },
  ),
  row(
    'carindale',
    'Carindale Bakery',
    'Noor Hussain',
    'Carindale',
    '1151 Creek Road',
    '4152',
    '000000115',
    '0755500015',
    'Breads and pastries from Carindale, baked every morning.',
    { colour: '#92400e' },
  ),
  row(
    'chermside',
    'Chermside Spice Bazaar',
    'Reza Tehrani',
    'Chermside',
    '395 Hamilton Road',
    '4032',
    '000000116',
    '0755500016',
    'Whole and ground spices, blends and teas from Chermside.',
    { minimum: 2500, colour: '#b91c1c' },
  ),
  row(
    'sherwood',
    'Sherwood Greens',
    'Emily Tran',
    'Sherwood',
    '512 Oxley Road',
    '4075',
    '000000117',
    '0755500017',
    'New to Mondapac. Leafy greens and herbs from Sherwood growers.',
    { minimum: 2000, colour: '#16a34a' },
  ),
  row(
    'ipswich-road-dairy',
    'Ipswich Road Dairy',
    'Kamal Farouk',
    'Salisbury',
    '1050 Ipswich Road',
    '4107',
    '000000118',
    '0755500018',
    'Milk, yoghurt, labneh and cheese from Salisbury, delivered chilled.',
    { minimum: 3000, colour: '#2563eb' },
  ),
  // The other onboarding states.
  row(
    'taringa',
    'Taringa Fresh Produce',
    'Fatima Noor',
    'Taringa',
    '149 Moggill Road',
    '4068',
    '000000119',
    '0755500019',
    'Fruit and vegetables from Taringa.',
    { state: 'in-review' },
  ),
  row(
    'west-end',
    'West End Deli',
    'Hamza Malik',
    'West End',
    '76 Boundary Street',
    '4101',
    '000000120',
    '0755500020',
    'Deli counter in West End.',
    { state: 'rejected', rejection: 'The ABN on the application belongs to another business.' },
  ),
  row(
    'stones-corner',
    'Stones Corner Sweets',
    'Lina Barakat',
    'Greenslopes',
    '412 Logan Road',
    '4120',
    '000000121',
    '0755500021',
    'Sweets and pastries from Stones Corner.',
    { state: 'suspended', suspension: 'Orders were not sent for two weeks.' },
  ),
  row(
    'nundah',
    'Nundah Corner Store',
    'Ibrahim Osman',
    'Nundah',
    '1210 Sandgate Road',
    '4012',
    '000000122',
    '0755500022',
    'Corner store in Nundah.',
    { state: 'draft' },
  ),
];
