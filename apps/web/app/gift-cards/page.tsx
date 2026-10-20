import { ComingSoon, comingSoonMetadata } from '../../src/shell/coming-soon.tsx';

export const generateMetadata = () => comingSoonMetadata('gift-cards');

export default function GiftCardsPage() {
  return <ComingSoon page="gift-cards" />;
}
