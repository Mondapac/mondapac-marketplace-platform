'use client';

import {
  BackLink,
  Banner,
  Button,
  Dialog,
  SaveBar,
  SettingCheckbox,
  SettingInput,
  SettingRow,
  SettingsConflictBanner,
  SettingsErrorSummary,
  SettingsPage,
  SettingsSection,
  toast,
} from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { callApi, type ApiFailure } from '../api/client.ts';
import { useSettingsChrome } from '../settings/settings-chrome.ts';
import { groupByResource, humanise } from './role-name.ts';
import type { RoleCatalogue, RoleRecord } from './types.ts';

const MAX_NAME = 80;
const MAX_KEYS = 40;
const CONTROL = /[\p{Cc}‎‏‪-‮⁦-⁩]/u;

/** Answers that mean the role changed or went away meanwhile: the page is reloaded. */
const RELOAD: ReadonlySet<string> = new Set(['conflict.stale', 'role.unknown', 'role.read-only']);
const NAME_ROW = 'setting-role-name';

interface Written {
  readonly code: string;
  readonly roleId: string;
}

/** B3 / B4: create, edit, duplicate or delete a custom platform role. */
export function RoleEditor({
  role,
  catalogue,
  csrfToken,
  initialName,
  initialKeys,
}: {
  /** The custom role being edited; absent when creating (also when duplicating). */
  readonly role?: RoleRecord;
  readonly catalogue: RoleCatalogue;
  readonly csrfToken: string;
  readonly initialName: string;
  readonly initialKeys: readonly string[];
}) {
  const t = useTranslations('identity.roles');
  const root = useTranslations();
  const chrome = useSettingsChrome();
  const router = useRouter();
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const [name, setName] = useState(initialName);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set(initialKeys));
  const [nameError, setNameError] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [failedSaves, setFailedSaves] = useState(0);
  const [done, setDone] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const editing = role !== undefined;
  const keyInfo = new Map(catalogue.keys.map((entry) => [entry.key, entry]));
  const groups = groupByResource(catalogue.keys.map((entry) => entry.key));
  const canDelete = editing && role.actions.delete.allowed;
  const initialSet = new Set(initialKeys);
  const keyChanged = (key: string) => selected.has(key) !== initialSet.has(key);
  const nameChanged = name !== initialName;
  const count =
    (nameChanged ? 1 : 0) + catalogue.keys.filter((entry) => keyChanged(entry.key)).length;
  // A new role is unsaved by definition, so its bar always shows; an edit shows it from a change.
  const shownCount = editing ? count : Math.max(count, 1);

  function discard() {
    setName(initialName);
    setSelected(new Set(initialKeys));
    setNameError(null);
    setProblem(null);
    setConflict(null);
  }

  function messageFor(code: string): string {
    if (t.has(`reason.${code}`)) return t(`reason.${code}`);
    if (root.has(`identity.members.reason.${code}`)) return root(`identity.members.reason.${code}`);
    if (root.has(`identity.error.${code}`)) return root(`identity.error.${code}`);
    return root('identity.error.unknown');
  }

  async function run(task: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    try {
      await task();
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  function toggle(key: string, on: boolean) {
    setSelected((previous) => {
      const next = new Set(previous);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  function fail(failure: ApiFailure) {
    if (failure.status === 401) {
      router.replace('/session-ended');
      return;
    }
    if (failure.code === 'validation.failed') {
      const fields = failure.details?.fields ?? [];
      if (fields.some((field) => field.path === 'name')) setNameError(t('editor.name-invalid'));
      else setProblem(messageFor('unknown'));
      return;
    }
    if (failure.code === 'role.name-taken') {
      setNameError(t('reason.role.name-taken'));
      return;
    }
    if (RELOAD.has(failure.code)) router.refresh();
    if (failure.code === 'conflict.stale') {
      // Someone changed the role first: the page reloads with what is stored now.
      setConflict(messageFor(failure.code));
      return;
    }
    setProblem(messageFor(failure.code));
  }

  async function submit() {
    setNameError(null);
    setProblem(null);
    setConflict(null);
    const trimmed = name.trim();
    if (trimmed === '') {
      setNameError(t('editor.name-required'));
      setFailedSaves((n) => n + 1);
      return;
    }
    if (trimmed.length > MAX_NAME || CONTROL.test(trimmed)) {
      setNameError(t('editor.name-invalid'));
      setFailedSaves((n) => n + 1);
      return;
    }
    if (selected.size > MAX_KEYS) {
      setProblem(t('editor.too-many', { max: MAX_KEYS }));
      return;
    }
    await run(async () => {
      const body = { name: trimmed, permissionKeys: [...selected].sort() };
      const result = editing
        ? await callApi<Written>('PUT', `identity/admin/roles/${role.roleId}`, body, csrfToken)
        : await callApi<Written>('POST', 'identity/admin/roles', body, csrfToken);
      if (!result.ok) {
        fail(result.failure);
        return;
      }
      // Saved: leaving this page is no longer a loss.
      setDone(true);
      if (editing) {
        toast.success(t('editor.saved'));
        router.refresh();
      } else {
        // The page of the new role shows the outcome.
        toast.flash('success', t('editor.saved'));
        router.push(`/settings/roles/${result.body.roleId}`);
      }
    });
  }

  async function remove() {
    if (!editing) return;
    await run(async () => {
      const result = await callApi<Written>(
        'DELETE',
        `identity/admin/roles/${role.roleId}`,
        undefined,
        csrfToken,
      );
      setConfirmDelete(false);
      if (!result.ok) {
        fail(result.failure);
        return;
      }
      router.push('/settings/roles');
    });
  }

  const banners = [
    nameError === null ? null : (
      <SettingsErrorSummary
        key="invalid"
        title={root('settings.errors.title', { count: 1 })}
        items={[{ id: NAME_ROW, label: t('editor.name') }]}
        focusSignal={failedSaves}
      />
    ),
    conflict === null ? null : (
      <SettingsConflictBanner key="conflict" title={t('editor.conflict-title')} body={conflict} />
    ),
    problem === null ? null : (
      <Banner key="problem" tone="critical">
        {problem}
      </Banner>
    ),
  ].filter((node) => node !== null);

  return (
    <div className="flex flex-col gap-2">
      <BackLink href="/settings/roles" label={t('back')} />
      <SettingsPage
        title={editing ? t('editor.title-edit') : t('editor.title-create')}
        banner={
          banners.length === 0 ? undefined : <div className="flex flex-col gap-3">{banners}</div>
        }
        onSubmit={() => void submit()}
        dirty={!done && count > 0}
        leave={chrome.leave}
        saveBar={
          <SaveBar
            {...chrome.saveBar({
              count: shownCount,
              errorCount: nameError === null ? 0 : 1,
              saving: pending,
              onDiscard: discard,
              saveLabel: editing ? t('editor.save') : t('editor.create'),
            })}
          />
        }
      >
        <SettingsSection title={t('editor.section-name')}>
          <SettingRow
            id={NAME_ROW}
            label={t('editor.name')}
            help={t('editor.name-help', { max: MAX_NAME })}
            changed={nameChanged}
            error={nameError ?? undefined}
          >
            <SettingInput
              maxLength={MAX_NAME}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setNameError(null);
              }}
            />
          </SettingRow>
        </SettingsSection>
        <p className="text-fg-muted" aria-live="polite">
          {t('selected', { selected: selected.size, total: catalogue.keys.length })}
        </p>
        {groups.map(([resource, keys]) => (
          <SettingsSection
            key={resource}
            title={
              root.has(`permission.resource.${resource}`)
                ? root(`permission.resource.${resource}`)
                : humanise(resource.split('.')[1] ?? resource)
            }
          >
            {keys.map((key) => {
              const info = keyInfo.get(key);
              const locked = info === undefined || !info.grantable;
              const label = root.has(`permission.${key}.label`)
                ? root(`permission.${key}.label`)
                : humanise(key.split('.').slice(2).join(' '));
              return (
                <SettingRow
                  key={key}
                  label={label}
                  {...(info?.protected === true
                    ? { help: t('editor.protected-help') }
                    : locked
                      ? { help: t('editor.not-grantable-help') }
                      : {})}
                  changed={keyChanged(key)}
                  disabled={locked || pending}
                >
                  <SettingCheckbox
                    checked={selected.has(key)}
                    onChange={(event) => toggle(key, event.target.checked)}
                  />
                </SettingRow>
              );
            })}
          </SettingsSection>
        ))}
        {canDelete ? (
          <SettingsSection
            variant="danger"
            title={root('settings.danger.title')}
            description={t('editor.delete-body')}
          >
            <SettingRow label={t('editor.delete')} plain>
              <Button
                variant="destructive"
                type="button"
                disabled={pending}
                onClick={() => setConfirmDelete(true)}
              >
                {t('editor.delete')}
              </Button>
            </SettingRow>
          </SettingsSection>
        ) : null}
        <Dialog
          open={confirmDelete}
          title={t('editor.delete-title', { name: initialName })}
          onClose={() => {
            if (!pending) setConfirmDelete(false);
          }}
          actions={
            <>
              <Button
                variant="secondary"
                disabled={pending}
                onClick={() => setConfirmDelete(false)}
              >
                {t('editor.keep')}
              </Button>
              <Button variant="destructive" loading={pending} onClick={() => void remove()}>
                {t('editor.delete-confirm')}
              </Button>
            </>
          }
        >
          <p>{t('editor.delete-body')}</p>
        </Dialog>
      </SettingsPage>
    </div>
  );
}
