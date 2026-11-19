import { MyStores } from '../../../../../src/account/my-stores.tsx';
import { accountMetadata } from '../../../../../src/seo/metadata.ts';

export const generateMetadata = () => accountMetadata('stores', '/account/stores');

export default function AccountStoresPage() {
  return <MyStores />;
}
