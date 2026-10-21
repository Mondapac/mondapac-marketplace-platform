import { AccountLists } from '../../../../src/account/lists.tsx';
import { accountMetadata } from '../../../../src/seo/metadata.ts';

export const generateMetadata = () => accountMetadata('lists', '/account/lists');

export default function AccountListsPage() {
  return <AccountLists />;
}
