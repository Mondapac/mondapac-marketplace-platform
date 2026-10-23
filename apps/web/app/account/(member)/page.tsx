import { AccountOverview } from '../../../src/account/overview.tsx';
import { accountMetadata } from '../../../src/seo/metadata.ts';

export const generateMetadata = () => accountMetadata('overview', '/account');

export default function AccountOverviewPage() {
  return <AccountOverview />;
}
