import { ComingSoon, comingSoonMetadata } from '../../../src/shell/coming-soon.tsx';

export const generateMetadata = () => comingSoonMetadata('help-certificates');

export default function HelpCertificatesPage() {
  return <ComingSoon page="help-certificates" />;
}
