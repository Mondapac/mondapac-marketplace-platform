import { getTranslations } from 'next-intl/server';
import {
  ExclusivePerks,
  PROMOTION_MANAGE_PERMISSION,
  PROMOTION_VIEW_PERMISSION,
} from '../../../../src/customers/exclusive-perks.tsx';
import { EARNINGS_VIEW_PERMISSION } from '../../../../src/customers/exclusive-commission.tsx';
import { customersSettingsPage } from '../../../../src/server/customers-page.tsx';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('customers.perks.title') };
}

export default function ExclusivePerksPage() {
  return customersSettingsPage({
    linkId: 'exclusive-perks',
    titleKey: 'customers.perks.title',
    noAccessKey: 'customers.perks.no-access',
    viewKeys: [PROMOTION_VIEW_PERMISSION, PROMOTION_MANAGE_PERMISSION, EARNINGS_VIEW_PERMISSION],
    render: (session) => (
      <ExclusivePerks
        canManage={session.permissionKeys.includes(PROMOTION_MANAGE_PERMISSION)}
        csrfToken={session.csrfToken}
        timeZone={session.timezone}
        showPromotions={[PROMOTION_VIEW_PERMISSION, PROMOTION_MANAGE_PERMISSION].some((key) =>
          session.permissionKeys.includes(key),
        )}
        showCommission={session.permissionKeys.includes(EARNINGS_VIEW_PERMISSION)}
      />
    ),
  });
}
