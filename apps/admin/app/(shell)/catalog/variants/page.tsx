import { LoadError } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { AdminShell } from '../../../../src/server/admin-shell.tsx';
import { requireSession } from '../../../../src/server/session.ts';
import {
  ATTRIBUTE_EDIT_PERMISSION,
  ATTRIBUTE_VIEW_PERMISSION,
  TABS,
  TYPE_EDIT_PERMISSION,
  VIEW_PERMISSION,
  type Tab,
} from '../../../../src/variants/types.ts';
import { VariantsView } from '../../../../src/variants/variants-view.tsx';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('variants.title') };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const one = (value: string | readonly string[] | undefined): string | undefined =>
  typeof value === 'string' ? value : undefined;

/**
 * Catalogue > Variants (variants V6): the Market's variant types and how buyers choose them, and
 * every variant of its live products with their issues. `?tab=` opens a tab and `?id=` a variant
 * type, so a link can point at one.
 */
export default async function VariantsPage({
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
    rawTab !== undefined && (TABS as readonly string[]).includes(rawTab)
      ? (rawTab as Tab)
      : 'types';
  const rawId = one(query.id);
  const selectedId = rawId !== undefined && UUID.test(rawId) ? rawId : null;
  const title = t('variants.title');
  const { permissionKeys, csrfToken } = gate.session;
  return (
    <AdminShell session={gate.session} activeId="variants" title={title}>
      <h1 className="text-2xl font-semibold">{title}</h1>
      {permissionKeys.includes(VIEW_PERMISSION) ? (
        <VariantsView
          canEdit={
            permissionKeys.includes(TYPE_EDIT_PERMISSION) &&
            permissionKeys.includes(ATTRIBUTE_EDIT_PERMISSION)
          }
          canOpenAttributes={permissionKeys.includes(ATTRIBUTE_VIEW_PERMISSION)}
          csrfToken={csrfToken}
          initialTab={tab}
          initialId={selectedId}
        />
      ) : (
        <>
          <p className="mt-4 text-fg-muted">{t('variants.no-access')}</p>
          <p className="mt-4">
            <a className="font-medium text-link underline" href="/">
              {t('variants.back-home')}
            </a>
          </p>
        </>
      )}
    </AdminShell>
  );
}
