// Pack "products": the platform products the admin makes and the Offers each approved seller lists
// on them, through the admin and seller panels' APIs. A product gets its texts, category, tax
// category, attributes (brand, description, country of origin, storage), pack-size or volume
// variants, and the storefront sample's photo where it had one; then it is submitted (published).
// Each Offer gets its handling, is submitted, and the admin approves its first publish; a
// certified seller tags its meat and poultry Offers with the certificate type. Stock goes on the
// seller's stock location, regular prices are set, a "was" price becomes a two-week special price,
// and one price rise is held for the admin. State: state.products[key] = { productId, variantIds }.
import { placeholder } from '../media.mjs';
import { settle, write } from './requests.mjs';

const DAY = 86_400_000;

/** How each department's goods are handled (catalog handling types). */
const HANDLING = {
  meat: 'FRESH',
  poultry: 'FRESH',
  seafood: 'FRESH',
  bakery: 'PREPARED',
  pantry: 'SEALED_ORIGINAL',
  dairy: 'FRESH',
  produce: 'FRESH',
  spices: 'REPACKED',
  meals: 'PREPARED',
  'sweets-and-snacks': 'PREPARED',
  drinks: 'SEALED_ORIGINAL',
  household: 'SEALED_ORIGINAL',
};

/** The department (level 1) a category sits under. */
function departmentOf(scenario, slug) {
  const bySlug = new Map(scenario.catalog.categories.map((item) => [item.slug, item]));
  let category = bySlug.get(slug);
  if (!category) throw new Error(`category ${slug} is not in the scenario`);
  while (category.parent !== null) category = bySlug.get(category.parent);
  return category.slug;
}

async function ensureProduct(admin, product, scenario, categoryIds, state, save) {
  const { locale } = scenario;
  state.products ??= {};
  const known = state.products[product.key];
  if (known?.published) return false;
  let created = known;
  if (created === undefined) {
    const answer = await admin.ok('POST', '/catalog/admin/platform-products', {
      typeCode: product.variants === null ? 'simple' : 'configurable',
    });
    created = { productId: answer.productId, variantIds: answer.variantIds, imageId: null };
    state.products[product.key] = created;
    save();
  }
  const base = `/catalog/admin/platform-products/${created.productId}`;
  if (product.image !== null && created.imageId === null) {
    const uploaded = await admin.ok('POST', `${base}/images`, { data: placeholder(product.image) });
    created.imageId = uploaded.imageId ?? uploaded.image?.imageId ?? uploaded.id;
    save();
  }
  const content = (variantIds) => ({
    texts: {
      [locale]: { name: product.name, shortDescription: product.short, description: product.text },
    },
    categoryIds: [categoryIds.get(product.category)],
    taxCategoryCode: product.tax,
    attributeValues: {
      brand: product.brand,
      description: { [locale]: product.text },
      'country-of-origin': product.origin,
      storage: product.storage,
    },
    imageIds: created.imageId === null ? [] : [created.imageId],
    variants:
      product.variants === null
        ? variantIds.map((variantId) => ({ variantId, labels: { [locale]: product.name } }))
        : product.variants.map(([option, label], index) => ({
            variantId: variantIds[index],
            optionValues: { [product.variantAttribute]: option },
            labels: { [locale]: label },
          })),
  });
  let { variantIds } = created;
  if (product.variants !== null && variantIds.length !== product.variants.length) {
    // New variants are named by a placeholder id; the server mints the real ones on the first save.
    const first = await admin.ok('PUT', `${base}/draft`, {
      variantIds: product.variants.map(() => null),
      content: content(product.variants.map((_, index) => `new${index + 1}`)),
    });
    variantIds = first.variantIds;
    created.variantIds = variantIds;
    save();
  }
  const saved = await admin.ok('PUT', `${base}/draft`, {
    variantIds,
    content: content(variantIds),
  });
  if (saved.refusedFields?.length > 0) {
    throw new Error(`${product.key}: refused fields ${JSON.stringify(saved.refusedFields)}`);
  }
  const submitted = await admin.ok('POST', `${base}/submit`, { replacePending: false });
  if (!submitted.published) throw new Error(`${product.key}: not published`);
  created.published = true;
  save();
  return true;
}

const asList = (value) => (Array.isArray(value) ? value : [value]);

async function ensureOffers(admin, reviewer, scenario, seller, session, state, log) {
  const { locale } = scenario;
  const existing = await session.ok('GET', '/catalog/seller/offers?limit=50');
  const bySku = new Map(existing.items.map((item) => [item.sellerSku, item]));
  const prefix = seller.key.slice(0, 3).toUpperCase();
  const offers = [];
  for (const [index, entry] of scenario.offers[seller.key].entries()) {
    const product = scenario.products.find((item) => item.key === entry.product);
    if (!product) throw new Error(`${seller.key}: offer on unknown product ${entry.product}`);
    const sku = `${prefix}-${String(index + 1).padStart(3, '0')}`;
    let offer = bySku.get(sku);
    let offerId = offer?.offerId;
    if (!offer) {
      const created = await session.ok('POST', '/catalog/seller/offers', {
        productId: state.products[product.key].productId,
        sellerSku: sku,
        conditionCode: 'new',
        description: { [locale]: product.short },
      });
      offerId = created.offerId;
      offer = { status: 'draft' };
    }
    if (offer.status === 'draft' || offer.status === 'changes-needed') {
      await session.ok('PUT', `/catalog/seller/offers/${offerId}/handling`, {
        handling: HANDLING[departmentOf(scenario, product.category)],
      });
      await session.ok('POST', `/catalog/seller/offers/${offerId}/submit`, {});
      offer = { status: 'pending-first-publish' };
    }
    if (offer.status === 'pending-first-publish') {
      const queue = await admin.ok('GET', '/catalog/admin/review-queue?limit=50');
      const row = queue.items.find((item) => item.offerId === offerId);
      if (!row) throw new Error(`offer ${offerId} is not in the first 50 rows of the review queue`);
      const pending = [];
      await write(
        admin,
        'POST',
        `/catalog/admin/offers/${offerId}/approve`,
        { version: row.version },
        pending,
        `approve offer ${sku}`,
      );
      await settle(reviewer, pending, log);
    }
    offers.push({ offerId, sku, entry, product });
  }
  return offers;
}

/** The certificate type tag on a certified seller's meat and poultry Offers. */
async function ensureTags(session, seller, offers, scenario) {
  if (seller.certificate === null) return 0;
  let tagged = 0;
  for (const { offerId, product } of offers) {
    if (!scenario.taggedDepartments.has(departmentOf(scenario, product.category))) continue;
    const answer = await session.request('POST', `/catalog/seller/offers/${offerId}/tags`, {
      typeCode: seller.certificate.type,
    });
    if (answer.status >= 200 && answer.status < 300) tagged += 1;
    else if (!['tag.exists', 'offer.change-pending'].includes(answer.body?.code))
      throw new Error(
        `${seller.key}: tag ${offerId} -> ${answer.status} ${JSON.stringify(answer.body)}`,
      );
  }
  return tagged;
}

async function ensureStockAndPrices(session, seller, offers, state, scenario) {
  const { currency } = scenario;
  const sources = await session.ok('GET', '/inventory/seller/sources');
  const source = sources.sources.find((item) => item.isDefault) ?? sources.sources[0];
  const endsAt = new Date(Date.now() + 14 * DAY).toISOString().replace(/\.\d+Z$/, 'Z');
  for (const { offerId, entry, product } of offers) {
    const variantIds = state.products[product.key].variantIds;
    const stockLevels = asList(entry.stock);
    const selling = asList(entry.price);
    const was = entry.was === undefined ? null : asList(entry.was);
    const stock = await session.ok('GET', `/inventory/seller/offers/${offerId}/stock`);
    for (const [index, variantId] of variantIds.entries()) {
      const row = stock.variants.find((variant) => variant.variantId === variantId).sources[0];
      if (row.onHand === 0) {
        await session.ok(
          'PUT',
          `/inventory/seller/offers/${offerId}/variants/${variantId}/sources/${source.id}/stock`,
          { onHand: stockLevels[index], expectedVersion: row.version },
        );
      }
      const regular = was === null ? selling[index] : was[index];
      let prices = await session.ok('GET', `/pricing/seller/offers/${offerId}/prices`);
      let price = prices.variants.find((variant) => variant.variantId === variantId);
      if (price.inForce === null && price.held === null) {
        await session.ok(
          'PUT',
          `/pricing/seller/offers/${offerId}/variants/${variantId}/regular-price`,
          { amount: String(regular), currency, expectedVersion: price.seriesVersion ?? null },
        );
        prices = await session.ok('GET', `/pricing/seller/offers/${offerId}/prices`);
        price = prices.variants.find((variant) => variant.variantId === variantId);
      }
      if (was !== null && price.special === null && price.heldSpecial === null) {
        await session.ok(
          'PUT',
          `/pricing/seller/offers/${offerId}/variants/${variantId}/special-price`,
          {
            amount: String(selling[index]),
            currency,
            endsAt,
            expectedVersion: price.seriesVersion,
          },
        );
      }
    }
  }
}

/** One regular price rise above the jump threshold: the platform holds it for the admin. */
async function heldPrice(sessions, offersBySeller, scenario, state, log) {
  const { held } = scenario;
  const session = sessions.get(held.seller);
  const offer = offersBySeller.get(held.seller)?.find((item) => item.product.key === held.product);
  if (!session || !offer) return;
  const variantId = state.products[held.product].variantIds[0];
  const prices = await session.ok('GET', `/pricing/seller/offers/${offer.offerId}/prices`);
  const price = prices.variants.find((variant) => variant.variantId === variantId);
  if (price.held !== null || price.inForce?.amount === String(held.amount)) return;
  const written = await session.ok(
    'PUT',
    `/pricing/seller/offers/${offer.offerId}/variants/${variantId}/regular-price`,
    {
      amount: String(held.amount),
      currency: scenario.currency,
      expectedVersion: price.seriesVersion,
    },
  );
  log(
    written.status === 'pending-review'
      ? `  ${held.seller}: price rise on ${held.product} held for the admin`
      : `  note: the ${held.product} rise was ${written.status}, not held (check the Market's pricing.jumpThreshold)`,
  );
}

export async function productsPack({
  admin,
  reviewer,
  scenario,
  categoryIds,
  sessions,
  state,
  save,
  log,
}) {
  let made = 0;
  for (const product of scenario.products) {
    if (await ensureProduct(admin, product, scenario, categoryIds, state, save)) made += 1;
  }
  log(`  ${scenario.products.length} products (${made} new)`);
  const offersBySeller = new Map();
  let offerCount = 0;
  let tagCount = 0;
  for (const seller of scenario.sellers) {
    const session = sessions.get(seller.key);
    if (!session || !scenario.offers[seller.key]) continue;
    const offers = await ensureOffers(admin, reviewer, scenario, seller, session, state, log);
    tagCount += await ensureTags(session, seller, offers, scenario);
    await ensureStockAndPrices(session, seller, offers, state, scenario);
    offersBySeller.set(seller.key, offers);
    offerCount += offers.length;
  }
  log(`  ${offerCount} offers on ${offersBySeller.size} stores (${tagCount} tags added now)`);
  await heldPrice(sessions, offersBySeller, scenario, state, log);
}
