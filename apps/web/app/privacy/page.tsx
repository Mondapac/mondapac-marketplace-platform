import { ComingSoon, comingSoonMetadata } from '../../src/shell/coming-soon.tsx';

export const generateMetadata = () => comingSoonMetadata('privacy');

export default function PrivacyPage() {
  return <ComingSoon page="privacy" />;
}
