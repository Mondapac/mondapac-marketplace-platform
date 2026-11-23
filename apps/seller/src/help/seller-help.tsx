'use client';

import {
  HelpButton,
  HelpPanel,
  HelpProvider,
  resolveHelp,
  useHelp,
  type HelpPageText,
  type HelpTabbedText,
  type HelpTextSource,
} from '@mondapac/ui';
import { useMessages, useTimeZone, useTranslations } from 'next-intl';
import { usePathname } from 'next/navigation';
import { useMemo, type ReactNode } from 'react';
import { resolveZone } from '../price/zone-time.ts';
import { HELP_REGISTRY } from './help-registry.ts';

interface HelpMessages {
  readonly pages?: Readonly<Record<string, HelpPageText>>;
  readonly tabbed?: Readonly<Record<string, HelpTabbedText>>;
}

/** The text of every page, read from the message catalogue's `help` section. */
function useTextSource(): HelpTextSource {
  const messages = useMessages() as { readonly help?: HelpMessages };
  return useMemo(
    () => ({
      page: (slug) => messages.help?.pages?.[slug],
      tabbed: (slug) => messages.help?.tabbed?.[slug],
    }),
    [messages],
  );
}

/**
 * Wraps the shell so the Help button in the top bar and the panel share one state. The button
 * shows only on a page that has help text.
 */
export function SellerHelpProvider({ children }: { readonly children: ReactNode }) {
  const zone = resolveZone(useTimeZone());
  const pathname = usePathname();
  const text = useTextSource();
  const available = useMemo(
    () => resolveHelp({ pathname, registry: HELP_REGISTRY, text, zone }) !== null,
    [pathname, text, zone],
  );
  return <HelpProvider hasContent={available}>{children}</HelpProvider>;
}

/** The Help button, before Search in the top bar. */
export function SellerHelpButton() {
  const t = useTranslations('help');
  return <HelpButton label={t('button')} />;
}

/** The Help panel, with the text of the page the path shows (and its open tab). */
export function SellerHelpPanel() {
  const zone = resolveZone(useTimeZone());
  const t = useTranslations('help');
  const pathname = usePathname();
  const text = useTextSource();
  const { tab } = useHelp();
  const content = useMemo(
    () => resolveHelp({ pathname, registry: HELP_REGISTRY, text, zone, activeTab: tab }),
    [pathname, text, zone, tab],
  );
  return (
    <HelpPanel
      content={content}
      labels={{
        about: t('about'),
        thisTab: t('this-tab'),
        goodToKnow: t('good-to-know'),
        related: t('related'),
        learnMore: t('learn-more'),
        close: t('close'),
      }}
    />
  );
}
