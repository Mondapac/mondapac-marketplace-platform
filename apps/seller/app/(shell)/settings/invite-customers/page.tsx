import { getTranslations } from 'next-intl/server';
import { InviteCustomers } from '../../../../src/customers/invite-customers.tsx';
import { INVITE_LINK_PERMISSION } from '../../../../src/customers/types.ts';
import { panelConfig } from '../../../../src/server/config.ts';
import { customersSettingsPage } from '../../../../src/server/customers-page.tsx';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('customers.invite.title') };
}

export default function InviteCustomersPage() {
  return customersSettingsPage({
    linkId: 'invite-customers',
    titleKey: 'customers.invite.title',
    noAccessKey: 'customers.invite.no-access',
    viewKeys: [INVITE_LINK_PERMISSION],
    render: (session) => (
      <InviteCustomers
        storefrontOrigin={panelConfig().storefrontOrigin}
        csrfToken={session.csrfToken}
      />
    ),
  });
}
