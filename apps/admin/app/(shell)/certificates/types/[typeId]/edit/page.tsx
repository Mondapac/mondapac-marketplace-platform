import { LoadError } from '@mondapac/ui';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { AdminShell } from '../../../../../../src/server/admin-shell.tsx';
import { serverGet } from '../../../../../../src/server/server-fetch.ts';
import { requireSession } from '../../../../../../src/server/session.ts';
import { TypeRevisionForm } from '../../../../../../src/certificates/type-registry/type-revision-form.tsx';
import {
  API_NEW_OPTIONS,
  API_TYPES,
  TYPE_EDIT_PERMISSION,
  TYPE_VIEW_PERMISSION,
  type TypeDetail,
  type TypeNewOptions,
} from '../../../../../../src/certificates/type-registry/types.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('certificates.types.revise.title') };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Write a new revision of one certificate type (certificates design CA4). */
export default async function TypeEditPage({
  params,
}: {
  readonly params: Promise<{ readonly typeId: string }>;
}) {
  const { typeId } = await params;
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
      {body}
    </AdminShell>
  );
  const message = (key: 'no-access' | 'unavailable' | 'not-found') => (
    <>
      <p className="mb-4">
        <a className="font-medium text-link underline" href="/certificates/types">
          {t('certificates.types.detail.back')}
        </a>
      </p>
      {key === 'unavailable' ? (
        <LoadError
          className="flex flex-col items-start gap-3"
          message={t('certificates.types.detail.unavailable')}
          retryLabel={t('load.retry')}
        />
      ) : (
        <p className="text-fg-muted">{t(`certificates.types.detail.${key}`)}</p>
      )}
    </>
  );
  if (!keys.includes(TYPE_VIEW_PERMISSION) || !keys.includes(TYPE_EDIT_PERMISSION))
    return shell(message('no-access'));
  if (!UUID.test(typeId)) return shell(message('not-found'));
  const result = await serverGet<TypeDetail>(`${API_TYPES}/${typeId}`);
  if (result.kind === 'signed-out') redirect('/session-ended');
  if (result.kind === 'forbidden') return shell(message('no-access'));
  if (result.kind === 'not-found') return shell(message('not-found'));
  if (result.kind !== 'ok') return shell(message('unavailable'));
  // Only a type that is live or proposed can be changed; a closed proposal is read-only.
  if (result.body.status === 'rejected' || result.body.status === 'withdrawn')
    return shell(message('not-found'));
  // The artwork list; without it the type's own key stays the only choice.
  const options = await serverGet<TypeNewOptions>(API_NEW_OPTIONS);
  return shell(
    <>
      <p className="mb-4">
        <a className="font-medium text-link underline" href={`/certificates/types/${typeId}`}>
          {t('certificates.types.revise.back')}
        </a>
      </p>
      <h2 className="mb-4 text-xl font-semibold">
        {t('certificates.types.revise.heading', { code: result.body.code })}
      </h2>
      <TypeRevisionForm
        type={result.body}
        csrfToken={gate.session.csrfToken}
        artworkKeys={options.kind === 'ok' ? options.body.badgeArtworkKeys : []}
      />
    </>,
  );
}
