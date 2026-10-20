import { ComingSoon, comingSoonMetadata } from '../../../src/shell/coming-soon.tsx';

export const generateMetadata = () => comingSoonMetadata('help-contact');

export default function HelpContactPage() {
  return <ComingSoon page="help-contact" />;
}
