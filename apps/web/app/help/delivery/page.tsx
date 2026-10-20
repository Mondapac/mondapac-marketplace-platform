import { ComingSoon, comingSoonMetadata } from '../../../src/shell/coming-soon.tsx';

export const generateMetadata = () => comingSoonMetadata('help-delivery');

export default function HelpDeliveryPage() {
  return <ComingSoon page="help-delivery" />;
}
