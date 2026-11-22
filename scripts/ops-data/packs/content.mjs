// The buyer site's content, through the admin's storefront editor (scenarios/<market>/content.mjs):
// slides with their pictures, the home page, the navigation and the information pages. The
// platform admin writes and submits; the reviewer admin approves and publishes, as a second admin
// would. A rerun changes nothing: a slide is found by its internal name and kept while it runs,
// and a page or the navigation is left alone once its published version matches. A slide whose
// text changed in the scenario is not edited; reset the environment to see the new text.
import { banner } from '../media.mjs';
import { blogPack } from './blog.mjs';
import { settle, write } from './requests.mjs';

const DAY = 86_400_000;
/** A slide runs for at most 90 days; the loader gives each one 85, from a minute from now. */
const SLIDE_DAYS = 85;

const NAME_PREFIX = 'Ops data: ';

const categoryOf = (categoryIds, slug) => {
  const id = categoryIds.get(slug);
  if (id === undefined) throw new Error(`content names category ${slug}, not in the catalog`);
  return id;
};

/** Slide placements and content in the API's shape. */
function slideBody(slide, categoryIds, imageRef, now) {
  const placement = { position: slide.position };
  if (slide.autoplay) placement.autoplay = true;
  if (slide.scope !== undefined) {
    placement.scope = 'category';
    placement.scopeId = categoryOf(categoryIds, slide.scope);
  }
  const content = { title: slide.title, textTone: slide.textTone };
  if (slide.body !== undefined) content.body = slide.body;
  if (slide.ctaLabel !== undefined) content.ctaLabel = slide.ctaLabel;
  if (slide.link !== undefined) {
    content.link = { type: 'category', id: categoryOf(categoryIds, slide.link) };
  }
  if (imageRef !== null) content.image = { ref: imageRef, alt: '', decorative: true };
  return {
    kind: slide.kind,
    internalName: NAME_PREFIX + slide.key,
    content,
    startsAt: new Date(now + 60_000).toISOString(),
    endsAt: new Date(now + SLIDE_DAYS * DAY).toISOString(),
    placements: [placement],
  };
}

async function ensureSlides(admin, reviewer, slides, categoryIds, log) {
  const list = await admin.ok('GET', '/storefront/admin/slides');
  const now = Date.now();
  let made = 0;
  for (const slide of slides) {
    const name = NAME_PREFIX + slide.key;
    // A slide that still runs is kept; an ended or archived one is made again.
    const running = list.slides.find(
      (row) =>
        row.internalName === name &&
        ['draft', 'pending', 'scheduled', 'live', 'paused'].includes(row.status),
    );
    let id = running?.id;
    let detail;
    if (id === undefined) {
      let imageRef = null;
      if (slide.image !== undefined) {
        const uploaded = await admin.ok('POST', '/storefront/admin/slide-images', {
          desktop: await banner(slide.image),
        });
        imageRef = uploaded.imageId;
      }
      detail = await admin.ok(
        'POST',
        '/storefront/admin/slides',
        slideBody(slide, categoryIds, imageRef, now),
      );
      id = detail.id;
      made += 1;
    } else {
      detail = await admin.ok('GET', `/storefront/admin/slides/${id}`);
    }
    // A draft not yet sent is submitted; a submitted one (pending) is approved by the reviewer.
    if (detail.draft !== null && detail.pending !== true) {
      detail = await admin.ok('POST', `/storefront/admin/slides/${id}/submit`, {});
    }
    if (detail.draft !== null) {
      await reviewer.ok('POST', `/storefront/admin/slides/${id}/approve`, {
        versionNo: detail.draft.versionNo,
      });
    }
  }
  log(`  ${slides.length} slides (${made} new)`);
}

/** Placements compared by what a buyer sees: module, switch and settings. */
const shapeOf = (placements) =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(placements)
        .filter(([, entries]) => entries.length > 0)
        .map(([slot, entries]) => [
          slot,
          entries.map((entry) => ({
            module: entry.module,
            enabled: entry.enabled ?? true,
            config: entry.config,
          })),
        ])
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
  );

/**
 * Makes a page's draft hold exactly the scenario's modules, slot by slot, and publishes it as the
 * reviewer. A page whose published version already matches is left alone.
 */
async function ensurePage(admin, reviewer, page, slots, pending, label) {
  const path = `/storefront/admin/pages/${page}`;
  let detail = await admin.ok('GET', path);
  const wanted = shapeOf(slots);
  if (detail.published !== null && shapeOf(detail.published.placements) === wanted) return false;
  if (detail.draft === null || shapeOf(detail.draft.placements) !== wanted) {
    if (detail.draft !== null && detail.draft.versionNo === null) {
      // A system page that was never edited shows its template's defaults, which have no
      // placement of their own yet: the first module added makes them a real draft. It goes to a
      // slot with room; everything is then removed and the scenario's modules added in order.
      const room = Object.entries(slots).find(
        ([key, entries]) =>
          entries.length > 0 &&
          (detail.draft.placements[key]?.length ?? 0) <
            (detail.slots.find((definition) => definition.key === key)?.max ?? 0),
      );
      if (room === undefined) {
        throw new Error(`${label}: every slot the scenario fills is full of template defaults`);
      }
      const [slot, entries] = room;
      await write(admin, 'POST', `${path}/slots/${slot}/modules`, entries[0], pending, label);
      detail = await admin.ok('GET', path);
    }
    for (const [slot, entries] of Object.entries(detail.draft?.placements ?? {})) {
      for (const entry of entries) {
        await write(
          admin,
          'DELETE',
          `${path}/slots/${slot}/modules/${entry.id}`,
          undefined,
          pending,
          label,
        );
      }
    }
    for (const [slot, entries] of Object.entries(slots)) {
      for (const entry of entries) {
        await write(admin, 'POST', `${path}/slots/${slot}/modules`, entry, pending, label);
      }
    }
    detail = await admin.ok('GET', path);
  }
  await write(
    reviewer,
    'POST',
    `${path}/publish`,
    { versionNo: detail.draft.versionNo, updatedAt: detail.draft.updatedAt },
    pending,
    label,
  );
  return true;
}

async function ensureNavigation(admin, reviewer, navigation, categoryIds, pending) {
  const slots = {
    rail: navigation.rail.map((entry) => ({ config: entry })),
    'drawer-popular': navigation.popular.map((slug) => ({
      config: { categoryId: categoryOf(categoryIds, slug) },
    })),
    'drawer-categories': navigation.departments.map((slug) => ({
      config: { categoryId: categoryOf(categoryIds, slug) },
    })),
  };
  const wanted = shapeOf(
    Object.fromEntries(
      Object.entries(slots).map(([slot, entries]) => [
        slot,
        entries.map((entry) => ({
          module: slot === 'rail' ? 'nav-link' : 'nav-category',
          ...entry,
        })),
      ]),
    ),
  );
  let detail = await admin.ok('GET', '/storefront/admin/navigation');
  if (detail.published !== null && shapeOf(detail.published.placements) === wanted) return false;
  if (detail.draft === null || shapeOf(detail.draft.placements) !== wanted) {
    await write(
      admin,
      'PUT',
      '/storefront/admin/navigation/draft',
      { slots },
      pending,
      'navigation',
    );
    detail = await admin.ok('GET', '/storefront/admin/navigation');
  }
  await write(
    reviewer,
    'POST',
    '/storefront/admin/navigation/approve',
    { versionNo: detail.draft.versionNo, updatedAt: detail.draft.updatedAt },
    pending,
    'navigation',
  );
  return true;
}

async function ensureInfoPages(admin, reviewer, pages, pending) {
  const list = await admin.ok('GET', '/storefront/admin/pages');
  let made = 0;
  let published = 0;
  for (const page of pages) {
    let row = list.pages.find((item) => item.kind !== 'system' && item.slug === page.slug);
    if (row === undefined) {
      row = await admin.ok('POST', '/storefront/admin/pages', {
        templateKey: 'info-page',
        title: page.title,
        slug: page.slug,
        seo: { title: page.title },
      });
      made += 1;
    }
    const slots = { body: [{ module: 'text-block', config: { blocks: page.blocks } }] };
    if (page.faq !== undefined) slots.faq = [{ module: 'faq', config: page.faq }];
    if (await ensurePage(admin, reviewer, row.id, slots, pending, `page ${page.slug}`)) {
      published += 1;
    }
  }
  return { made, published };
}

export async function contentPack({ admin, reviewer, scenario, categoryIds, state, log }) {
  if (reviewer === null) {
    throw new Error(
      'The content pack needs the reviewer admin: slides, pages, the navigation and blog posts ' +
        'are approved by a second admin.',
    );
  }
  const content = scenario.content;
  const pending = [];
  await ensureSlides(admin, reviewer, content.slides, categoryIds, log);

  const home = await ensurePage(admin, reviewer, 'home', content.home, pending, 'home page');
  await settle(reviewer, pending, log);
  log(`  home page ${home ? 'published' : 'already published'}`);

  const navigation = await ensureNavigation(
    admin,
    reviewer,
    content.navigation,
    categoryIds,
    pending,
  );
  await settle(reviewer, pending, log);
  log(`  navigation ${navigation ? 'approved' : 'already approved'}`);

  const pages = await ensureInfoPages(admin, reviewer, content.pages, pending);
  await settle(reviewer, pending, log);
  log(
    `  ${content.pages.length} information pages (${pages.made} new, ${pages.published} published now)`,
  );

  await blogPack({ admin, reviewer, scenario, state, log });
}
