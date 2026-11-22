import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Temporal } from '@mondapac/shared-kernel';
import { FixedClock } from '@mondapac/shared-kernel/testing';
import { StripeWebhookSignature } from '../src/modules/payments/infrastructure/stripe-webhook-signature';

import {
  matchClaimTerms,
  prepareVocabulary,
} from '../src/modules/certification/domain/claim-text-matcher';

// scripts/ops-data (the operational test data loader, phase 2): the guards that keep it off any
// production system, and the invariants of the AU scenario's catalog structure. The strict local
// guard itself is covered by demo-seed.spec.ts (the demo seed uses the same function).

const REPO_ROOT = path.resolve(__dirname, '../../..');

/** Runs a module snippet in the repository root; answers its exit status and output. */
function run(code: string, env: Record<string, string | undefined> = {}) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: REPO_ROOT,
    env: { PATH: process.env.PATH, ...env },
    encoding: 'utf8',
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

describe('the ops-data Stripe key guard', () => {
  // The key goes in through the environment, as the loader reads it, so the output can show
  // that the guard never prints it.
  const check = (key: string | undefined) =>
    run(
      `import { assertStripeTestKey } from './scripts/ops-data/guard.mjs';
       assertStripeTestKey(process.env.STRIPE_SECRET_KEY);
       console.log('allowed');`,
      { STRIPE_SECRET_KEY: key },
    );

  it('allows no key, a secret test key and a restricted test key', () => {
    expect(check(undefined).out).toContain('allowed');
    expect(check('').out).toContain('allowed');
    expect(check('sk_test_51abcdefgh').out).toContain('allowed');
    expect(check('rk_test_51abcdefgh').out).toContain('allowed');
  });

  it('refuses a live key or anything else, without printing it', () => {
    for (const key of [
      'sk_live_51abcdefgh',
      'rk_live_51abcdefgh',
      'pk_test_51abcdefgh',
      'not-a-stripe-key-123',
    ]) {
      const answer = check(key);
      expect(answer.status).not.toBe(0);
      expect(answer.out).toContain('not a Stripe test-mode key');
      expect(answer.out).not.toContain(key);
    }
  });
});

describe('the ops-data database marker guard', () => {
  /** The guard against a stand-in client whose database-level settings are `setconfig`. */
  const check = (setconfig: string[] | null) =>
    run(
      `import { assertDatabaseMarker } from './scripts/ops-data/guard.mjs';
       const db = { query: async (sql) => {
         if (!sql.includes('pg_db_role_setting') || !sql.includes('setrole = 0')) throw new Error('unexpected query');
         return { rows: ${JSON.stringify(setconfig)} === null ? [] : [{ setconfig: ${JSON.stringify(setconfig)} }] };
       } };
       await assertDatabaseMarker(db);
       console.log('allowed');`,
    );

  it('allows a database whose own settings carry mondapac.env = ops-test', () => {
    expect(check(['mondapac.env=ops-test']).out).toContain('allowed');
    expect(check(['search_path=catalog', 'mondapac.env=ops-test']).out).toContain('allowed');
  });

  it('refuses a database without the marker or with another value', () => {
    for (const setconfig of [
      null,
      [],
      ['search_path=catalog'],
      ['mondapac.env=production'],
      ['mondapac.env=ops-test-x'],
    ]) {
      const answer = check(setconfig);
      expect(answer.status).not.toBe(0);
      expect(answer.out).toContain('no operational test marker');
    }
  });
});

describe('the ops-data AU scenario', () => {
  it('names each category once, parents first, and links only known categories, sets and attributes', () => {
    const answer = run(`
      import { SCENARIO } from './scripts/ops-data/scenarios/AU/index.mjs';
      const { categories, attributes, featureSets, links, cultures } = SCENARIO.catalog;
      const problems = [];
      const seen = new Set();
      for (const c of categories) {
        if (seen.has(c.slug)) problems.push('slug repeated ' + c.slug);
        if (c.parent !== null && !seen.has(c.parent)) problems.push('parent after child ' + c.slug);
        if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(c.slug)) problems.push('bad slug ' + c.slug);
        seen.add(c.slug);
      }
      const codes = new Set(attributes.map((a) => a.code));
      if (codes.size !== attributes.length) problems.push('attribute code repeated');
      for (const set of featureSets) {
        const first = set.groups[0];
        if (first.groupCode !== 'core') problems.push(set.code + ': the first group is not core');
        for (const g of set.groups) for (const [code, level] of g.attributes) {
          if (!codes.has(code)) problems.push(set.code + ': unknown attribute ' + code);
          if (!['required', 'recommended', 'optional'].includes(level)) problems.push(set.code + ': bad level ' + level);
        }
      }
      const sets = new Set(featureSets.map((s) => s.code));
      for (const l of links) {
        const c = categories.find((x) => x.slug === l.category);
        if (!c || c.parent !== null) problems.push('link is not on a department ' + l.category);
        if (!sets.has(l.featureSet)) problems.push('unknown feature set ' + l.featureSet);
        for (const f of l.filters) {
          const a = attributes.find((x) => x.code === f);
          if (!a || !a.filter) problems.push(l.category + ': filter is not a filterable attribute ' + f);
        }
      }
      const departments = categories.filter((c) => c.parent === null).map((c) => c.slug);
      for (const d of departments) if (!links.some((l) => l.category === d)) problems.push('department without a feature set ' + d);
      if (cultures.filter((c) => c.isDefault).length !== 1) problems.push('not exactly one default culture');
      const words = /halal|kosher|vegan|organic|certified|authentic|official|verified/i;
      const texts = [...categories.map((c) => c.name), ...attributes.map((a) => a.name), ...cultures.map((c) => c.name + ' ' + c.description)];
      for (const t of texts) if (words.test(t)) problems.push('claim word in ' + t);
      console.log(problems.length === 0 ? 'ok' : problems.join('; '));
    `);
    expect(answer.out.trim()).toBe('ok');
  });

  it('has sellers in every onboarding state, each with a unique email, slug and valid ABN', () => {
    const answer = run(`
      import { SCENARIO } from './scripts/ops-data/scenarios/AU/index.mjs';
      const problems = [];
      const states = new Set(SCENARIO.sellers.map((s) => s.state));
      for (const state of ['approved', 'in-review', 'rejected', 'suspended', 'draft'])
        if (!states.has(state)) problems.push('no seller in state ' + state);
      for (const field of ['key', 'email', 'slug', 'abn', 'storeName'])
        if (new Set(SCENARIO.sellers.map((s) => s[field])).size !== SCENARIO.sellers.length) problems.push(field + ' repeated');
      const weights = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
      for (const s of SCENARIO.sellers) {
        const digits = s.abn.split('').map(Number);
        digits[0] -= 1;
        if (s.abn.length !== 11 || digits.reduce((sum, d, i) => sum + d * weights[i], 0) % 89 !== 0) problems.push('bad ABN ' + s.key);
        if (!s.email.endsWith('.example')) problems.push('email outside .example ' + s.key);
        if (s.state === 'rejected' && !s.rejection) problems.push('no rejection reason ' + s.key);
        if (s.state === 'suspended' && !s.suspension) problems.push('no suspension reason ' + s.key);
        if (s.certificate && s.certificate.expiryDate <= s.certificate.issueDate) problems.push('certificate dates ' + s.key);
      }
      console.log(problems.length === 0 ? 'ok' : problems.join('; '));
    `);
    expect(answer.out.trim()).toBe('ok');
  });

  it('puts products on level 3, sells them only through approved sellers, and shapes prices by variant', () => {
    const answer = run(`
      import { SCENARIO } from './scripts/ops-data/scenarios/AU/index.mjs';
      const problems = [];
      const bySlug = new Map(SCENARIO.catalog.categories.map((c) => [c.slug, c]));
      const level = (slug) => { let n = 1; let c = bySlug.get(slug); while (c.parent !== null) { c = bySlug.get(c.parent); n += 1; } return n; };
      const attributes = new Map(SCENARIO.catalog.attributes.map((a) => [a.code, a]));
      const keys = new Set();
      for (const p of SCENARIO.products) {
        if (keys.has(p.key)) problems.push('product repeated ' + p.key);
        keys.add(p.key);
        if (!bySlug.has(p.category)) { problems.push('unknown category ' + p.key); continue; }
        if (level(p.category) !== 3) problems.push('not on level 3 ' + p.key);
        if (!['gst_free', 'taxable'].includes(p.tax)) problems.push('tax ' + p.key);
        const storage = attributes.get('storage').options.map(([code]) => code);
        if (!storage.includes(p.storage)) problems.push('storage ' + p.key);
        if (p.variants !== null) {
          const options = attributes.get(p.variantAttribute).options.map(([code]) => code);
          for (const [option] of p.variants) if (!options.includes(option)) problems.push('option ' + p.key + ' ' + option);
        }
      }
      const approved = new Set(SCENARIO.sellers.filter((s) => s.state === 'approved').map((s) => s.key));
      for (const [seller, offers] of Object.entries(SCENARIO.offers)) {
        if (!approved.has(seller)) problems.push('offers of a seller that is not approved ' + seller);
        const listed = new Set();
        for (const o of offers) {
          const p = SCENARIO.products.find((x) => x.key === o.product);
          if (!p) { problems.push('unknown product ' + seller + ':' + o.product); continue; }
          if (listed.has(o.product)) problems.push('listed twice ' + seller + ':' + o.product);
          listed.add(o.product);
          const n = p.variants === null ? 1 : p.variants.length;
          for (const v of [o.price, o.stock, o.was]) {
            if (v === undefined) continue;
            const list = Array.isArray(v) ? v : [v];
            if (list.length !== n || !list.every((x) => Number.isInteger(x) && x > 0)) problems.push('shape ' + seller + ':' + o.product);
          }
          if (o.was !== undefined) {
            const was = Array.isArray(o.was) ? o.was : [o.was];
            const price = Array.isArray(o.price) ? o.price : [o.price];
            if (was.some((x, i) => x <= price[i])) problems.push('was not above price ' + seller + ':' + o.product);
          }
        }
      }
      const held = SCENARIO.offers[SCENARIO.held.seller]?.find((o) => o.product === SCENARIO.held.product);
      if (!held || SCENARIO.held.amount <= held.price) problems.push('held price');
      const words = /halal|halaal|kosher|vegan|organic|certified|authentic|official|verified/i;
      const texts = [
        ...SCENARIO.sellers.flatMap((s) => [s.storeName, s.businessName, s.about]),
        ...SCENARIO.products.flatMap((p) => [p.name, p.short, p.text, p.brand]),
      ];
      for (const t of texts) if (words.test(t)) problems.push('claim word in ' + t);
      console.log(problems.length === 0 ? 'ok' : problems.join('; '));
    `);
    expect(answer.out.trim()).toBe('ok');
  });

  it('carries no claim term of the seeded vocabulary in any text, as the claim matcher reads it', () => {
    // Catalog and sellers run every text through the claim matcher with the Market's whole
    // vocabulary, inactive types included, and its compact pass finds a term across word breaks
    // ("prepare every" holds "pareve"). A hit stops the loader halfway, so every string of the
    // scenario is checked here with the same matcher and the seeded terms.
    const seed = JSON.parse(
      readFileSync(path.join(REPO_ROOT, 'config/certification-seed/AU.json'), 'utf8'),
    ) as {
      types: { code: string; locales: Record<string, { claimTerms: string[] }> }[];
    };
    const vocabulary = prepareVocabulary(
      seed.types.map((type) => ({
        typeCode: type.code as never,
        terms: Object.values(type.locales).flatMap((locale) => locale.claimTerms),
      })),
    );
    // Keys whose values are codes, not text a buyer reads: a certificate's type names the claim
    // through a certificate, which is the allowed way.
    const answer = run(`
      import { SCENARIO } from './scripts/ops-data/scenarios/AU/index.mjs';
      const out = [];
      const walk = (value, at) => {
        if (typeof value === 'string') out.push([at, value]);
        else if (Array.isArray(value)) value.forEach((v, i) => walk(v, at + '[' + i + ']'));
        else if (value !== null && typeof value === 'object')
          for (const [k, v] of Object.entries(value)) walk(v, at + '.' + k);
      };
      walk(SCENARIO, 'scenario');
      console.log(JSON.stringify(out));
    `);
    const strings = JSON.parse(answer.out) as [string, string][];
    expect(strings.length).toBeGreaterThan(100);
    const allowed = new Set(Object.values(seed.types).map((type) => type.code));
    const hits: string[] = [];
    for (let i = 0; i < strings.length; i += 100) {
      const batch = strings.slice(i, i + 100);
      matchClaimTerms(
        batch.map(([, text]) => text),
        vocabulary,
      ).forEach((matches, j) => {
        const [at, text] = batch[j]!;
        if (matches.length > 0 && !allowed.has(text)) {
          hits.push(`${at}: ${matches.map((m) => `${m.typeCode}/${m.pass}`).join(',')}`);
        }
      });
    }
    expect(hits).toEqual([]);
  });

  it('builds content and the blog on known categories, products and photos, within the editor limits, with no claim word', () => {
    const answer = run(`
      import { existsSync } from 'node:fs';
      import { SCENARIO } from './scripts/ops-data/scenarios/AU/index.mjs';
      const { slides, home, navigation, pages } = SCENARIO.content;
      const slugs = new Set(SCENARIO.catalog.categories.map((c) => c.slug));
      const departments = SCENARIO.catalog.categories.filter((c) => c.parent === null).map((c) => c.slug);
      const problems = [];
      const known = (slug, where) => { if (!slugs.has(slug)) problems.push(where + ': unknown category ' + slug); };
      const keys = new Set();
      const perPosition = {};
      for (const s of slides) {
        if (keys.has(s.key)) problems.push('slide key repeated ' + s.key);
        keys.add(s.key);
        if (!['announcement', 'promotion', 'link'].includes(s.kind)) problems.push(s.key + ': bad kind');
        if (s.kind === 'link' && s.link === undefined) problems.push(s.key + ': a link slide without a link');
        if (s.ctaLabel !== undefined && s.link === undefined) problems.push(s.key + ': a button without a link');
        if (s.title.length > 60 || (s.body ?? '').length > 160 || (s.ctaLabel ?? '').length > 24) problems.push(s.key + ': too long');
        if (s.link !== undefined) known(s.link, s.key);
        if (s.scope !== undefined) known(s.scope, s.key);
        if (s.autoplay && !['home.hero', 'landing.top'].includes(s.position)) problems.push(s.key + ': autoplay not allowed here');
        if (s.image !== undefined && !existsSync('apps/web/public/placeholders/' + s.image + '.jpg')) problems.push(s.key + ': no photo ' + s.image);
        perPosition[s.position + '|' + (s.scope ?? '')] = (perPosition[s.position + '|' + (s.scope ?? '')] ?? 0) + 1;
      }
      const max = { 'home.hero': 8, 'home.mid': 4, 'category.top': 4 };
      for (const [key, n] of Object.entries(perPosition)) if (n > (max[key.split('|')[0]] ?? 0)) problems.push('too many slides at ' + key);
      if ((home.main ?? []).length < 1) problems.push('the home page main slot is empty');
      for (const slug of [...navigation.popular, ...navigation.departments]) known(slug, 'navigation');
      if (JSON.stringify(navigation.departments) !== JSON.stringify(departments)) problems.push('the drawer does not list every department in order');
      const { blog } = SCENARIO.content;
      const blogCategories = new Set(blog.categories.map((c) => c.slug));
      const sold = new Set(Object.values(SCENARIO.offers).flat().map((o) => o.product));
      for (const post of blog.posts) {
        if (!['news', 'product'].includes(post.kind)) problems.push(post.slug + ': kind the loader does not fill');
        if (!blogCategories.has(post.category)) problems.push(post.slug + ': unknown blog category');
        if (post.title.length > 120 || post.excerpt.length > 160 || !post.coverAlt) problems.push(post.slug + ': title, excerpt or cover text');
        if (!existsSync('apps/web/public/placeholders/' + post.cover + '.jpg')) problems.push(post.slug + ': no photo ' + post.cover);
        const cards = post.body.filter((b) => b.type === 'product_cards').flatMap((b) => b.products);
        if (post.kind === 'product' && cards.length === 0) problems.push(post.slug + ': a product post without products');
        for (const key of cards) if (!sold.has(key)) problems.push(post.slug + ': not on sale ' + key);
        for (const b of post.body) if (b.type === 'seller_card' && !SCENARIO.sellers.some((x) => x.key === b.seller && x.state === 'approved')) problems.push(post.slug + ': not an approved seller ' + b.seller);
      }
      if (!blog.posts.some((post) => post.slug === blog.featured)) problems.push('the featured post is not in the blog');
      if (blogCategories.size !== blog.categories.length) problems.push('blog category slug repeated');
      if (new Set(blog.posts.map((post) => post.slug)).size !== blog.posts.length) problems.push('post slug repeated');
      for (const r of navigation.rail) {
        if (r.label.length > 40) problems.push('rail label too long ' + r.label);
        if (!['system-page', 'category', 'page', 'path'].includes(r.target.kind)) problems.push('bad rail target ' + r.label);
      }
      const pageSlugs = new Set(pages.map((p) => p.slug));
      if (pageSlugs.size !== pages.length) problems.push('page slug repeated');
      const words = /halal|halaal|kosher|vegan|organic|authentic|official|verified/i;
      const texts = [
        ...slides.flatMap((s) => [s.title, s.body ?? '', s.ctaLabel ?? '']),
        ...Object.values(home).flat().map((m) => JSON.stringify(m.config)),
        ...navigation.rail.map((r) => r.label),
        ...pages.map((p) => p.title + ' ' + JSON.stringify(p.blocks)),
        ...blog.posts.map((post) => post.title + ' ' + post.excerpt + ' ' + JSON.stringify(post.body)),
      ];
      for (const t of texts) if (words.test(t)) problems.push('claim word in ' + t);
      console.log(problems.length === 0 ? 'ok' : problems.join('; '));
    `);
    expect(answer.out.trim()).toBe('ok');
  });
});

describe('the ops-data orders pack: Stripe test mode and the replayed webhook', () => {
  it('signs a replayed event the way the API verifies Stripe', () => {
    const at = 1_795_000_000;
    const secret = 'whsec_spec0ops0data0au';
    const body = '{"id":"evt_1","type":"payment_intent.amount_capturable_updated"}';
    const answer = run(
      `import { signatureFor } from './scripts/ops-data/stripe.mjs';
       console.log(signatureFor(process.env.SECRET, process.env.BODY, ${at}));`,
      { SECRET: secret, BODY: body },
    );
    const header = answer.out.trim();
    const verifier = new StripeWebhookSignature(
      { AU: secret },
      new FixedClock(Temporal.Instant.fromEpochMilliseconds(at * 1000)),
    );
    expect(verifier.verify('AU', Buffer.from(body), header)).toBe('platform');
    expect(verifier.verify('AU', Buffer.from(`${body} `), header)).toBeNull();
  });

  it("reads the Market's secret in the API's formats and names no secret when it has none", () => {
    const answer = run(`
      import { webhookSecretOf } from './scripts/ops-data/stripe.mjs';
      const out = [];
      out.push(webhookSecretOf('whsec_bare0secret0value', 'AU'));
      out.push(webhookSecretOf('NZ=whsec_nz0secret0value,AU=whsec_au0secret0value', 'AU'));
      for (const value of [undefined, '', 'NZ=whsec_nz0secret0value', 'sk_test_notawebhooksecret']) {
        try { webhookSecretOf(value, 'AU'); out.push('allowed'); } catch (e) { out.push(e.message.includes('no signing secret') && !String(e.message).includes('whsec_nz') ? 'refused' : 'leaked'); }
      }
      console.log(JSON.stringify(out));
    `);
    expect(JSON.parse(answer.out.trim())).toEqual([
      'whsec_bare0secret0value',
      'whsec_au0secret0value',
      'refused',
      'refused',
      'refused',
      'refused',
    ]);
  });

  it('refuses a live or missing Stripe key before any call, without printing it', () => {
    for (const key of ['sk_live_51abcdefgh', 'rk_live_51abcdefgh', '']) {
      const answer = run(
        `import { StripeTestMode } from './scripts/ops-data/stripe.mjs';
         globalThis.fetch = () => { console.log('called Stripe'); process.exit(3); };
         new StripeTestMode(process.env.STRIPE_SECRET_KEY, 'AU');
         console.log('allowed');`,
        { STRIPE_SECRET_KEY: key },
      );
      expect(answer.status).not.toBe(0);
      expect(answer.out).not.toContain('allowed');
      expect(answer.out).not.toContain('called Stripe');
      if (key !== '') expect(answer.out).not.toContain(key);
    }
  });

  it('makes tokens only from Stripe test payment methods and refuses a live-mode answer', () => {
    const answer = run(`
      import { StripeTestMode } from './scripts/ops-data/stripe.mjs';
      const stripe = new StripeTestMode('sk_test_51abcdefgh', 'AU');
      const out = [];
      globalThis.fetch = async (url, init) => ({
        ok: true, status: 200,
        json: async () => ({ object: 'confirmation_token', id: 'ctoken_1', livemode: process.env.LIVE === '1' }),
      });
      try { await stripe.confirmationToken('4242424242424242'); out.push('allowed'); } catch { out.push('refused'); }
      out.push(await stripe.confirmationToken('pm_card_visa'));
      console.log(JSON.stringify(out));
    `);
    expect(JSON.parse(answer.out.trim())).toEqual(['refused', 'ctoken_1']);
    const live = run(
      `import { StripeTestMode } from './scripts/ops-data/stripe.mjs';
       globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ object: 'confirmation_token', id: 'ctoken_1', livemode: true }) });
       await new StripeTestMode('sk_test_51abcdefgh', 'AU').confirmationToken('pm_card_visa');
       console.log('allowed');`,
    );
    expect(live.status).not.toBe(0);
    expect(live.out).toContain('not a test-mode one');
  });

  it("replays only the events of the loader's own PaymentIntent, platform events only", () => {
    const answer = run(`
      import { StripeTestMode } from './scripts/ops-data/stripe.mjs';
      const stripe = new StripeTestMode('sk_test_51abcdefgh', 'AU');
      const events = [
        { id: 'evt_a', created: 2, livemode: false, type: 'payment_intent.amount_capturable_updated', data: { object: { id: 'pi_mine' } } },
        { id: 'evt_b', created: 1, livemode: false, type: 'payment_intent.amount_capturable_updated', data: { object: { id: 'pi_other' } } },
        { id: 'evt_c', created: 3, livemode: false, account: 'acct_1', type: 'payment_intent.amount_capturable_updated', data: { object: { id: 'pi_mine' } } },
      ];
      globalThis.fetch = async (url) => ({ ok: true, status: 200, json: async () => ({ data: String(url).includes('amount_capturable_updated') ? events : [] }) });
      const found = await stripe.eventsOf('pi_mine', 0, { seconds: 0 });
      const out = [found.map((e) => e.id)];
      try { await stripe.eventsOf('pi_mine', NaN, { seconds: 0 }); out.push('allowed'); } catch { out.push('refused'); }
      console.log(JSON.stringify(out));
    `);
    expect(JSON.parse(answer.out.trim())).toEqual([['evt_a'], 'refused']);
  });

  it('follows every page of events, and replays nothing for a PaymentIntent of another order', () => {
    const answer = run(`
      import { StripeTestMode } from './scripts/ops-data/stripe.mjs';
      const stripe = new StripeTestMode('sk_test_51abcdefgh', 'AU');
      const urls = [];
      globalThis.fetch = async (url) => {
        urls.push(String(url));
        const u = new URL(url);
        if (u.pathname.startsWith('/v1/payment_intents/')) {
          return { ok: true, status: 200, json: async () => ({ id: 'pi_mine', livemode: false, metadata: { order_id: 'o-1', market_id: 'AU', payment_flow: 'card-intent' } }) };
        }
        const second = u.searchParams.get('starting_after') === 'evt_x';
        const page = second
          ? { has_more: false, data: [{ id: 'evt_mine', created: 1, livemode: false, data: { object: { id: 'pi_mine' } } }] }
          : { has_more: true, data: [{ id: 'evt_x', created: 2, livemode: false, data: { object: { id: 'pi_other' } } }] };
        return { ok: true, status: 200, json: async () => (u.searchParams.get('type') === 'payment_intent.amount_capturable_updated' ? page : { has_more: false, data: [] }) };
      };
      const out = [];
      out.push((await stripe.eventsOf('pi_mine', 0, { seconds: 0 })).map((e) => e.id));
      await stripe.assertOwnPaymentIntent('pi_mine', 'o-1');
      out.push('own');
      for (const [order, market] of [['o-2', 'AU'], ['o-1', 'NZ']]) {
        try { await new StripeTestMode('sk_test_51abcdefgh', market).assertOwnPaymentIntent('pi_mine', order); out.push('allowed'); } catch { out.push('refused'); }
      }
      console.log(JSON.stringify(out));
    `);
    expect(JSON.parse(answer.out.trim())).toEqual([['evt_mine'], 'own', 'refused', 'refused']);
  });
});

describe('the ops-data AU buyers and orders', () => {
  it('uses fictional buyers, sells only what approved stores list, meets each minimum and stays within stock', () => {
    const answer = run(`
      import { SCENARIO } from './scripts/ops-data/scenarios/AU/index.mjs';
      const problems = [];
      const buyers = new Map();
      for (const b of SCENARIO.buyers) {
        if (buyers.has(b.key)) problems.push('buyer repeated ' + b.key);
        buyers.set(b.key, b);
        if (!/^[a-z.]+@buyers\\.example$/.test(b.email)) problems.push('email ' + b.email);
        if (!/^0755502\\d{3}$/.test(b.phone)) problems.push('phone ' + b.key);
        for (const a of b.addresses) {
          const n = Number(a.postcode);
          if (!(n >= 4000 && n <= 4199)) problems.push('outside Greater Brisbane ' + b.key);
        }
      }
      if (new Set(SCENARIO.buyers.map((b) => b.email)).size !== SCENARIO.buyers.length) problems.push('email repeated');
      if (new Set(SCENARIO.buyers.map((b) => b.phone)).size !== SCENARIO.buyers.length) problems.push('phone repeated');
      const approved = new Map(SCENARIO.sellers.filter((s) => s.state === 'approved').map((s) => [s.key, s]));
      const used = new Map();
      const list = (v) => (Array.isArray(v) ? v : [v]);
      const check = (where, lines, counts, minimums = true) => {
        const subtotal = new Map();
        for (const [store, product, quantity, variant = 0] of lines) {
          if (!approved.has(store)) { problems.push(where + ': store not approved ' + store); continue; }
          const offer = (SCENARIO.offers[store] ?? []).find((o) => o.product === product);
          if (!offer) { problems.push(where + ': ' + store + ' does not sell ' + product); continue; }
          const price = list(offer.price)[variant];
          if (price === undefined) { problems.push(where + ': no variant ' + variant + ' of ' + product); continue; }
          if (!Number.isInteger(quantity) || quantity < 1 || quantity > 5) problems.push(where + ': quantity ' + product);
          subtotal.set(store, (subtotal.get(store) ?? 0) + price * quantity);
          if (counts) used.set(store + ':' + product + ':' + variant, (used.get(store + ':' + product + ':' + variant) ?? 0) + quantity);
        }
        for (const [store, amount] of subtotal) {
          if (!minimums) continue;
          const minimum = approved.get(store)?.minimum ?? 0;
          if (amount < minimum) problems.push(where + ': below the minimum of ' + store);
        }
      };
      const outcomes = { paid: 'card', ready: 'card', collected: 'card', refunded: 'card', cancelled: 'card', declined: 'declined', 'requires-action': '3ds' };
      const keys = new Set();
      for (const o of SCENARIO.orders) {
        if (keys.has(o.key)) problems.push('order repeated ' + o.key);
        keys.add(o.key);
        const b = buyers.get(o.buyer);
        if (!b) { problems.push(o.key + ': unknown buyer'); continue; }
        if (!(o.outcome in outcomes)) problems.push(o.key + ': outcome ' + o.outcome);
        const card = SCENARIO.cards[o.card];
        if (!/^pm_card_[a-zA-Z]+$/.test(card ?? '')) problems.push(o.key + ': card ' + o.card);
        const wanted = outcomes[o.outcome];
        if (wanted === 'card' ? ['declined', '3ds'].includes(o.card) : o.card !== wanted) problems.push(o.key + ': card does not fit the outcome');
        if ((o.address ?? 0) >= b.addresses.length) problems.push(o.key + ': unknown address');
        for (const store of Object.keys(o.notes ?? {})) if (!o.lines.some(([s]) => s === store)) problems.push(o.key + ': note to a store not in the order');
        // A declined card or a 3D Secure wait holds no stock for long; every other order commits it.
        check(o.key, o.lines, !['declined', 'requires-action'].includes(o.outcome));
      }
      for (const [key, quantity] of used) {
        const [store, product, variant] = key.split(':');
        const offer = SCENARIO.offers[store].find((o) => o.product === product);
        if (quantity > list(offer.stock)[Number(variant)]) problems.push('more sold than in stock ' + key);
      }
      for (const outcome of Object.keys(outcomes)) if (!SCENARIO.orders.some((o) => o.outcome === outcome)) problems.push('no order ' + outcome);
      for (const c of SCENARIO.openCarts) {
        if (!buyers.has(c.buyer)) problems.push('open cart of unknown buyer ' + c.buyer);
        // An open cart may sit below a store's minimum: the cart page shows how much to add.
        check('cart ' + c.buyer, c.lines, false, false);
      }
      if (new Set(SCENARIO.openCarts.map((c) => c.buyer)).size !== SCENARIO.openCarts.length) problems.push('two open carts for one buyer');
      console.log(problems.length === 0 ? 'ok' : problems.join('; '));
    `);
    expect(answer.out.trim()).toBe('ok');
  });
});
