import { getTranslations } from 'next-intl/server';
import { SetupStepPage } from '../../../../src/server/setup-step-page.tsx';
import { NumberForm } from '../../../../src/setup/number-form.tsx';

export async function generateMetadata() {
  const t = await getTranslations('sellers');
  return { title: `${t('steps.number')} – ${t('page.title-suffix')}` };
}

export default function BusinessNumberPage() {
  return (
    <SetupStepPage step="number">
      {({ file, descriptors, session }) => (
        <NumberForm file={file} descriptors={descriptors} csrfToken={session.csrfToken} />
      )}
    </SetupStepPage>
  );
}
