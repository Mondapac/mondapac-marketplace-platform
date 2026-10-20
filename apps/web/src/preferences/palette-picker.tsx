'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import {
  PALETTES,
  PALETTE_COOKIE,
  PALETTE_SWATCHES,
  savePreference,
  type Palette,
} from './preferences.ts';

/** The customer's choice of shop colours (Personalization). `onChoose` also hears each choice. */
export function PalettePicker({
  initial,
  onChoose,
}: {
  readonly initial: Palette;
  readonly onChoose?: (palette: Palette) => void;
}) {
  const t = useTranslations('personalization');
  const [palette, setPalette] = useState<Palette>(initial);
  return (
    <fieldset className="palettes">
      <legend>{t('palette')}</legend>
      <p className="hint">{t('palette-help')}</p>
      <div className="palette-list">
        {PALETTES.map((code) => (
          <label key={code} className="palette-option">
            <input
              type="radio"
              name="palette"
              value={code}
              checked={palette === code}
              onChange={() => {
                setPalette(code);
                savePreference(PALETTE_COOKIE, 'palette', code);
                onChoose?.(code);
              }}
            />
            <span className="swatches" aria-hidden="true">
              {PALETTE_SWATCHES[code].map((colour) => (
                <span key={colour} style={{ background: colour }} />
              ))}
            </span>
            <span className="palette-name">
              <b>{t(`palettes.${code}`)}</b>
              {code === 'B' ? <small>{t('default')}</small> : null}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
