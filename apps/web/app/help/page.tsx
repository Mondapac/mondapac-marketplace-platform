import { ComingSoon, comingSoonMetadata } from '../../src/shell/coming-soon.tsx';

export const generateMetadata = () => comingSoonMetadata('help');

export default function HelpPage() {
  return <ComingSoon page="help" />;
}
