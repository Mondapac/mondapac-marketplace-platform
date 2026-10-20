import { ComingSoon, comingSoonMetadata } from '../../src/shell/coming-soon.tsx';

export const generateMetadata = () => comingSoonMetadata('recipes');

export default function RecipesPage() {
  return <ComingSoon page="recipes" />;
}
