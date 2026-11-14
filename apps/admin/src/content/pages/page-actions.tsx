'use client';

import { Banner, Button, Dialog, TextField, toast } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { archivePath, detailRef, publishPath, type PageDetail } from './page-types.ts';
import {
  STALE_CODES,
  usePageCommand,
  useProblemText,
  type PageProblem,
} from './use-page-command.ts';

/** The address an archived page's URL may send buyers to: a site path (storefront `parseArchive`). */
const REDIRECT_PATTERN = /^\/(?!\/)[A-Za-z0-9/_.~-]*$/u;
export const REDIRECT_MAX = 200;
export const redirectProblem = (value: string): boolean =>
  value !== '' &&
  (value.length > REDIRECT_MAX || !REDIRECT_PATTERN.test(value) || value.split('/').includes('..'));

/** Whether the page has a draft a platform administrator may put in front of buyers. */
export const canPublishPage = (page: PageDetail): boolean =>
  page.status !== 'archived' &&
  page.editLevel !== 'locked' &&
  page.hasDraft &&
  page.draft.versionNo !== null &&
  page.draft.updatedAt !== null;

/** Only a landing page is archived; a system page of the app is not. */
export const canArchivePage = (page: PageDetail): boolean =>
  page.kind === 'dynamic' && page.status !== 'archived' && page.id !== null;

type Action = 'publish' | 'archive';

/**
 * Publish and Archive, the two changes only a platform administrator may make (their keys are
 * protected). Each asks first, says what buyers will see, and refuses nothing itself: the API
 * judges the key, the slot minimums and a draft that changed since it was reviewed.
 */
export function PageActions({
  page,
  canPublish,
  canArchive,
  csrfToken,
}: {
  readonly page: PageDetail;
  readonly canPublish: boolean;
  readonly canArchive: boolean;
  readonly csrfToken: string;
}) {
  const t = useTranslations('content.pages.actions');
  const router = useRouter();
  const problemText = useProblemText();
  const command = usePageCommand(csrfToken);
  const [open, setOpen] = useState<Action | null>(null);
  const [redirect, setRedirect] = useState('');
  const [touched, setTouched] = useState(false);
  const hintId = useId();

  const showPublish = canPublish && page.status !== 'archived';
  const showArchive = canArchive && canArchivePage(page);
  if (!showPublish && !showArchive) return null;
  const publishable = canPublishPage(page);
  const ref = detailRef(page);
  const redirectBad = redirectProblem(redirect.trim());

  function close() {
    command.reset();
    setOpen(null);
    setRedirect('');
    setTouched(false);
  }

  async function run(action: Action) {
    const body =
      action === 'publish'
        ? { versionNo: page.draft.versionNo, updatedAt: page.draft.updatedAt }
        : redirect.trim() === ''
          ? {}
          : { redirectTo: redirect.trim() };
    const result = await command.run(
      'POST',
      action === 'publish' ? publishPath(ref) : archivePath(ref),
      body,
    );
    if (result === null) return;
    if (!result.ok) return;
    toast.success(t(action === 'publish' ? 'published' : 'archived'));
    close();
    // The page is read again: the tabs start from what the API now holds.
    router.refresh();
  }

  const problem = command.problem;
  const stale =
    problem !== null &&
    (STALE_CODES.has(problem.code) || problem.code === 'storefront.draft-changed');

  return (
    <>
      <div className="mb-1 flex flex-wrap items-center gap-2">
        {showArchive ? (
          <Button
            variant="secondary"
            onClick={() => {
              command.reset();
              setOpen('archive');
            }}
          >
            {t('archive')}
          </Button>
        ) : null}
        {showPublish ? (
          <Button
            disabled={!publishable}
            aria-describedby={publishable ? undefined : hintId}
            onClick={() => {
              command.reset();
              setOpen('publish');
            }}
          >
            {t('publish')}
          </Button>
        ) : null}
        {showPublish && !publishable ? (
          <p id={hintId} className="basis-full text-sm text-fg-muted">
            {t('nothing-to-publish')}
          </p>
        ) : null}
      </div>
      {open === null ? null : (
        <Dialog
          open
          title={open === 'publish' ? t('publish-title') : t('archive-title')}
          onClose={close}
          actions={
            <>
              <Button variant="secondary" onClick={close}>
                {t('cancel')}
              </Button>
              {stale ? (
                <Button
                  onClick={() => {
                    close();
                    router.refresh();
                  }}
                >
                  {t('reload')}
                </Button>
              ) : open === 'publish' ? (
                <Button loading={command.pending} onClick={() => void run('publish')}>
                  {t('publish-confirm')}
                </Button>
              ) : (
                <Button
                  variant="destructive-solid"
                  loading={command.pending}
                  onClick={() => {
                    setTouched(true);
                    if (!redirectBad) void run('archive');
                  }}
                >
                  {t('archive-confirm')}
                </Button>
              )}
            </>
          }
        >
          <div className="flex flex-col gap-3">
            {problem === null ? null : (
              <Banner tone="critical">{publishProblemText(problem, problemText, t)}</Banner>
            )}
            {open === 'publish' ? (
              <>
                <p>{t('publish-body', { path: page.path })}</p>
                <p className="text-sm text-fg-muted">{t('publish-keeps')}</p>
              </>
            ) : (
              <>
                <p>{t('archive-body', { path: page.path })}</p>
                <TextField
                  label={t('redirect')}
                  value={redirect}
                  autoComplete="off"
                  placeholder="/offers"
                  help={t('redirect-help')}
                  error={touched && redirectBad ? t('redirect-bad') : undefined}
                  onChange={(event) => setRedirect(event.target.value)}
                />
              </>
            )}
          </div>
        </Dialog>
      )}
    </>
  );
}

function publishProblemText(
  problem: PageProblem,
  fallback: (problem: PageProblem) => string,
  t: (key: string) => string,
): string {
  if (problem.code === 'storefront.nothing-to-publish') return t('error-nothing');
  if (problem.code === 'storefront.draft-changed') return t('error-changed');
  if (problem.status === 403) return t('error-denied');
  if (problem.fields.some((field) => field.code === 'too-few-modules')) return t('error-too-few');
  return fallback(problem);
}
