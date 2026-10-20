import { ComingSoon, comingSoonMetadata } from '../../src/shell/coming-soon.tsx';

export const generateMetadata = () => comingSoonMetadata('certified');

export default function CertifiedPage() {
  return <ComingSoon page="certified" />;
}
