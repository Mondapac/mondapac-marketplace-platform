// Pack "catalog": the catalog structure of the scenario, built through the admin API the admin
// panel uses (operational test data design, phase 2 PR 1): categories, attributes (created and
// published), feature sets, each department's feature set and buyer filters, and cultures. The
// catalog seed jobs are switched off in this environment (CATALOG_SEED_JOBS_OFF), so nothing here
// comes from config/catalog-seed. A rerun creates only what is missing and changes nothing else.

/** Every catalogue write in a reviewed Market carries a note (Admin Inbox, reviewed after). */
const NOTE = 'Operational test data (scripts/ops-data)';

/**
 * A write that waits for a second admin's approval answers 202 with the request it filed
 * (Admin Inbox › System requests): nothing changed yet. The request is collected; the run
 * approves it as the reviewer admin when the scenario has one, else it stops and says which
 * requests wait.
 */
function filed(answer, pending, label) {
  if (answer.status === 202) {
    pending.push({ label, request: answer.body.request });
    return true;
  }
  // An earlier run filed the same change and it still waits: settle it rather than file twice.
  if (answer.status === 409 && answer.body?.code === 'system-requests.already-pending') {
    pending.push({ label, request: { id: null, number: answer.body.details.pendingNumber } });
    return true;
  }
  return false;
}

async function write(admin, method, path, body, pending, label) {
  const answer = await admin.request(method, path, body);
  if (filed(answer, pending, label)) return null;
  if (answer.status < 200 || answer.status > 299) {
    throw new Error(
      `${method} ${path} (${label}) -> ${answer.status} ${JSON.stringify(answer.body).slice(0, 400)}`,
    );
  }
  return answer.body;
}

async function ensureCategories(admin, scenario, log) {
  const { locale } = scenario;
  let tree = await admin.ok('GET', '/catalog/admin/categories');
  let treeVersion = tree.treeVersion;
  const idBySlug = new Map(tree.categories.map((row) => [row.slug, row.id]));
  let made = 0;
  for (const category of scenario.catalog.categories) {
    if (idBySlug.has(category.slug)) continue;
    const parentId = category.parent === null ? null : idBySlug.get(category.parent);
    if (parentId === undefined)
      throw new Error(`category ${category.slug}: parent ${category.parent} is missing`);
    const answer = await admin.request('POST', '/catalog/admin/categories', {
      parentId,
      slug: category.slug,
      texts: { [locale]: { name: category.name } },
      treeVersion,
      note: NOTE,
    });
    if (answer.status === 409 && answer.body?.code === 'conflict.stale') {
      // Another admin (or a panel tab) changed the tree: read it again and retry once.
      tree = await admin.ok('GET', '/catalog/admin/categories');
      treeVersion = tree.treeVersion;
      for (const row of tree.categories) idBySlug.set(row.slug, row.id);
      if (idBySlug.has(category.slug)) continue;
      const again = await admin.ok('POST', '/catalog/admin/categories', {
        parentId,
        slug: category.slug,
        texts: { [locale]: { name: category.name } },
        treeVersion,
        note: NOTE,
      });
      idBySlug.set(category.slug, again.category.id);
      treeVersion = again.category.treeVersion;
    } else if (answer.status >= 200 && answer.status < 300) {
      idBySlug.set(category.slug, answer.body.category.id);
      treeVersion = answer.body.category.treeVersion;
    } else {
      throw new Error(
        `POST /catalog/admin/categories (${category.slug}) -> ${answer.status} ${JSON.stringify(answer.body).slice(0, 400)}`,
      );
    }
    made += 1;
  }
  log(`  ${scenario.catalog.categories.length} categories (${made} new)`);
  return idBySlug;
}

/** Every attribute of the Market by code, page by page. */
async function attributesByCode(admin) {
  const byCode = new Map();
  for (let page = 1; ; page += 1) {
    const list = await admin.ok('GET', `/catalog/admin/attributes?page=${page}&pageSize=100`);
    for (const item of list.items) byCode.set(item.code, item);
    if (!list.hasNext) return byCode;
  }
}

async function ensureAttributes(admin, scenario, log) {
  const { locale } = scenario;
  let byCode = await attributesByCode(admin);
  let made = 0;
  let published = 0;
  for (const attribute of scenario.catalog.attributes) {
    let row = byCode.get(attribute.code);
    if (row === undefined) {
      const created = await admin.ok('POST', '/catalog/admin/attributes', {
        code: attribute.code,
        dataType: attribute.dataType,
        names: { [locale]: attribute.name },
        localizable: attribute.localizable,
        isVariantOption: attribute.isVariantOption,
        canBeFilter: attribute.filter,
        bounds: attribute.bounds,
        ...(attribute.options.length > 0
          ? {
              options: attribute.options.map(([code, label]) => ({
                code,
                labels: { [locale]: label },
              })),
            }
          : {}),
        note: NOTE,
      });
      row = created.attribute;
      made += 1;
    }
    if (row.status === 'draft') {
      await admin.ok('POST', `/catalog/admin/attributes/${row.id}/publish`, {
        version: row.version,
      });
      published += 1;
    }
  }
  if (made > 0 || published > 0) byCode = await attributesByCode(admin);
  log(`  ${scenario.catalog.attributes.length} attributes (${made} new, ${published} published)`);
  return byCode;
}

/**
 * Approves the requests the writes filed, as the reviewer admin (maker-checker: the author never
 * approves their own). Without a reviewer the run stops and names the requests that wait.
 */
async function settle(reviewer, pending, log) {
  if (pending.length === 0) return;
  if (reviewer === null) {
    const list = pending.map((item) => `SR-${item.request.number} (${item.label})`).join(', ');
    throw new Error(
      `These catalogue changes wait for a second admin's approval: ${list}. ` +
        'The scenario has no reviewer admin yet, so the loader cannot approve them.',
    );
  }
  for (const item of pending.splice(0)) {
    if (item.request.id === null)
      item.request.id = await requestIdOf(reviewer, item.request.number);
    await reviewer.ok('POST', `/system-requests/admin/requests/${item.request.id}/approve`, {});
    log(`  approved SR-${item.request.number} (${item.label}) as the reviewer`);
  }
}

/** The id of an open request by its number (SR-n), from the reviewer's queue. */
async function requestIdOf(reviewer, number) {
  const list = await reviewer.ok('GET', '/system-requests/admin/requests?status=open&pageSize=100');
  const row = list.rows.find((item) => item.number === number);
  if (row === undefined) throw new Error(`SR-${number} is not in the open requests`);
  return row.id;
}

async function featureSetIdsByCode(admin) {
  const list = await admin.ok('GET', '/catalog/admin/feature-sets');
  return new Map(list.items.map((item) => [item.code, item.id]));
}

async function ensureFeatureSets(admin, reviewer, scenario, log) {
  const { locale } = scenario;
  const existing = await featureSetIdsByCode(admin);
  const pending = [];
  let made = 0;
  for (const set of scenario.catalog.featureSets) {
    if (existing.has(set.code)) continue;
    await write(
      admin,
      'POST',
      '/catalog/admin/feature-sets',
      {
        code: set.code,
        names: { [locale]: set.name },
        groups: set.groups.map((group) => ({
          groupCode: group.groupCode,
          names: { [locale]: group.name },
          attributes: group.attributes.map(([code, level]) => ({ code, level })),
        })),
        note: NOTE,
      },
      pending,
      `feature set ${set.code}`,
    );
    made += 1;
  }
  await settle(reviewer, pending, log);
  log(`  ${scenario.catalog.featureSets.length} feature sets (${made} new)`);
  return featureSetIdsByCode(admin);
}

async function ensureLinks(admin, reviewer, scenario, categoryIds, featureSetIds, log) {
  const pending = [];
  let made = 0;
  for (const link of scenario.catalog.links) {
    const categoryId = categoryIds.get(link.category);
    const featureSetId = featureSetIds.get(link.featureSet);
    if (featureSetId === undefined) throw new Error(`feature set ${link.featureSet} is missing`);
    const path = `/catalog/admin/categories/${categoryId}/attribute-links`;
    const current = await admin.ok('GET', path);
    const same =
      current.featureSetId === featureSetId &&
      JSON.stringify(current.filters ?? []) === JSON.stringify(link.filters);
    if (same) continue;
    await write(
      admin,
      'PUT',
      path,
      {
        featureSetId,
        filters: link.filters,
        ...(typeof current.version === 'number' ? { version: current.version } : {}),
        note: NOTE,
      },
      pending,
      `links of ${link.category}`,
    );
    made += 1;
  }
  await settle(reviewer, pending, log);
  log(`  ${scenario.catalog.links.length} department links (${made} set)`);
}

async function ensureCultures(admin, reviewer, scenario, log) {
  const { locale } = scenario;
  const byCode = async () =>
    new Map((await admin.ok('GET', '/catalog/admin/cultures')).items.map((row) => [row.code, row]));
  let rows = await byCode();
  const pending = [];
  let made = 0;
  for (const culture of scenario.catalog.cultures) {
    if (rows.has(culture.code)) continue;
    await write(
      admin,
      'POST',
      '/catalog/admin/cultures',
      {
        code: culture.code,
        names: { [locale]: { name: culture.name, description: culture.description } },
        displayOrder: culture.displayOrder,
        requiredCertificationType: culture.requiredCertificationType,
      },
      pending,
      `culture ${culture.code}`,
    );
    made += 1;
  }
  await settle(reviewer, pending, log);
  rows = await byCode();
  for (const culture of scenario.catalog.cultures) {
    let row = rows.get(culture.code);
    if (row === undefined) throw new Error(`culture ${culture.code} is missing`);
    if (row.status === 'draft') {
      await write(
        admin,
        'PATCH',
        `/catalog/admin/cultures/${row.id}`,
        { version: row.version, status: 'active' },
        pending,
        `activate culture ${culture.code}`,
      );
      await settle(reviewer, pending, log);
      row = (await byCode()).get(culture.code);
    }
    if (culture.isDefault && row.isDefault !== true) {
      await write(
        admin,
        'PATCH',
        `/catalog/admin/cultures/${row.id}`,
        { version: row.version, isDefault: true },
        pending,
        `default culture ${culture.code}`,
      );
      await settle(reviewer, pending, log);
    }
  }
  log(`  ${scenario.catalog.cultures.length} cultures (${made} new)`);
}

/**
 * Builds the scenario's catalog structure. `reviewer` is a second admin's session that approves
 * what waits for approval, or null.
 */
export async function catalogPack({ admin, reviewer = null, scenario, log }) {
  const categoryIds = await ensureCategories(admin, scenario, log);
  await ensureAttributes(admin, scenario, log);
  const featureSetIds = await ensureFeatureSets(admin, reviewer, scenario, log);
  await ensureLinks(admin, reviewer, scenario, categoryIds, featureSetIds, log);
  await ensureCultures(admin, reviewer, scenario, log);
}
