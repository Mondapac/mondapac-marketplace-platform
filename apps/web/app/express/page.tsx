import { ComingSoon, comingSoonMetadata } from '../../src/shell/coming-soon.tsx';

export const generateMetadata = () => comingSoonMetadata('express');

export default function ExpressPage() {
  return <ComingSoon page="express" />;
}
