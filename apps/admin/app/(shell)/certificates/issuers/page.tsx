import { Banner, LoadError } from '@mondapac/ui';
import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminShell } from '../../../../src/server/admin-shell.tsx';
import { serverGet } from '../../../../src/server/server-fetch.ts';
import { requireSession } from '../../../../src/server/session.ts';
import { typeNames } from '../../../../src/certificates/format.ts';
import { CertificatesTabs } from '../../../../src/certificates/tabs.tsx';
import { StateFilter } from '../../../../src/certificates/issuers/filters.tsx';
import { IssuersTable } from '../../../../src/certificates/issuers/issuers-table.tsx';
import { NewIssuer } from '../../../../src/certificates/issuers/new-issuer.tsx';
import {
  API_ISSUERS,
  ISSUER_EDIT_PERMISSION,
  ISSUER_STATES,
  ISSUER_VIEW_PERMISSION,
  PAGE_SIZE,
  type IssuerPage,
  type TypeChoice,
} from '../../../../src/certificates/issuers/types.ts';
import { TYPE_VIEW_PERMISSION } from '../../../../src/certificates/types.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('certificates.issuers.title') };
}

type SearchParams = Readonly<Record<string, string | readonly string[] | undefined>>;
const one = (value: string | readonly string[] | undefined) =>
  typeof value === 'string' && value !== '' ? value : null;

/**
 * Certificates > Issuers (certificate issuers design A7): the registry of the Market with a state
 * filter and keyset pages. "New issuer" needs the issuer edit permission and the types list (it
 * names the type). A banner says when no issuer is active, read apart from the filters.
 */
export default async function IssuersPage({
  searchParams,
}: {
  readonly searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const stateParam = one(params.state);
  const state = ISSUER_STATES.find((value) => value === stateParam) ?? null;
  const after = one(params.after);
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
  const message = (key: 'no-access' | 'unavailable') => (
    <>
      {key === 'unavailable' ? (
        <LoadError
          className="flex flex-col items-start gap-3"
          message={t('certificates.issuers.unavailable')}
          retryLabel={t('load.retry')}
        />
      ) : (
        <p className="text-fg-muted">{t('certificates.issuers.no-access')}</p>
      )}
      <p className="mt-4">
        <a className="font-medium text-link underline" href="/">
          {t('certificates.queue.back-home')}
        </a>
      </p>
    </>
  );
  if (!keys.includes(ISSUER_VIEW_PERMISSION)) return shell(message('no-access'));

  const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (state !== null) query.set('state', state);
  if (after !== null) query.set('afterId', after);
  const [result, active, types] = await Promise.all([
    serverGet<IssuerPage>(`${API_ISSUERS}?${query.toString()}`),
    serverGet<IssuerPage>(`${API_ISSUERS}?state=active&limit=1`),
    keys.includes(TYPE_VIEW_PERMISSION)
      ? serverGet<{ readonly items: readonly TypeChoice[] }>('certification/admin/types')
      : Promise.resolve(null),
  ]);
  if (result.kind === 'signed-out') redirect('/session-ended');
  if (result.kind === 'forbidden') return shell(message('no-access'));
  if (result.kind !== 'ok') return shell(message('unavailable'));
  const locale = await getLocale();
  const typeList = types?.kind === 'ok' ? types.body.items : [];
  const names = typeNames(typeList, locale);
  const next = result.body.nextAfterId;
  const canCreate = keys.includes(ISSUER_EDIT_PERMISSION) && typeList.length > 0;
  // A failed read of the active issuers shows no banner rather than a wrong one.
  const noneActive = active.kind === 'ok' && active.body.items.length === 0;
  const filterHref = (cursor: string) =>
    `/certificates/issuers?${new URLSearchParams({ ...(state === null ? {} : { state }), after: cursor }).toString()}`;

  return shell(
    <div className="flex flex-col gap-4">
      <CertificatesTabs active="issuers" permissionKeys={keys} />
      {noneActive ? (
        <Banner tone="attention">{t('certificates.issuers.none-active')}</Banner>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <StateFilter active={state} />
        {canCreate ? (
          <NewIssuer types={typeList} typeNames={names} csrfToken={gate.session.csrfToken} />
        ) : null}
      </div>
      <IssuersTable rows={result.body.items} typeNames={names} morePages={next !== null} />
      <div className="flex gap-4">
        {after === null ? null : (
          <a
            className="font-medium text-link underline"
            href={state === null ? '/certificates/issuers' : `/certificates/issuers?state=${state}`}
          >
            {t('certificates.queue.first-page')}
          </a>
        )}
        {next === null ? null : (
          <a className="font-medium text-link underline" href={filterHref(next)}>
            {t('certificates.queue.more')}
          </a>
        )}
      </div>
    </div>,
  );
}
