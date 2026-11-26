import { LoadError, NoAccess, SettingsPage } from '@mondapac/ui';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { AiModelsPanel } from '../../../../src/ai-models/ai-models-panel.tsx';
import {
  MODELS_MANAGE_PERMISSION,
  MODELS_PATH,
  MODELS_VIEW_PERMISSION,
  modelsAnswerOf,
} from '../../../../src/ai-models/types.ts';
import { serverGet } from '../../../../src/server/server-fetch.ts';
import { requireSession } from '../../../../src/server/session.ts';
import { SettingsShell } from '../../../../src/server/settings-shell.tsx';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('ai-models.title') };
}

/** Settings › AI Models: the models each AI task type may use, in order, and the saver model. */
export default async function AiModelsPage() {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const title = t('ai-models.title');
  const { permissionKeys, csrfToken } = gate.session;
  const shell = (body: React.ReactNode) => (
    <SettingsShell session={gate.session} linkId="ai-models" title={title}>
      {body}
    </SettingsShell>
  );
  if (!permissionKeys.includes(MODELS_VIEW_PERMISSION)) {
    return shell(
      <NoAccess
        title={t('settings.no-access-title')}
        body={t('settings.no-access-needs', {
          page: title,
          permission: t('ai-models.permission-view'),
        })}
        backHref="/"
        backLabel={t('settings.back-home')}
      />,
    );
  }
  const answer = await serverGet<unknown>(MODELS_PATH);
  if (answer.kind === 'signed-out') redirect('/session-ended');
  const rows = answer.kind === 'ok' ? modelsAnswerOf(answer.body) : null;
  if (rows === null) {
    return shell(
      <SettingsPage title={title}>
        <LoadError
          message={t('ai-models.load-failed')}
          retryLabel={t('load.retry')}
          className="flex flex-col items-start gap-3"
        />
      </SettingsPage>,
    );
  }
  return shell(
    <AiModelsPanel
      initial={rows}
      canManage={permissionKeys.includes(MODELS_MANAGE_PERMISSION)}
      csrfToken={csrfToken}
    />,
  );
}
