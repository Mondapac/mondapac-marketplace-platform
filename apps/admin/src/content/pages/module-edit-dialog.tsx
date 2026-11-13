'use client';

import { Banner, Button, Dialog } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { ModuleForm, type FieldCodes } from './module-form.tsx';
import { blankConfig, configOf } from './module-schema.ts';
import { useProblemText, type PageProblem } from './use-page-command.ts';

/**
 * One module's settings in a dialog (a full-screen sheet on a phone): a new module starts from
 * its blank settings, an existing one from the draft's. Save writes the draft; the API checks
 * every setting and its refusals are shown on the field they name. Nothing is kept on Cancel.
 */
export function ModuleEditDialog({
  module,
  name,
  initial,
  problem,
  pending,
  onSave,
  onClose,
}: {
  readonly module: string;
  /** The module's name as buyers' editors know it ("Banner"). */
  readonly name: string;
  /** The settings of the module being edited; absent: a module being added. */
  readonly initial: Readonly<Record<string, unknown>> | null;
  readonly problem: PageProblem | null;
  readonly pending: boolean;
  readonly onSave: (config: Record<string, unknown>) => void;
  readonly onClose: () => void;
}) {
  const t = useTranslations('content.pages.editor');
  const [draft, setDraft] = useState<Record<string, unknown>>(() =>
    initial === null ? blankConfig(module) : structuredClone(initial),
  );
  const errors: FieldCodes = new Map(
    problem?.code === 'validation.failed' ? problem.fields.map((f) => [f.path, f.code]) : [],
  );
  const problemText = useProblemText();
  return (
    <Dialog
      open
      size="form"
      title={initial === null ? t('add-title', { name }) : t('edit-title', { name })}
      onClose={onClose}
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button loading={pending} onClick={() => onSave(configOf(draft))}>
            {t('save-draft')}
          </Button>
        </>
      }
      actionsNote={t('save-note')}
    >
      <div className="flex flex-col gap-4 text-fg">
        {problem === null ? null : <Banner tone="critical">{problemText(problem)}</Banner>}
        <ModuleForm module={module} draft={draft} errors={errors} onChange={setDraft} />
      </div>
    </Dialog>
  );
}
