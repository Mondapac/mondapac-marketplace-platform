import { getTranslations } from 'next-intl/server';
import { SetupStepPage } from '../../../../src/server/setup-step-page.tsx';
import { BusinessForm } from '../../../../src/setup/business-form.tsx';

export async function generateMetadata() {
  const t = await getTranslations('sellers');
  return { title: `${t('steps.business')} – ${t('page.title-suffix')}` };
}

export default function BusinessDetailsPage() {
  return (
    <SetupStepPage step="business">
      {({ file, descriptors, session }) => (
        <BusinessForm
          file={file}
          csrfToken={session.csrfToken}
          signInEmail={session.email}
          phoneMaxLength={descriptors.phone.maxLength}
        />
      )}
    </SetupStepPage>
  );
}
