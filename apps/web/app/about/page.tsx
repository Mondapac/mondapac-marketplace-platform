import { ComingSoon, comingSoonMetadata } from '../../src/shell/coming-soon.tsx';

export const generateMetadata = () => comingSoonMetadata('about');

export default function AboutPage() {
  return <ComingSoon page="about" />;
}
