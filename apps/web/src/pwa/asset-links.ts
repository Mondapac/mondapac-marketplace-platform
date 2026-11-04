/** Package name of the Android app in apps/twa (applicationId). */
export const TWA_PACKAGE = 'au.com.mondapac.store';

const FINGERPRINT = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;

/**
 * Digital Asset Links statements that let the Android app open this site as a Trusted Web
 * Activity. The fingerprints are the SHA-256 certificate fingerprints of the app signing keys
 * (public values), read from `TWA_CERT_SHA256` as a comma-separated list. Unset or empty gives
 * an empty list, so no app is trusted. A malformed value is refused, never served.
 */
export function assetLinks(raw: string | undefined): unknown[] {
  const prints = (raw ?? '')
    .split(',')
    .map((p) => p.trim().toUpperCase())
    .filter((p) => p !== '');
  if (prints.length === 0) return [];
  for (const p of prints) {
    if (!FINGERPRINT.test(p)) throw new Error('TWA_CERT_SHA256 holds a malformed fingerprint');
  }
  return [
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: TWA_PACKAGE,
        sha256_cert_fingerprints: prints,
      },
    },
  ];
}
