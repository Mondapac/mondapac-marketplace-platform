import type { ReactNode } from 'react';
import { Banner } from '../form/banner.tsx';

export interface SettingsViewOnlyBannerProps {
  /** "View only" */
  readonly title: string;
  /** Why, and who can change it: "Your role can see these settings but not change them. ..." */
  readonly children: ReactNode;
}

/**
 * The banner of a settings page the caller can see but not change. Every control on the page is
 * disabled; the banner says so once, with the same title on every page.
 */
export function SettingsViewOnlyBanner({ title, children }: SettingsViewOnlyBannerProps) {
  return (
    <Banner tone="info" title={title}>
      <p>{children}</p>
    </Banner>
  );
}
