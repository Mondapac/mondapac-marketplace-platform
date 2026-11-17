'use client';

import { toast } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { RelaxDialog } from './attribute-detail.tsx';
import { ArchiveDialog, ConvertTypeDialog, MergeAttributesDialog } from './restructure-dialogs.tsx';
import { API_ATTRIBUTES, type AttributeDetail } from './types.ts';

export type RowChange = 'merge-attribute' | 'convert' | 'archive' | 'relax';

/**
 * A change opened from a row of the Attributes list. The dialogs need the whole attribute (its
 * values, its version), so this reads it first and then shows the same dialog the attribute page
 * shows; when the change is made the list reads again. A read that fails is told in a toast.
 */
export function AttributeRowDialog({
  attributeId,
  change,
  csrfToken,
  onClose,
  onChanged,
  onOpenWaiting,
}: {
  readonly attributeId: string;
  readonly change: RowChange;
  readonly csrfToken: string;
  readonly onClose: () => void;
  /** The change was made: the list reads again. */
  readonly onChanged: () => void;
  readonly onOpenWaiting: () => void;
}) {
  const t = useTranslations('attributes.detail');
  const [detail, setDetail] = useState<AttributeDetail | null>(null);
  const [reads, setReads] = useState(0);
  // The list's own setter is a new function each render: it must not read the attribute again.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    let current = true;
    void callApi<AttributeDetail>(
      'GET',
      `${API_ATTRIBUTES}/${encodeURIComponent(attributeId)}`,
    ).then((result) => {
      if (!current) return;
      if (result.ok) {
        setDetail(result.body);
        return;
      }
      if (result.failure.status === 401) {
        window.location.assign('/session-ended');
        return;
      }
      toast.error(t('load-error'));
      onClose();
    });
    return () => {
      current = false;
    };
  }, [attributeId, reads, t]);

  if (detail === null) return null;
  const done = (message: string) => {
    toast.success(message);
    onClose();
    onChanged();
  };
  const reload = () => {
    setDetail(null);
    setReads((value) => value + 1);
  };
  if (change === 'merge-attribute') {
    return (
      <MergeAttributesDialog
        detail={detail}
        csrfToken={csrfToken}
        onClose={onClose}
        onDone={() => done(t('attribute-merged'))}
        onReload={reload}
      />
    );
  }
  if (change === 'convert') {
    return (
      <ConvertTypeDialog
        detail={detail}
        csrfToken={csrfToken}
        onClose={onClose}
        onDone={() => done(t('type-converted'))}
        onReload={reload}
      />
    );
  }
  if (change === 'relax') {
    return (
      <RelaxDialog
        detail={detail}
        csrfToken={csrfToken}
        onClose={onClose}
        onDone={() => done(t('relax-sent'))}
        onReload={reload}
        onOpenWaiting={onOpenWaiting}
      />
    );
  }
  return (
    <ArchiveDialog
      detail={detail}
      csrfToken={csrfToken}
      onClose={onClose}
      onDone={() => done(t('archived'))}
      onRequested={() => {
        toast.success(t('archive-requested'));
        onClose();
      }}
      onReload={reload}
      onOpenWaiting={onOpenWaiting}
    />
  );
}
