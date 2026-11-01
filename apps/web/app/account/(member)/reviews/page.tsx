import { AccountReviews } from '../../../../src/account/reviews.tsx';
import { accountMetadata } from '../../../../src/seo/metadata.ts';

export const generateMetadata = () => accountMetadata('reviews', '/account/reviews');

export default function AccountReviewsPage() {
  return <AccountReviews />;
}
