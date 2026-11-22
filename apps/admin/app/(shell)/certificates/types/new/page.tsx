import { LoadError } from '@mondapac/ui';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { AdminShell } from '../../../../../src/server/admin-shell.tsx';
import { serverGet } from '../../../../../src/server/server-fetch.ts';
import { requireSession } from '../../../../../src/server/session.ts';
import { TypeNewForm } from '../../../../../src/certificates/type-registry/type-new-form.tsx';
import {
  API_NEW_OPTIONS,
  TYPE_EDIT_PERMISSION,
  TYPE_VIEW_PERMISSION,
  type TypeNewOptions,
} from '../../../../../src/certificates/type-registry/types.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('certificates.types.fields.title') };
}

/** Propose a new certificate type; a second admin approves it (FE-091 N2). */
export default async function TypeNewPage() {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const title = t('certificates.title');
  const keys = gate.session.permissionKeys;
  const shell = (body: React.ReactNode) => (
    <AdminShell session={gate.session} activeId="certificates" title={title}>
      <h1 className="mb-4 text-2xl font-semibold">{title}</h1>
      <p className="mb-4">
        <a className="font-medium text-link underline" href="/certificates/types">
          {t('certificates.types.detail.back')}
        </a>
      </p>
      {body}
    </AdminShell>
  );
  if (!keys.includes(TYPE_VIEW_PERMISSION) || !keys.includes(TYPE_EDIT_PERMISSION))
    return shell(<p className="text-fg-muted">{t('certificates.types.no-access')}</p>);
  const options = await serverGet<TypeNewOptions>(API_NEW_OPTIONS);
  if (options.kind === 'signed-out') redirect('/session-ended');
  if (options.kind === 'forbidden')
    return shell(<p className="text-fg-muted">{t('certificates.types.no-access')}</p>);
  if (options.kind !== 'ok')
    return shell(
      <LoadError
        className="flex flex-col items-start gap-3"
        message={t('certificates.types.fields.unavailable')}
        retryLabel={t('load.retry')}
      />,
    );
  return shell(
    <>
      <h2 className="mb-1 text-xl font-semibold">{t('certificates.types.fields.title')}</h2>
      <TypeNewForm options={options.body} csrfToken={gate.session.csrfToken} />
    </>,
  );
}
