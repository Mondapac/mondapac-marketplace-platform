import { redirect } from 'next/navigation';

/** The old Offer reviews address: the Offers tab of the review queue. */
export default function OfferReviewsPage() {
  redirect('/review?type=offer');
}
