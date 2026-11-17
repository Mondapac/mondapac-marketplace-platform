'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '../form/button.tsx';
import { Icon } from '../icon/icon.tsx';
import { AiWriterModal, type InsertMode } from './ai-writer-modal.tsx';
import {
  loadWriterStatus,
  requestDraft,
  type WriterCall,
  type WriterRequest,
  type WriterStatus,
} from './writer-api.ts';
import {
  WRITER_COPY as C,
  clampCategory,
  clampDetails,
  clampTitle,
  type WriterDetail,
} from './writer-copy.ts';

export interface DescriptionWriterProps {
  /** The panel's `callApi`. */
  readonly call: WriterCall;
  /** `catalog/own/description-writer` (seller) or `catalog/admin/description-writer` (admin). */
  readonly base: string;
  readonly csrfToken: string;
  readonly title: string;
  /** The category label the form shows (a path such as "Pantry › Rice"). */
  readonly category: string;
  readonly details: readonly WriterDetail[];
  /** The description as it is now. */
  readonly current: string;
  /** Puts the new description into the field; the caller marks the form as edited. */
  readonly onText: (next: string) => void;
}

/** What the description becomes: the draft, or the draft after the text that is there. */
export function mergeDraft(current: string, draft: string, mode: InsertMode): string {
  if (mode === 'replace' || current.trim() === '') return draft;
  return `${current.replace(/\s+$/, '')}\n\n${draft}`;
}

/**
 * The "Write with AI" button for the end of the description field's head, and its modal. It asks
 * the API whether the writer is on and renders nothing when it is not (or when the answer fails).
 */
export function DescriptionWriter(props: DescriptionWriterProps) {
  const { call, base, csrfToken } = props;
  const [status, setStatus] = useState<WriterStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [writing, setWriting] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void loadWriterStatus(call, base, controller.signal).then((read) => {
      if (!controller.signal.aborted) setStatus(read);
    });
    return () => controller.abort();
  }, [call, base]);

  if (status === null || !status.available) return null;

  const generate = (request: WriterRequest, signal: AbortSignal) =>
    requestDraft(call, base, csrfToken, request, signal);

  return (
    <>
      <Button
        variant="secondary"
        className="h-(--mp-size-control-sm) text-sm"
        disabled={writing}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <Icon name="zap" className="me-1.5" />
        {writing ? C.buttonBusy : C.button}
      </Button>
      {createPortal(
        <AiWriterModal
          open={open}
          onClose={() => setOpen(false)}
          formTitle={clampTitle(props.title)}
          formCategory={clampCategory(props.category)}
          formDetails={clampDetails(props.details)}
          hasText={props.current.trim() !== ''}
          resetZone={status.resetZone}
          generate={generate}
          onWriting={setWriting}
          onOff={() => setStatus({ available: false, resetZone: status.resetZone })}
          onUse={(text, mode) => {
            props.onText(mergeDraft(props.current, text, mode));
            setOpen(false);
          }}
        />,
        document.body,
      )}
    </>
  );
}
