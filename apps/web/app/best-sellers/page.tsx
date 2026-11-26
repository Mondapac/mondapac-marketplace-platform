import { ComingSoon, comingSoonMetadata } from '../../src/shell/coming-soon.tsx';

export const generateMetadata = () => comingSoonMetadata('best-sellers');

export default function BestSellersPage() {
  return <ComingSoon page="best-sellers" />;
}
