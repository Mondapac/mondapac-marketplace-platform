import { AccountDeleteScreen } from '../../../../src/account/account-deletion.tsx';
import { accountMetadata } from '../../../../src/seo/metadata.ts';

export const generateMetadata = () => accountMetadata('delete', '/account/delete');

export default function AccountDeletePage() {
  return <AccountDeleteScreen />;
}
