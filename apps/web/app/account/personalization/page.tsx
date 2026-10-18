import { getTranslations } from 'next-intl/server';
import { cookies } from 'next/headers';
import Link from 'next/link';
import { Icon } from '../../../src/icons/icon.tsx';
import { PalettePicker } from '../../../src/preferences/palette-picker.tsx';
import {
  PALETTE_COOKIE,
  TEXT_SIZE_COOKIE,
  paletteOf,
  textSizeOf,
} from '../../../src/preferences/preferences.ts';
import { TextSizeToggle } from '../../../src/preferences/text-size-toggle.tsx';

export default async function PersonalizationPage() {
  const t = await getTranslations('personalization');
  const jar = await cookies();
  return (
    <div className="state prefs">
      <Link className="back" href="/account">
        <Icon name="chevl" />
        {t('back')}
      </Link>
      <h1>{t('title')}</h1>
      <p>{t('intro')}</p>
      <PalettePicker initial={paletteOf(jar.get(PALETTE_COOKIE)?.value)} />
      <section className="palettes">
        <h2 className="legend">{t('text-size')}</h2>
        <TextSizeToggle initial={textSizeOf(jar.get(TEXT_SIZE_COOKIE)?.value)} />
      </section>
    </div>
  );
}
