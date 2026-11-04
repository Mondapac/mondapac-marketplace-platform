import { LoadError } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { AttributesView } from '../../../../src/attributes/attributes-view.tsx';
import {
  BRANDS_READ_PERMISSION,
  DECIDE_PERMISSION,
  EDIT_PERMISSION,
  TABS,
  VIEW_PERMISSION,
  type Tab,
} from '../../../../src/attributes/types.ts';
import { AdminShell } from '../../../../src/server/admin-shell.tsx';
import { requireSession } from '../../../../src/server/session.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('attributes.title') };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const one = (value: string | readonly string[] | undefined): string | undefined =>
  typeof value === 'string' ? value : undefined;

/**
 * Catalogue > Attributes (attributes plan, packages A1 and A2): the attributes and feature sets of
 * the Market; an admin with `catalog.attribute.edit` adds and edits attributes. `?tab=` opens a tab and `?id=` an attribute or a feature set, so a link can
 * point at one. The Brands tab is the existing brands page.
 */
export default async function AttributesPage({
  searchParams,
}: {
  readonly searchParams?: Promise<{
    readonly tab?: string | readonly string[];
    readonly id?: string | readonly string[];
  }>;
}) {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const query = (await searchParams) ?? {};
  const rawTab = one(query.tab);
  const tab: Tab =
    rawTab !== undefined && (TABS as readonly string[]).includes(rawTab) && rawTab !== 'brands'
      ? (rawTab as Tab)
      : 'attributes';
  const rawId = one(query.id);
  const selectedId = rawId !== undefined && UUID.test(rawId) ? rawId : null;
  const title = t('attributes.title');
  const { permissionKeys, csrfToken } = gate.session;
  return (
    <AdminShell session={gate.session} activeId="attributes" title={title}>
      <h1 className="text-2xl font-semibold">{title}</h1>
      {permissionKeys.includes(VIEW_PERMISSION) ? (
        <AttributesView
          canEdit={permissionKeys.includes(EDIT_PERMISSION)}
          csrfToken={csrfToken}
          canSeeBrands={permissionKeys.includes(BRANDS_READ_PERMISSION)}
          canDecide={permissionKeys.includes(DECIDE_PERMISSION)}
          initialTab={tab}
          initialId={selectedId}
        />
      ) : (
        <>
          <p className="mt-4 text-fg-muted">{t('attributes.no-access')}</p>
          <p className="mt-4">
            <a className="font-medium text-link underline" href="/">
              {t('attributes.back-home')}
            </a>
          </p>
        </>
      )}
    </AdminShell>
  );
}
