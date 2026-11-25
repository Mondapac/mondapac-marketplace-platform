import { LoadError, NoAccess, SettingsPage } from '@mondapac/ui';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { CategoryFlags } from '../../../../../src/offer-review/category-flags.tsx';
import {
  ALWAYS_REVIEW_PERMISSION,
  CATEGORY_FLAGS_PATH,
  CATEGORY_VIEW_PERMISSION,
  REVIEW_STOP_PERMISSION,
  flaggedCategoriesOf,
  type CategoryChoice,
} from '../../../../../src/offer-review/category-flags-types.ts';
import { nameOf } from '../../../../../src/categories/tree-model.ts';
import { API_CATEGORIES, type TreeBody } from '../../../../../src/categories/types.ts';
import { serverGet } from '../../../../../src/server/server-fetch.ts';
import { requireSession } from '../../../../../src/server/session.ts';
import { SettingsShell } from '../../../../../src/server/settings-shell.tsx';
import { localZone } from '../../../../../src/shared/format.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('offer-review.categories.title') };
}

/** Settings › Catalogue › Offer review › Categories: the category flags (R7 and R0). */
export default async function OfferReviewCategoriesPage() {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const title = t('offer-review.categories.title');
  const { permissionKeys, csrfToken } = gate.session;
  const shell = (body: React.ReactNode) => (
    <SettingsShell session={gate.session} linkId="offer-review" title={title}>
      {body}
    </SettingsShell>
  );
  if (!permissionKeys.includes(CATEGORY_VIEW_PERMISSION)) {
    return shell(
      <NoAccess
        title={t('settings.no-access-title')}
        body={t('settings.no-access-needs', {
          page: title,
          permission: CATEGORY_VIEW_PERMISSION,
        })}
        backHref="/"
        backLabel={t('settings.back-home')}
      />,
    );
  }
  const [flags, tree] = await Promise.all([
    serverGet<unknown>(CATEGORY_FLAGS_PATH),
    serverGet<TreeBody>(API_CATEGORIES),
  ]);
  if (flags.kind === 'signed-out' || tree.kind === 'signed-out') redirect('/session-ended');
  const items = flags.kind === 'ok' ? flaggedCategoriesOf(flags.body) : null;
  if (items === null) {
    return shell(
      <SettingsPage title={title}>
        <LoadError
          message={t('offer-review.categories.load-failed')}
          retryLabel={t('load.retry')}
          className="flex flex-col items-start gap-3"
        />
      </SettingsPage>,
    );
  }
  // The picker names every live category by its path; a tree that cannot be read leaves the
  // listed categories unnamed and the picker empty.
  const rows = tree.kind === 'ok' ? tree.body.categories : [];
  const locale = tree.kind === 'ok' ? tree.body.defaultLocale : 'en';
  const byId = new Map(rows.map((row) => [row.id, row]));
  const pathOf = (id: string): string => {
    const parts: string[] = [];
    for (let row = byId.get(id); row !== undefined; row = byId.get(row.parentId ?? '')) {
      parts.unshift(nameOf(row, locale));
      if (parts.length > 8) break;
    }
    return parts.join(' > ');
  };
  const choices: CategoryChoice[] = rows
    .filter((row) => row.status === 'active' || row.status === 'hidden')
    .map((row) => ({ id: row.id, label: pathOf(row.id) }))
    .sort((a, b) => a.label.localeCompare(b.label));
  // A listed category that is no longer live still needs its name.
  for (const item of items) {
    if (!choices.some((choice) => choice.id === item.categoryId) && byId.has(item.categoryId)) {
      choices.push({ id: item.categoryId, label: pathOf(item.categoryId) });
    }
  }
  return shell(
    <SettingsPage title={title}>
      <CategoryFlags
        initial={items}
        choices={choices}
        canAlways={permissionKeys.includes(ALWAYS_REVIEW_PERMISSION)}
        canStop={permissionKeys.includes(REVIEW_STOP_PERMISSION)}
        csrfToken={csrfToken}
        zone={localZone(gate.session.timezone, gate.session.marketTimezone)}
      />
    </SettingsPage>,
  );
}
