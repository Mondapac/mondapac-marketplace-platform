import { getTranslations } from 'next-intl/server';
import { SetupStepPage } from '../../../../src/server/setup-step-page.tsx';
import { AddressForm } from '../../../../src/setup/address-form.tsx';

export async function generateMetadata() {
  const t = await getTranslations('sellers');
  return { title: `${t('steps.address')} – ${t('page.title-suffix')}` };
}

export default function AddressPage() {
  return (
    <SetupStepPage step="address">
      {({ file, descriptors, session }) => (
        <AddressForm file={file} descriptors={descriptors} csrfToken={session.csrfToken} />
      )}
    </SetupStepPage>
  );
}
