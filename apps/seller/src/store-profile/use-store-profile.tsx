'use client';

import {
  Banner,
  SettingRow,
  SettingsErrorSummary,
  SettingsSection,
  SettingTextArea,
  toast,
  useLiveErrors,
  useSettingsForm,
  type FieldChange,
  type SaveResult,
  type SettingsErrorItem,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useRef, useState, type ReactNode } from 'react';
import { callApi } from '../api/client.ts';
import { preparePhoto } from '../catalog/photo-prepare.ts';
import { SettingsConflictView } from '../settings/conflict-view.tsx';
import { claimsCertification } from './claim-terms.ts';
import { saveProblemOf, type ImageProblem, type SaveProblem } from './errors.ts';
import {
  PicturesSection,
  pictureRowId,
  type PictureProps,
  type PictureView,
} from './pictures-section.tsx';
import type { ImageKind, StoreImageRef, StoreProfileView } from './types.ts';

/** Characters as a person counts them (code points), as the API does. */
const lengthOf = (text: string): number => [...text].length;

/** The name of a locale in the panel's language ("Japanese"), or the code when it has none. */
function languageName(code: string, uiLocale: string): string {
  try {
    return new Intl.DisplayNames([uiLocale], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** What the form holds as saved: the About texts, the pictures and the version they were saved at. */
type Saved = Pick<StoreProfileView, 'version' | 'about' | 'logo' | 'banner'>;

/**
 * What the draft does with a picture: keeps the saved one, removes it, or replaces it with a
 * chosen file (already shrunk in the browser; `data` is base64 JPEG text, shown as a preview).
 */
export type PictureDraft =
  | { readonly action: 'keep' }
  | { readonly action: 'remove' }
  | { readonly action: 'set'; readonly data: string };

interface Draft {
  readonly about: Readonly<Record<string, string>>;
  readonly logo: PictureDraft;
  readonly banner: PictureDraft;
}

const KINDS: readonly ImageKind[] = ['logo', 'banner'];
const STORE_PROFILE_PATH = 'sellers/store-profile';
const KEEP: PictureDraft = { action: 'keep' };
const savedOf = (view: StoreProfileView): Saved => ({
  version: view.version,
  about: view.about,
  logo: view.logo,
  banner: view.banner,
});
const toDraft = (saved: Saved): Draft => ({ about: { ...saved.about }, logo: KEEP, banner: KEEP });
const versionOf = (saved: Saved) => saved.version;
async function reload(): Promise<Saved | null> {
  const fresh = await callApi<StoreProfileView>('GET', STORE_PROFILE_PATH);
  return fresh.ok ? savedOf(fresh.body) : null;
}

const rowId = (locale: string) => `setting-about-${locale}`;
/** The record without one key. */
function omit<V>(
  record: Partial<Record<ImageKind, V>>,
  kind: ImageKind,
): Partial<Record<ImageKind, V>> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => key !== kind));
}

const NO_PROBLEM: SaveProblem = { banner: null, fields: {}, pictures: {} };

/** The picture a draft shows: the staged file, the saved one, or none. */
function shown(saved: StoreImageRef | null, draft: PictureDraft): PictureView {
  if (draft.action === 'set') return { kind: 'staged', data: draft.data };
  if (draft.action === 'remove' || saved === null) return { kind: 'none' };
  return { kind: 'saved', image: saved };
}

/**
 * The store profile page's state: the About text per locale and the logo and banner, as one
 * draft saved in one write with the version it loaded. A picture is staged here (chosen or
 * removed) and only goes up when the page saves. The page owns the save bar, so this keeps the
 * state and gives the page what it shows.
 */
export function useStoreProfile({
  initial,
  csrfToken,
  claimTerms = [],
}: {
  readonly initial: StoreProfileView;
  readonly csrfToken: string;
  readonly claimTerms?: readonly string[];
}) {
  const t = useTranslations();
  const uiLocale = useLocale();
  const { locales, aboutMaxLength } = initial;
  const [problem, setProblem] = useState<SaveProblem | null>(null);
  // Pictures the browser could not take (too large, unreadable): nothing is staged for them.
  const [refused, setRefused] = useState<Partial<Record<ImageKind, ImageProblem>>>({});
  const [preparing, setPreparing] = useState<Partial<Record<ImageKind, boolean>>>({});
  const [refusals, setRefusals] = useState(0);
  const picking = useRef(false);
  const label = (locale: string) =>
    t('store-profile.about.field', { language: languageName(locale, uiLocale) });
  const empty = t('settings.conflict.unset');
  const pictureChange = (
    kind: ImageKind,
    saved: StoreImageRef | null,
    draft: PictureDraft,
  ): readonly FieldChange[] =>
    draft.action === 'keep'
      ? []
      : [
          {
            key: kind,
            label: t(`store-profile.${kind}.title`),
            saved: saved === null ? empty : t('store-profile.pictures.current'),
            yours:
              draft.action === 'remove'
                ? t('store-profile.pictures.removed')
                : t('store-profile.pictures.new'),
          },
        ];
  // The version the texts were loaded at: a save names it, and a newer text elsewhere is a
  // conflict that keeps these drafts and lists, per locale, what is saved now and what is typed.
  const form = useSettingsForm<Saved, Draft>({
    initial: savedOf(initial),
    toDraft,
    versionOf,
    reload,
    changes: (saved, draft): readonly FieldChange[] => [
      ...locales
        .filter((locale) => (draft.about[locale] ?? '') !== (saved.about[locale] ?? ''))
        .map((locale) => ({
          key: locale,
          label: label(locale),
          saved: saved.about[locale] || empty,
          yours: draft.about[locale] || empty,
        })),
      ...KINDS.flatMap((kind) => pictureChange(kind, saved[kind], draft[kind])),
    ],
  });
  const draft = form.draft;
  const base = form.saved;

  const changed = (locale: string) => (draft.about[locale] ?? '') !== (base.about[locale] ?? '');
  const count = form.count;
  // The rule a text breaks right now, worked out here as it is typed: too long, or wording that
  // claims a certification (the terms come from the API; the save check stays the authority).
  const ruleNow = (locale: string): 'length' | 'claim-term' | undefined => {
    const text = draft.about[locale] ?? '';
    if (lengthOf(text) > aboutMaxLength) return 'length';
    return claimsCertification(text, claimTerms) ? 'claim-term' : undefined;
  };
  const live = useLiveErrors<string>(locales.filter((locale) => ruleNow(locale) !== undefined));
  const errorOf = (locale: string): string | undefined => {
    // What the server refused outranks the live reading until the text is edited again.
    const rule = problem?.fields[locale] ?? (live.has(locale) ? ruleNow(locale) : undefined);
    return rule === undefined
      ? undefined
      : t(`store-profile.about.rule.${rule}`, { max: aboutMaxLength });
  };
  const invalid = locales.filter((locale) => errorOf(locale) !== undefined);
  const pictureProblem = (kind: ImageKind): ImageProblem | undefined => problem?.pictures[kind];
  const wording = (found: ImageProblem) =>
    t(`store-profile.image.error.${found.key}`, { seconds: found.retryAfterSeconds ?? 60 });
  const invalidPictures = KINDS.filter((kind) => pictureProblem(kind) !== undefined);

  async function save() {
    if (form.saving || count === 0) return;
    if (locales.some((locale) => ruleNow(locale) !== undefined)) {
      live.attempt();
      return;
    }
    if (invalid.length > 0 || invalidPictures.length > 0) return;
    setProblem(null);
    const about = Object.fromEntries(locales.map((locale) => [locale, draft.about[locale] ?? '']));
    const pictures = Object.fromEntries(
      KINDS.flatMap((kind) => {
        const choice = draft[kind];
        if (choice.action === 'keep') return [];
        return [[kind, choice.action === 'remove' ? null : { data: choice.data }]];
      }),
    );
    const result = await form.run(async (expectedVersion): Promise<SaveResult<Saved>> => {
      const reply = await callApi<StoreProfileView>(
        'PUT',
        STORE_PROFILE_PATH,
        { expectedVersion, about, ...pictures },
        csrfToken,
      );
      if (reply.ok) return { status: 'saved', saved: savedOf(reply.body) };
      if (reply.failure.status === 401) {
        window.location.assign('/session-ended');
        return { status: 'failed' };
      }
      const next = saveProblemOf(reply.failure);
      if (next.banner === 'stale') return { status: 'conflict' };
      setProblem(next);
      if (Object.keys(next.fields).length > 0 || Object.keys(next.pictures).length > 0) {
        setRefusals((n) => n + 1);
      }
      return { status: 'failed' };
    });
    if (result.status === 'saved') {
      live.reset();
      toast.success(t('store-profile.saved'));
    }
    // The re-read failed too: the plain "reload the page" message is all that is left.
    else if (result.status === 'conflict' && result.reloaded === false) {
      setProblem({ ...NO_PROBLEM, banner: 'stale' });
    }
  }

  function discard() {
    form.discard();
    live.reset();
    setProblem(null);
    setRefused({});
  }

  /** Stages a picture choice; the problem of that picture (and only that one) is over. */
  function stage(kind: ImageKind, choice: PictureDraft) {
    // Removing a picture that was never saved just takes the staged one back.
    const next = choice.action === 'remove' && base[kind] === null ? KEEP : choice;
    form.setDraft((current) => ({ ...current, [kind]: next }));
    setRefused((current) => omit(current, kind));
    setProblem((current) => {
      if (current === null || current.pictures[kind] === undefined) return current;
      return { ...current, pictures: omit(current.pictures, kind) };
    });
  }

  async function choose(kind: ImageKind, files: FileList | null) {
    const file = files?.[0];
    if (file === undefined || picking.current) return;
    picking.current = true;
    setPreparing((current) => ({ ...current, [kind]: true }));
    const prepared = await preparePhoto(file);
    picking.current = false;
    setPreparing((current) => ({ ...current, [kind]: false }));
    if (prepared.kind === 'refused') {
      setRefused((current) => ({
        ...current,
        [kind]: { key: prepared.reason === 'too-large' ? 'too-large' : 'unreadable' },
      }));
    } else stage(kind, { action: 'set', data: prepared.data });
  }

  const pictureProps = (kind: ImageKind): PictureProps => {
    const server = pictureProblem(kind);
    const local = refused[kind];
    return {
      view: shown(base[kind], draft[kind]),
      changed: draft[kind].action !== 'keep',
      preparing: preparing[kind] === true,
      error: server === undefined ? undefined : wording(server),
      notice: local === undefined ? undefined : wording(local),
      onChoose: (files) => void choose(kind, files),
      onRemove: () => stage(kind, { action: 'remove' }),
    };
  };

  const banner = problem?.banner ?? null;
  const errorItems: SettingsErrorItem[] = [
    ...invalid.map((locale) => ({
      id: rowId(locale),
      label: label(locale),
      reason: errorOf(locale),
    })),
    ...invalidPictures.map((kind) => ({
      id: pictureRowId(kind),
      label: t(`store-profile.${kind}.title`),
    })),
  ];
  const errorCount = errorItems.length;

  /** The conflict, the error summary and the other problems, for the page's banner slot. */
  const banners: ReactNode[] = [
    errorCount === 0 ? null : (
      <SettingsErrorSummary
        key="invalid"
        title={t('settings.errors.title', { count: errorCount })}
        items={errorItems}
        focusSignal={live.attempts + refusals}
      />
    ),
    form.theirs === null ? null : (
      <SettingsConflictView key="conflict" conflictId={form.conflictId} changes={form.changes} />
    ),
    banner === null ? null : (
      <Banner key="problem" tone="critical">
        {banner === 'throttled'
          ? t('store-profile.about.error.throttled', {
              seconds: problem?.retryAfterSeconds ?? 60,
            })
          : t(`store-profile.about.error.${banner}`)}
      </Banner>
    ),
  ].filter((node) => node !== null);

  return {
    dirty: count > 0,
    count,
    errorCount,
    saving: form.saving,
    banners,
    save,
    discard,
    about: (canEdit: boolean) => (
      <AboutSection
        locales={locales}
        draft={draft.about}
        max={aboutMaxLength}
        canEdit={canEdit}
        label={label}
        changed={changed}
        errorOf={errorOf}
        onChange={(locale, text) => {
          form.setDraft((current) => ({ ...current, about: { ...current.about, [locale]: text } }));
          live.touch(locale);
          if (problem !== null) setProblem({ ...problem, banner: null, fields: {} });
        }}
        onLeave={live.touch}
      />
    ),
    pictures: (canEdit: boolean) => (
      <PicturesSection
        canEdit={canEdit}
        saving={form.saving}
        pictures={{ logo: pictureProps('logo'), banner: pictureProps('banner') }}
      />
    ),
  };
}

function AboutSection({
  locales,
  draft,
  max,
  canEdit,
  label,
  changed,
  errorOf,
  onChange,
  onLeave,
}: {
  readonly locales: readonly string[];
  readonly draft: Readonly<Record<string, string>>;
  readonly max: number;
  readonly canEdit: boolean;
  readonly label: (locale: string) => string;
  readonly changed: (locale: string) => boolean;
  readonly errorOf: (locale: string) => string | undefined;
  readonly onChange: (locale: string, text: string) => void;
  readonly onLeave: (locale: string) => void;
}) {
  const t = useTranslations();
  return (
    <SettingsSection
      title={t('store-profile.about.title')}
      description={t('store-profile.about.description')}
    >
      {locales.map((locale) => {
        const text = draft[locale] ?? '';
        const count = lengthOf(text);
        return (
          <SettingRow
            key={locale}
            id={rowId(locale)}
            label={label(locale)}
            help={t('store-profile.about.help')}
            changed={changed(locale)}
            disabled={!canEdit}
            error={errorOf(locale)}
          >
            <SettingTextArea
              lang={locale}
              dir="auto"
              value={text}
              rows={8}
              onChange={(event) => onChange(locale, event.target.value)}
              onBlur={() => onLeave(locale)}
              counter={
                <span className={count > max ? 'text-critical-fg' : undefined}>
                  {t('store-profile.about.counter', { count, max })}
                </span>
              }
            />
          </SettingRow>
        );
      })}
    </SettingsSection>
  );
}
