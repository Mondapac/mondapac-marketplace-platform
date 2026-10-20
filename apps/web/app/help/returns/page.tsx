import { ComingSoon, comingSoonMetadata } from '../../../src/shell/coming-soon.tsx';

export const generateMetadata = () => comingSoonMetadata('help-returns');

export default function HelpReturnsPage() {
  return <ComingSoon page="help-returns" />;
}
