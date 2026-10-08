// English catalogue of the seller panel (ADR-0033 decision 10). Strings never live inline.
export const messages: Record<string, string> = {
  'nav.home': 'Home',
  'home.title': 'Home',
  'home.empty': 'Your seller workspace is being set up.',
  'panel.name': 'Seller',
};

export const t = (key: string): string => messages[key] ?? key;
