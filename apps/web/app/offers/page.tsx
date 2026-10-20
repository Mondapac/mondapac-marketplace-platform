import { ComingSoon, comingSoonMetadata } from '../../src/shell/coming-soon.tsx';

export const generateMetadata = () => comingSoonMetadata('offers');

export default function OffersPage() {
  return <ComingSoon page="offers" />;
}
