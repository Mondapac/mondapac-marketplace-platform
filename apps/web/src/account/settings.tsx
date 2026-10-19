'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState } from 'react';
import { Icon } from '../icons/icon.tsx';
import { PalettePicker } from '../preferences/palette-picker.tsx';
import type { Palette, TextSize } from '../preferences/preferences.ts';
import { TextSizeToggle } from '../preferences/text-size-toggle.tsx';
import type { EmailChoices } from '../storefront/types.ts';
import { AccountFrame } from './account-area.tsx';
import { useAccount, type Profile } from './account-state.tsx';
import { AcField, PasswordField } from './fields.tsx';

/**
 * Settings: Profile, Password (always open), Appearance (saved to the account, john 19 Oct; the
 * browser keeps a copy for first paint), Emails and Privacy. There is no Delete account (john).
 * Sample: saving changes this tab's state only until the account backend exists.
 */
export function AccountSettings({
  palette,
  textSize,
}: {
  readonly palette: Palette;
  readonly textSize: TextSize;
}) {
  const title = useTranslations('account.titles')('settings');
  return (
    <AccountFrame title={title}>
      <ProfileCard />
      <PasswordCard />
      <AppearanceCard palette={palette} textSize={textSize} />
      <EmailsCard />
      <PrivacyCard />
    </AccountFrame>
  );
}

function AppearanceCard({
  palette,
  textSize,
}: {
  readonly palette: Palette;
  readonly textSize: TextSize;
}) {
  const t = useTranslations('account.settings');
  const { saveAppearance } = useAccount();
  const [saved, setSaved] = useState(false);
  return (
    <section className="ac-card ac-look" aria-labelledby="settings-look">
      <h2 id="settings-look">{t('appearance')}</h2>
      <PalettePicker
        initial={palette}
        onChoose={(choice) => {
          saveAppearance({ palette: choice });
          setSaved(true);
        }}
      />
      <TextSizeToggle
        initial={textSize}
        onChoose={(choice) => {
          saveAppearance({ textSize: choice });
          setSaved(true);
        }}
      />
      <p className="ac-note">
        <Icon name="info" />
        <span>{t('appearance-note')}</span>
      </p>
      <span className="sr-only" role="status">
        {saved ? t('appearance-saved') : ''}
      </span>
    </section>
  );
}

function ProfileCard() {
  const t = useTranslations('account.settings');
  const { profile, setProfile } = useAccount();
  const [draft, setDraft] = useState<Profile>(profile);
  const [saved, setSaved] = useState(false);
  const set = (key: keyof Profile) => (text: string) => {
    setSaved(false);
    setDraft({ ...draft, [key]: text });
  };
  return (
    <section className="ac-card" aria-labelledby="settings-profile">
      <h2 id="settings-profile">{t('profile')}</h2>
      <form
        className="ac-f"
        onSubmit={(event) => {
          event.preventDefault();
          setProfile({
            fullName: draft.fullName.trim() || profile.fullName,
            email: draft.email.trim() || profile.email,
            mobile: draft.mobile.trim(),
          });
          setSaved(true);
        }}
      >
        <AcField
          label={t('full-name')}
          autoComplete="name"
          value={draft.fullName}
          onText={set('fullName')}
          required
        />
        <AcField
          label={t('email')}
          type="email"
          autoComplete="email"
          value={draft.email}
          onText={set('email')}
          hint={t('email-hint')}
          required
        />
        <AcField
          label={t('mobile')}
          autoComplete="tel"
          inputMode="tel"
          value={draft.mobile}
          onText={set('mobile')}
        />
        <div className="ac-acts ac-mid">
          <button className="btn" type="submit">
            {t('save')}
          </button>
          <span className="ac-live" role="status">
            {saved ? (
              <span className="ac-badge ok">
                <Icon name="check" />
                {t('saved')}
              </span>
            ) : null}
          </span>
        </div>
      </form>
    </section>
  );
}

function PasswordCard() {
  const t = useTranslations('account.settings');
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [tried, setTried] = useState(false);
  const [done, setDone] = useState(false);
  const errors = {
    current: current === '' ? t('current-missing') : undefined,
    next: next.length < 10 ? t('too-short') : undefined,
    again: again !== next ? t('mismatch') : undefined,
  };
  const edit = (setter: (text: string) => void) => (text: string) => {
    setDone(false);
    setter(text);
  };
  return (
    <section className="ac-card" aria-labelledby="settings-password">
      <h2 id="settings-password">{t('password')}</h2>
      <form
        className="ac-f"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          setTried(true);
          if (errors.current ?? errors.next ?? errors.again) return;
          setCurrent('');
          setNext('');
          setAgain('');
          setTried(false);
          setDone(true);
        }}
      >
        <PasswordField
          label={t('current')}
          autoComplete="current-password"
          value={current}
          onText={edit(setCurrent)}
          error={tried ? errors.current : undefined}
        />
        <PasswordField
          label={t('new')}
          autoComplete="new-password"
          value={next}
          onText={edit(setNext)}
          hint={t('new-hint')}
          error={tried ? errors.next : undefined}
        />
        <PasswordField
          label={t('confirm')}
          autoComplete="new-password"
          value={again}
          onText={edit(setAgain)}
          error={tried ? errors.again : undefined}
        />
        <div className="ac-live" role="status">
          {done ? (
            <p className="ac-note">
              <Icon name="check" />
              <span>{t('updated')}</span>
            </p>
          ) : null}
        </div>
        <div className="ac-acts">
          <button className="btn" type="submit">
            {t('update')}
          </button>
        </div>
      </form>
    </section>
  );
}

const EMAILS: readonly {
  key: keyof EmailChoices;
  name: 'offers' | 'recommendations' | 'seller';
}[] = [
  { key: 'offers', name: 'offers' },
  { key: 'recommendations', name: 'recommendations' },
  { key: 'sellerMessages', name: 'seller' },
];

function EmailsCard() {
  const t = useTranslations('account.settings');
  const { emails, setEmail } = useAccount();
  return (
    <section className="ac-card" aria-labelledby="settings-emails">
      <h2 id="settings-emails">{t('emails')}</h2>
      <div>
        <Toggle title={t('email-order')} body={t('email-order-body')} on locked />
        {EMAILS.map((e) => (
          <Toggle
            key={e.key}
            title={t(`email-${e.name}`)}
            body={t(`email-${e.name}-body`)}
            on={emails[e.key]}
            onChange={(on) => setEmail(e.key, on)}
          />
        ))}
      </div>
      <small className="ac-sub">{t('email-only')}</small>
    </section>
  );
}

function Toggle({
  title,
  body,
  on,
  locked = false,
  onChange,
}: {
  readonly title: string;
  readonly body: string;
  readonly on: boolean;
  readonly locked?: boolean;
  readonly onChange?: (on: boolean) => void;
}) {
  return (
    <div className="ac-tg">
      <div>
        <b>{title}</b>
        <small>{body}</small>
      </div>
      <label className="ac-sw2">
        <input
          type="checkbox"
          role="switch"
          checked={on}
          disabled={locked}
          aria-label={title}
          onChange={(event) => onChange?.(event.target.checked)}
        />
        <i />
      </label>
    </div>
  );
}

function PrivacyCard() {
  const t = useTranslations('account.settings');
  const { profile } = useAccount();
  const [asked, setAsked] = useState(false);
  return (
    <section className="ac-card" aria-labelledby="settings-privacy">
      <h2 id="settings-privacy">{t('privacy')}</h2>
      <div className="ac-acts">
        <Link className="btn ghost" href="/cookies">
          {t('cookies')}
        </Link>
        <button className="btn ghost" type="button" disabled={asked} onClick={() => setAsked(true)}>
          {t('download')}
        </button>
      </div>
      <div className="ac-live" role="status">
        {asked ? (
          <p className="ac-note">
            <Icon name="mail" />
            <span>{t('download-sent', { email: profile.email })}</span>
          </p>
        ) : null}
      </div>
    </section>
  );
}
