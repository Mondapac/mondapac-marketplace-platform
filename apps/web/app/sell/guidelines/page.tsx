import { ComingSoon, comingSoonMetadata } from '../../../src/shell/coming-soon.tsx';

export const generateMetadata = () => comingSoonMetadata('sell-guidelines');

export default function SellGuidelinesPage() {
  return <ComingSoon page="sell-guidelines" />;
}
