import { NoAccess } from '@mondapac/ui';
import { visibleSettings } from './settings-nav.ts';

/**
 * The no-access block of a settings page. It leads back to the Settings hub only when the hub
 * has something for the caller; a member with no settings page at all goes to the dashboard
 * instead of to another no-access page.
 */
export function SettingsNoAccess({
  permissionKeys,
  title,
  body,
  labels,
}: {
  readonly permissionKeys: readonly string[];
  readonly title: string;
  readonly body: string;
  readonly labels: { readonly settings: string; readonly home: string };
}) {
  const hub = visibleSettings(permissionKeys).length > 0;
  return (
    <NoAccess
      title={title}
      body={body}
      backHref={hub ? '/settings' : '/'}
      backLabel={hub ? labels.settings : labels.home}
    />
  );
}
