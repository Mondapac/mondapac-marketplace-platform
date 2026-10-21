import { AccountAddresses } from '../../../../src/account/addresses.tsx';
import { accountMetadata } from '../../../../src/seo/metadata.ts';

export const generateMetadata = () => accountMetadata('addresses', '/account/addresses');

export default function AccountAddressesPage() {
  return <AccountAddresses />;
}
