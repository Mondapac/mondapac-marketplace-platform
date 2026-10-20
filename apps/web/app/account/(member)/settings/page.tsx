import { cookies } from 'next/headers';
import { AccountSettings } from '../../../../src/account/settings.tsx';
import {
  PALETTE_COOKIE,
  TEXT_SIZE_COOKIE,
  paletteOf,
  textSizeOf,
} from '../../../../src/preferences/preferences.ts';

export default async function AccountSettingsPage() {
  const jar = await cookies();
  return (
    <AccountSettings
      palette={paletteOf(jar.get(PALETTE_COOKIE)?.value)}
      textSize={textSizeOf(jar.get(TEXT_SIZE_COOKIE)?.value)}
    />
  );
}
