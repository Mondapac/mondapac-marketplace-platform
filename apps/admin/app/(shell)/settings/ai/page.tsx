import { LoadError, NoAccess, SettingsPage } from '@mondapac/ui';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { AiSettingsPanel } from '../../../../src/ai-settings/ai-settings-panel.tsx';
import {
  AI_MANAGE_PERMISSION,
  AI_SETTINGS_PATH,
  AI_VIEW_PERMISSION,
  MODEL_SETUP_PATH,
  modelSetupOf,
  settingsAnswerOf,
} from '../../../../src/ai-settings/types.ts';
import { serverGet } from '../../../../src/server/server-fetch.ts';
import { requireSession } from '../../../../src/server/session.ts';
import { SettingsShell } from '../../../../src/server/settings-shell.tsx';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('ai-settings.title') };
}

/** Settings › AI: the Market switch and model tier of "Write with AI", and the server's setup. */
export default async function AiSettingsPage() {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const title = t('ai-settings.title');
  const { permissionKeys, csrfToken } = gate.session;
  const shell = (body: React.ReactNode) => (
    <SettingsShell session={gate.session} linkId="ai" title={title}>
      {body}
    </SettingsShell>
  );
  if (!permissionKeys.includes(AI_VIEW_PERMISSION)) {
    return shell(
      <NoAccess
        title={t('settings.no-access-title')}
        body={t('settings.no-access-needs', {
          page: title,
          permission: t('ai-settings.permission-view'),
        })}
        backHref="/"
        backLabel={t('settings.back-home')}
      />,
    );
  }
  const [settings, setup] = await Promise.all([
    serverGet<unknown>(AI_SETTINGS_PATH),
    serverGet<unknown>(MODEL_SETUP_PATH),
  ]);
  if (settings.kind === 'signed-out' || setup.kind === 'signed-out') redirect('/session-ended');
  const answer = settings.kind === 'ok' ? settingsAnswerOf(settings.body) : null;
  if (answer === null) {
    return shell(
      <SettingsPage title={title}>
        <LoadError
          message={t('ai-settings.load-failed')}
          retryLabel={t('load.retry')}
          className="flex flex-col items-start gap-3"
        />
      </SettingsPage>,
    );
  }
  return shell(
    <AiSettingsPanel
      initial={answer}
      setup={setup.kind === 'ok' ? modelSetupOf(setup.body) : null}
      canManage={permissionKeys.includes(AI_MANAGE_PERMISSION)}
      csrfToken={csrfToken}
    />,
  );
}
