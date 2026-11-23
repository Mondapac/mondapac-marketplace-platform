import { LoadError, PageHeader } from '@mondapac/ui';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { AdminShell } from '../../../../../../src/server/admin-shell.tsx';
import { serverGet } from '../../../../../../src/server/server-fetch.ts';
import { requireSession } from '../../../../../../src/server/session.ts';
import { PolicyView } from '../../../../../../src/certificates/type-registry/policy-view.tsx';
import {
  API_POLICIES,
  POLICY_EDIT_PERMISSION,
  POLICY_VIEW_PERMISSION,
  type PolicyCategories,
  type PolicyDetail,
} from '../../../../../../src/certificates/type-registry/types.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('certificates.types.policy.title') };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The claim basis policy of one certificate type (certificates design CA8). */
export default async function TypePolicyPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly typeId: string }>;
  readonly searchParams: Promise<{
    readonly done?: string | readonly string[];
    readonly sr?: string | readonly string[];
  }>;
}) {
  const { typeId } = await params;
  const { done, sr } = await searchParams;
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const title = t('certificates.title');
  const keys = gate.session.permissionKeys;
  const shell = (body: React.ReactNode) => (
    <AdminShell session={gate.session} activeId="certificates" title={title}>
      <PageHeader title={title} className="mb-4" />
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
  if (!keys.includes(POLICY_VIEW_PERMISSION)) return shell(message('no-access'));
  if (!UUID.test(typeId)) return shell(message('not-found'));
  const result = await serverGet<PolicyDetail>(`${API_POLICIES}/${typeId}`);
  if (result.kind === 'signed-out') redirect('/session-ended');
  if (result.kind === 'forbidden') return shell(message('no-access'));
  if (result.kind === 'not-found') return shell(message('not-found'));
  if (result.kind !== 'ok') return shell(message('unavailable'));
  const tree = await serverGet<PolicyCategories>('catalog/categories');
  const request = typeof sr === 'string' && /^\d{1,9}$/.test(sr) ? Number(sr) : null;
  return shell(
    <>
      <p className="mb-4">
        <a className="font-medium text-link underline" href={`/certificates/types/${typeId}`}>
          {t('certificates.types.policy.back')}
        </a>
      </p>
      <PolicyView
        policy={result.body}
        categories={tree.kind === 'ok' ? tree.body.categories : []}
        categoriesLoaded={tree.kind === 'ok'}
        canEdit={keys.includes(POLICY_EDIT_PERMISSION)}
        csrfToken={gate.session.csrfToken}
        done={typeof done === 'string' ? done : null}
        request={request}
      />
    </>,
  );
}
