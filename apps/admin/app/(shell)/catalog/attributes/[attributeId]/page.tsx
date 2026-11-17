import { LoadError } from '@mondapac/ui';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { AttributeDetailPage } from '../../../../../src/attributes/attribute-detail-page.tsx';
import {
  EDIT_PERMISSION,
  RESTRUCTURE_PERMISSION,
  VIEW_PERMISSION,
} from '../../../../../src/attributes/types.ts';
import { AdminShell } from '../../../../../src/server/admin-shell.tsx';
import { requireSession } from '../../../../../src/server/session.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('attributes.title') };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** One attribute (super list phase 2, list 5): its details, values, uses and history. */
export default async function AttributePage({
  params,
}: {
  readonly params: Promise<{ readonly attributeId: string }>;
}) {
  const { attributeId } = await params;
  if (!UUID.test(attributeId)) notFound();
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const title = t('attributes.title');
  const { permissionKeys, csrfToken } = gate.session;
  return (
    <AdminShell session={gate.session} activeId="attributes" title={title}>
      <h1 className="text-2xl font-semibold">{title}</h1>
      {permissionKeys.includes(VIEW_PERMISSION) ? (
        <AttributeDetailPage
          attributeId={attributeId}
          canEdit={permissionKeys.includes(EDIT_PERMISSION)}
          canRestructure={permissionKeys.includes(RESTRUCTURE_PERMISSION)}
          csrfToken={csrfToken}
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
