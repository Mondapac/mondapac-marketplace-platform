import { ComingSoon, comingSoonMetadata } from '../../src/shell/coming-soon.tsx';

export const generateMetadata = () => comingSoonMetadata('browse');

export default function BrowsePage() {
  return <ComingSoon page="browse" />;
}
