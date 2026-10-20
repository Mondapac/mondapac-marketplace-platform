import { ComingSoon, comingSoonMetadata } from '../../src/shell/coming-soon.tsx';

export const generateMetadata = () => comingSoonMetadata('delivery-area');

export default function DeliveryAreaPage() {
  return <ComingSoon page="delivery-area" />;
}
