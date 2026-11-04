'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { Icon } from '../icons/icon.tsx';
import { PalettePicker } from '../preferences/palette-picker.tsx';
import type { Palette, TextSize } from '../preferences/preferences.ts';
import { TextSizeToggle } from '../preferences/text-size-toggle.tsx';
import type { EmailChoices } from '../storefront/types.ts';
import { AccountFrame } from './account-area.tsx';
import { useAccount, type PasswordOutcome, type Profile } from './account-state.tsx';
import { DeletionEntry, useDeletion } from './account-deletion.tsx';
import { saveLanguage } from './customer-api.ts';
import { AcField, PasswordField } from './fields.tsx';

/**
 * Settings: Profile, Password (always open), Appearance (saved to the account, john 19 Oct; the
 * browser keeps a copy for first paint), Emails and Privacy. Delete account is in Privacy, and only
 * while the Market has switched it on (Off by default; otherwise a line pointing to support).
 * Live: the name, password and look go to the API; the email is read-only and the mobile field is
 * hidden (no backend yet). Sample: saving changes this tab's state only.
 */
export function AccountSettings({
  palette,
  textSize,
  languages = [],
  language = null,
}: {
  readonly palette: Palette;
  readonly textSize: TextSize;
  /** The languages the Market has published, the default first; the Language card shows when there is more than one. */
  readonly languages?: readonly string[];
  /** The language kept on the account, or null. */
  readonly language?: string | null;
}) {
  const title = useTranslations('account.titles')('settings');
  return (
    <AccountFrame title={title}>
      <ProfileCard />
      {languages.length > 1 ? <LanguageCard languages={languages} current={language} /> : null}
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
  // Both values go to the API on each choice, so the other one is kept.
  const [look, setLook] = useState({ palette, textSize });
  // Cleared first, so a second choice is read out again.
  const announce = () => {
    setSaved(false);
    requestAnimationFrame(() => setSaved(true));
  };
  return (
    <section className="ac-card ac-look" aria-labelledby="settings-look">
      <h2 id="settings-look">{t('appearance')}</h2>
      <PalettePicker
        initial={palette}
        onChoose={(choice) => {
          setLook({ ...look, palette: choice });
          saveAppearance({ ...look, palette: choice });
          announce();
        }}
      />
      <TextSizeToggle
        initial={textSize}
        onChoose={(choice) => {
          setLook({ ...look, textSize: choice });
          saveAppearance({ ...look, textSize: choice });
          announce();
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

/** Each language in its own script with its English name, so a reader finds theirs and the way back. */
const LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  en: 'English',
  fa: 'فارسی (Persian)',
  ar: 'العربية (Arabic)',
};

/**
 * Language: the only place a buyer chooses one (no switcher in the header; guests and Google
 * sign-in read English). Shown only when the Market has published another language. The choice is
 * saved with a button, never on change (changing a select is not a request to change context);
 * the page reloads in the language only after the save worked, and a refused save leaves the
 * saved language in the select.
 */
function LanguageCard({
  languages,
  current,
}: {
  readonly languages: readonly string[];
  readonly current: string | null;
}) {
  const t = useTranslations('account.settings');
  const router = useRouter();
  const { source } = useAccount();
  const kept = current !== null && languages.includes(current) ? current : 'en';
  const [saved, setSaved] = useState(kept);
  const [value, setValue] = useState(kept);
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  const id = useId();
  return (
    <section className="ac-card" aria-labelledby="settings-language">
      <h2 id="settings-language">{t('language')}</h2>
      <form
        className="ac-f"
        onSubmit={(event) => {
          event.preventDefault();
          if (value === saved || state === 'saving') return;
          if (!source.live) {
            setSaved(value);
            return setState('saved');
          }
          setState('saving');
          void saveLanguage(value === 'en' ? null : value).then((result) => {
            if (result.kind !== 'ok') {
              setValue(saved);
              return setState('failed');
            }
            setSaved(value);
            setState('saved');
            router.refresh();
          });
        }}
      >
        <div className="ac-fld">
          <label htmlFor={id}>{t('language-label')}</label>
          <select
            id={id}
            value={value}
            aria-describedby={`${id}-hint`}
            onChange={(event) => {
              setValue(event.target.value);
              setState('idle');
            }}
          >
            {languages.map((code) => (
              <option key={code} value={code} lang={code}>
                {LANGUAGE_NAMES[code] ?? code}
              </option>
            ))}
          </select>
          <small id={`${id}-hint`}>{t('language-hint')}</small>
        </div>
        {state === 'failed' ? (
          <p className="ac-note ac-warn" role="alert">
            <Icon name="info" />
            <span>{t('language-failed')}</span>
          </p>
        ) : null}
        <div className="ac-acts ac-mid">
          <button className="btn" type="submit" disabled={state === 'saving' || value === saved}>
            {t('language-save')}
          </button>
          <span className="ac-live" role="status">
            {state === 'saved' ? (
              <span className="ac-badge ok">
                <Icon name="check" />
                {t('language-saved')}
              </span>
            ) : null}
          </span>
        </div>
      </form>
    </section>
  );
}

function ProfileCard() {
  const t = useTranslations('account.settings');
  const { profile, saveProfile, source } = useAccount();
  const live = source.live;
  const [draft, setDraft] = useState<Profile>(profile);
  const [saved, setSaved] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const set = (key: keyof Profile) => (text: string) => {
    setSaved(false);
    setProblem(undefined);
    setDraft({ ...draft, [key]: text });
  };
  return (
    <section className="ac-card" aria-labelledby="settings-profile">
      <h2 id="settings-profile">{t('profile')}</h2>
      <form
        className="ac-f"
        onSubmit={(event) => {
          event.preventDefault();
          void saveProfile({
            fullName: draft.fullName.trim() || profile.fullName,
            email: draft.email.trim() || profile.email,
            mobile: draft.mobile.trim(),
          }).then((result) => {
            if (result.ok) return setSaved(true);
            const code = result.fields.find((f) => f.path === 'displayName')?.code;
            setProblem(
              code === 'length' || code === 'characters' ? t(`name-${code}`) : t('save-failed'),
            );
          });
        }}
      >
        <AcField
          label={t('full-name')}
          autoComplete="name"
          value={draft.fullName}
          onText={set('fullName')}
          hint={t('name-hint')}
          error={problem}
          required
        />
        <AcField
          label={t('email')}
          type="email"
          autoComplete="email"
          value={live ? profile.email : draft.email}
          onText={set('email')}
          hint={live ? t('email-later') : t('email-hint')}
          readOnly={live}
          required
        />
        {live ? null : (
          <AcField
            label={t('mobile')}
            autoComplete="tel"
            inputMode="tel"
            value={draft.mobile}
            onText={set('mobile')}
          />
        )}
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
  const { changePassword } = useAccount();
  // What the API refused (live): shown beside the field it is about, or as a note.
  const [refused, setRefused] = useState<Exclude<PasswordOutcome, 'ok'> | null>(null);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [tried, setTried] = useState(false);
  const [done, setDone] = useState(false);
  const errors = {
    current:
      current === ''
        ? t('current-missing')
        : refused === 'current-incorrect'
          ? t('current-incorrect')
          : undefined,
    next: next.length < 10 ? t('too-short') : refused === 'rejected' ? t('rejected') : undefined,
    again: again !== next ? t('mismatch') : undefined,
  };
  const edit = (setter: (text: string) => void) => (text: string) => {
    setDone(false);
    setRefused(null);
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
          void changePassword(current, next).then((outcome) => {
            if (outcome !== 'ok') return setRefused(outcome);
            setCurrent('');
            setNext('');
            setAgain('');
            setTried(false);
            setDone(true);
          });
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
        {refused === 'throttled' || refused === 'failed' || refused === 'invalid' ? (
          <p className="ac-note ac-warn" role="alert">
            <Icon name="info" />
            <span>{t(`password-${refused}`)}</span>
          </p>
        ) : null}
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
  const { profile, source } = useAccount();
  const deletion = useDeletion(source.live);
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
      <DeletionEntry deletion={deletion} />
    </section>
  );
}
