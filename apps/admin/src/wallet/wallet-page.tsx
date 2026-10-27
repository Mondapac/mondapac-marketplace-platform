import { LoadError } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { AdminShell } from '../server/admin-shell.tsx';
import { requireSession, type AdminSession } from '../server/session.ts';

/**
 * The frame of a wallet page: session gate, shell, title and the intro lines, and the no-access
 * message when the admin holds none of `anyOf` (the pattern of the held prices page). The body is
 * built only for an admin who may see the page.
 */
export async function WalletPage({
  activeId,
  title,
  intro,
  anyOf,
  stepUpNote,
  body,
}: {
  readonly activeId: string;
  readonly title: string;
  readonly intro: string;
  readonly anyOf: readonly string[];
  /** Show the "wait for a new code" help line (the page has a button that asks for a code). */
  readonly stepUpNote: boolean;
  readonly body: (session: AdminSession, keys: ReadonlySet<string>) => ReactNode;
}) {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const keys = new Set(gate.session.permissionKeys);
  const allowed = anyOf.some((key) => keys.has(key));
  return (
    <AdminShell session={gate.session} activeId={activeId} title={title}>
      <h1 className="mb-2 text-2xl font-semibold">{title}</h1>
      {allowed ? (
        <div className="flex flex-col gap-4">
          <div className="flex max-w-(--mp-size-form-max) flex-col gap-1 text-fg-muted">
            <p>{intro}</p>
            {stepUpNote ? <p className="text-sm">{t('step-up.wait-note')}</p> : null}
          </div>
          {body(gate.session, keys)}
        </div>
      ) : (
        <>
          <p className="text-fg-muted">{t('wallet.no-access')}</p>
          <p className="mt-4">
            <a className="font-medium text-link underline" href="/">
              {t('wallet.back-home')}
            </a>
          </p>
        </>
      )}
    </AdminShell>
  );
}
