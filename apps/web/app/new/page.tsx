import { ComingSoon, comingSoonMetadata } from '../../src/shell/coming-soon.tsx';

export const generateMetadata = () => comingSoonMetadata('new');

export default function NewPage() {
  return <ComingSoon page="new" />;
}
