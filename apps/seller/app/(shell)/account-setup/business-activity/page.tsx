import { LoadError } from '@mondapac/ui';
import { getLocale, getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { serverGet } from '../../../../src/server/server-fetch.ts';
import { SetupStepPage } from '../../../../src/server/setup-step-page.tsx';
import { ActivityForm } from '../../../../src/setup/activity-form.tsx';
import type { ActivityChoices, MyActivities } from '../../../../src/setup/types.ts';

export async function generateMetadata() {
  const t = await getTranslations('sellers');
  return { title: `${t('steps.activity')} – ${t('page.title-suffix')}` };
}

export default async function BusinessActivityPage() {
  const [choices, mine, locale, t] = await Promise.all([
    serverGet<ActivityChoices>('catalog/own/business-activities'),
    serverGet<MyActivities>('sellers/my-file/activities'),
    getLocale(),
    getTranslations(),
  ]);
  if (choices.kind === 'signed-out' || mine.kind === 'signed-out') redirect('/session-ended');
  return (
    <SetupStepPage step="activity">
      {({ file, session }) =>
        choices.kind !== 'ok' || mine.kind !== 'ok' ? (
          <LoadError message={t('sellers.activity.load-error')} retryLabel={t('load.retry')} />
        ) : (
          <ActivityForm
            file={file}
            csrfToken={session.csrfToken}
            choices={choices.body.items}
            locale={locale}
            defaultLocale={choices.body.defaultLocale}
            initialMain={mine.body.requested?.mainActivityId ?? mine.body.assigned.mainActivityId}
            initialExtras={
              mine.body.requested?.extraActivityIds ?? mine.body.assigned.extraActivityIds
            }
          />
        )
      }
    </SetupStepPage>
  );
}
