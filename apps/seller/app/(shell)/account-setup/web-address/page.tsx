import { getTranslations } from 'next-intl/server';
import { panelConfig } from '../../../../src/server/config.ts';
import { SetupStepPage } from '../../../../src/server/setup-step-page.tsx';
import { SlugForm } from '../../../../src/setup/slug-form.tsx';

export async function generateMetadata() {
  const t = await getTranslations('sellers');
  return { title: `${t('steps.slug')} – ${t('page.title-suffix')}` };
}

export default function WebAddressPage() {
  return (
    <SetupStepPage step="slug">
      {({ file, session }) => (
        <SlugForm
          file={file}
          csrfToken={session.csrfToken}
          storefrontAddress={panelConfig().storefrontAddress}
        />
      )}
    </SetupStepPage>
  );
}
