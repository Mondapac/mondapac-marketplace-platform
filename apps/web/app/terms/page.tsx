import { ComingSoon, comingSoonMetadata } from '../../src/shell/coming-soon.tsx';

export const generateMetadata = () => comingSoonMetadata('terms');

export default function TermsPage() {
  return <ComingSoon page="terms" />;
}
