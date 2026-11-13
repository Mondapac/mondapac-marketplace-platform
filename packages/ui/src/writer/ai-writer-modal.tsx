'use client';

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Banner } from '../form/banner.tsx';
import { Button } from '../form/button.tsx';
import { IconButton } from '../form/icon-button.tsx';
import { RadioGroup } from '../form/radio-group.tsx';
import { Select } from '../form/select.tsx';
import { TextAreaField } from '../form/text-area-field.tsx';
import { Icon } from '../icon/icon.tsx';
import { useModal } from '../overlay/dialog.tsx';
import type { WriterOutcome, WriterRequest } from './writer-api.ts';
import {
  MAX_KEYWORDS,
  MAX_KEYWORD_CHARS,
  MAX_NOTE_CHARS,
  WRITER_COPY as C,
  WRITER_LENGTHS,
  WRITER_TONES,
  leftOutLine,
  type LeftOut,
  type WriterDetail,
  type WriterLength,
  type WriterTone,
} from './writer-copy.ts';

export type InsertMode = 'replace' | 'append';

export interface AiWriterModalProps {
  readonly open: boolean;
  /** Called when the modal is closed by the user; not while a draft is waiting to be discarded. */
  readonly onClose: () => void;
  /** The form's current values, as the form shows them. */
  readonly formTitle: string;
  readonly formCategory: string;
  readonly formDetails: readonly WriterDetail[];
  /** The description field has text already: the draft is then put in by the chosen mode. */
  readonly hasText: boolean;
  /** The Market's zone from the status read, for the limit message when the refusal has none. */
  readonly resetZone: string;
  readonly generate: (request: WriterRequest, signal: AbortSignal) => Promise<WriterOutcome>;
  /** "Use text": plain text only. The caller puts it into the field. */
  readonly onUse: (text: string, mode: InsertMode) => void;
  /** The writer is off now (409): the caller hides the button. */
  readonly onOff: () => void;
  /** Reports a draft being written, for the button's own "Writing…" state. */
  readonly onWriting?: (writing: boolean) => void;
}

type Phase =
  | { readonly kind: 'input' }
  | { readonly kind: 'writing' }
  | {
      readonly kind: 'ready';
      readonly text: string;
      readonly leftOut: LeftOut;
      readonly ask: boolean;
    }
  | { readonly kind: 'failed'; readonly throttled: boolean }
  | { readonly kind: 'limit'; readonly zone: string }
  | { readonly kind: 'withheld'; readonly leftOut: LeftOut };

/**
 * The "Write with AI" modal (catalog design 13.1). Nothing is stored: the draft goes into the
 * field only on "Use text", as plain text. The dialog's content is mounted only while it is open,
 * so every opening starts clean. Esc closes it except while a draft is being written; closing
 * with a draft on screen asks first.
 */
export function AiWriterModal(props: AiWriterModalProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const keywordsRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  // Set by the body: how a close request is handled (it knows the phase).
  const requestClose = useRef<() => void>(() => undefined);
  useModal(ref, props.open, keywordsRef);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        requestClose.current();
      }}
      className="m-auto h-dvh max-h-none w-full max-w-none overflow-y-auto rounded-none border-0 border-line bg-surface p-4 text-start text-fg backdrop:bg-fg/40 sm:h-auto sm:max-h-[calc(100dvh-2rem)] sm:w-[min(35rem,calc(100%-2rem))] sm:rounded-lg sm:border sm:p-6"
    >
      {props.open ? (
        <WriterBody
          {...props}
          titleId={titleId}
          keywordsRef={keywordsRef}
          closeRef={requestClose}
        />
      ) : null}
    </dialog>
  );
}

function WriterBody({
  onClose,
  formTitle,
  formCategory,
  formDetails,
  hasText,
  resetZone,
  generate,
  onUse,
  onOff,
  onWriting,
  titleId,
  keywordsRef,
  closeRef,
}: AiWriterModalProps & {
  readonly titleId: string;
  readonly keywordsRef: React.RefObject<HTMLInputElement | null>;
  readonly closeRef: React.MutableRefObject<() => void>;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: 'input' });
  const [keywords, setKeywords] = useState<string[]>([]);
  const [draftWord, setDraftWord] = useState('');
  const [note, setNote] = useState('');
  const [tone, setTone] = useState<WriterTone>('clear-friendly');
  const [length, setLength] = useState<WriterLength>(80);
  const [mode, setMode] = useState<InsertMode>('replace');
  const abort = useRef<AbortController | null>(null);
  const noteId = useId();

  const blocked = formTitle.trim() === '' || formCategory.trim() === '';
  const full = keywords.length >= MAX_KEYWORDS;
  const details = formDetails.filter((d) => d.value.trim() !== '');

  // A draft in flight stops when the modal goes away.
  useEffect(
    () => () => {
      abort.current?.abort();
      onWriting?.(false);
    },
    [],
  );

  closeRef.current = () => {
    if (phase.kind === 'writing') return; // Esc does not close while writing.
    if (phase.kind === 'ready') {
      setPhase({ ...phase, ask: true });
      return;
    }
    onClose();
  };

  function addWord() {
    const word = draftWord.trim().replace(/\s+/g, ' ').slice(0, MAX_KEYWORD_CHARS);
    if (word === '' || full) return;
    if (!keywords.some((k) => k.toLowerCase() === word.toLowerCase())) {
      setKeywords([...keywords, word]);
    }
    setDraftWord('');
  }

  function onWordKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault(); // never submits the product form behind
      addWord();
    } else if (event.key === 'Backspace' && draftWord === '' && keywords.length > 0) {
      setKeywords(keywords.slice(0, -1));
    }
  }

  async function run() {
    if (blocked || phase.kind === 'writing') return;
    const controller = new AbortController();
    abort.current = controller;
    setPhase({ kind: 'writing' });
    onWriting?.(true);
    const outcome = await generate(
      {
        title: formTitle.trim(),
        category: formCategory.trim(),
        details,
        keywords,
        note,
        tone,
        length,
      },
      controller.signal,
    );
    if (controller.signal.aborted) return; // Stop (or close) already moved on.
    abort.current = null;
    onWriting?.(false);
    switch (outcome.kind) {
      case 'draft':
        setPhase({ kind: 'ready', text: outcome.text, leftOut: outcome.leftOut, ask: false });
        break;
      case 'withheld':
        setPhase({ kind: 'withheld', leftOut: outcome.leftOut });
        break;
      case 'limit':
        setPhase({ kind: 'limit', zone: outcome.resetZone ?? resetZone });
        break;
      case 'throttled':
        setPhase({ kind: 'failed', throttled: true });
        break;
      case 'off':
        onOff();
        onClose();
        break;
      default:
        setPhase({ kind: 'failed', throttled: false });
    }
  }

  function stop() {
    abort.current?.abort();
    abort.current = null;
    onWriting?.(false);
    setPhase({ kind: 'input' });
  }

  const showInputs = phase.kind !== 'writing' && phase.kind !== 'ready';
  const showIntro = showInputs;
  const askDiscard = phase.kind === 'ready' && phase.ask;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Icon name="zap" className="text-link" />
        <h2 id={titleId} className="min-w-0 flex-1 text-lg font-semibold">
          {C.title}
        </h2>
        <IconButton icon="x" label={C.close} onClick={() => closeRef.current()} />
      </div>
      {showIntro ? <p className="text-sm text-fg-secondary">{C.intro}</p> : null}

      {showInputs ? (
        <>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${noteId}-kw`} className="text-sm font-medium text-fg">
              {C.keywords}
            </label>
            <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-line-input bg-surface p-2">
              {keywords.map((word) => (
                <span
                  key={word}
                  className="inline-flex items-center gap-1 rounded-full bg-selected px-2 py-1 text-sm text-link"
                >
                  {word}
                  <button
                    type="button"
                    aria-label={C.removeKeyword(word)}
                    className="inline-flex text-icon-muted hover:text-fg"
                    onClick={() => {
                      setKeywords(keywords.filter((k) => k !== word));
                      keywordsRef.current?.focus();
                    }}
                  >
                    <Icon name="x" className="size-3" />
                  </button>
                </span>
              ))}
              <input
                id={`${noteId}-kw`}
                ref={keywordsRef}
                type="text"
                value={full ? '' : draftWord}
                disabled={full}
                maxLength={MAX_KEYWORD_CHARS}
                placeholder={full ? C.keywordsFull : C.keywordsPlaceholder}
                aria-describedby={`${noteId}-kw-help`}
                className="min-w-40 flex-1 bg-transparent py-1 text-sm text-fg placeholder:text-fg-muted disabled:cursor-not-allowed"
                onChange={(event) => setDraftWord(event.target.value)}
                onKeyDown={onWordKey}
              />
            </div>
            <p id={`${noteId}-kw-help`} className="text-sm text-fg-muted">
              {C.keywordsHelp}
            </p>
          </div>
          <TextAreaField
            label={C.note}
            help={C.noteHelp}
            rows={3}
            maxLength={MAX_NOTE_CHARS}
            value={note}
            counter={`${String(note.length)} / ${String(MAX_NOTE_CHARS)}`}
            onChange={(event) => setNote(event.target.value)}
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <Select
              label={C.tone}
              value={tone}
              options={WRITER_TONES.map((value) => ({ value, label: C.tones[value] }))}
              onChange={(event) => setTone(event.target.value as WriterTone)}
            />
            <Select
              label={C.length}
              value={String(length)}
              options={WRITER_LENGTHS.map((value) => ({
                value: String(value),
                label: C.lengths[value],
              }))}
              onChange={(event) => setLength(Number(event.target.value) as WriterLength)}
            />
          </div>
          <div className="flex flex-col gap-1.5 rounded-md bg-subtle p-3 text-sm">
            <p className="font-semibold text-fg-muted">{C.usedHeading}</p>
            <dl className="flex flex-col gap-1.5">
              <UsedRow label={C.usedTitle} value={formTitle.trim()} missing />
              <UsedRow label={C.usedCategory} value={formCategory.trim()} missing />
              <UsedRow
                label={C.usedDetails}
                value={details.map((d) => d.value).join(' · ')}
                missing={false}
              />
            </dl>
            <p className="text-fg-muted">{C.usedNote}</p>
          </div>
        </>
      ) : null}

      {/* One live region for what happens next: writing, ready, failed, limit, withheld. */}
      <div aria-live="polite" className="flex flex-col gap-4">
        {phase.kind === 'writing' ? (
          <div className="flex items-center gap-2 rounded-md bg-subtle p-4 text-sm text-fg-secondary">
            <Icon name="clock" className="text-icon-muted" />
            <p>{C.writing}</p>
          </div>
        ) : null}
        {phase.kind === 'failed' ? (
          <Banner tone="critical" title={phase.throttled ? C.throttledTitle : C.failedTitle}>
            <p>{phase.throttled ? C.throttledBody : C.failedBody}</p>
          </Banner>
        ) : null}
        {phase.kind === 'limit' ? (
          <Banner tone="attention" title={C.limitTitle}>
            <p>{C.limitBody(phase.zone)}</p>
          </Banner>
        ) : null}
        {phase.kind === 'withheld' ? (
          <Banner tone="attention" title={C.withheldTitle}>
            <p>{C.withheldBody}</p>
            <LeftOutLine leftOut={phase.leftOut} />
          </Banner>
        ) : null}
        {phase.kind === 'ready' ? (
          <>
            <div className="flex flex-col gap-2 rounded-md bg-subtle p-4">
              <p className="text-sm font-semibold text-fg-muted">{C.draftLabel}</p>
              {/* Plain text only: React escapes it, and it is never set as HTML. */}
              {phase.text.split(/\n\s*\n/).map((paragraph, index) => (
                <p key={index} className="whitespace-pre-line text-fg">
                  {paragraph.trim()}
                </p>
              ))}
            </div>
            <LeftOutLine leftOut={phase.leftOut} />
            {hasText ? (
              <RadioGroup
                legend={C.existing}
                name={`${noteId}-mode`}
                value={mode}
                options={[
                  { value: 'replace', label: C.replace },
                  { value: 'append', label: C.append },
                ]}
                onChange={(value) => setMode(value === 'append' ? 'append' : 'replace')}
              />
            ) : null}
          </>
        ) : null}
      </div>

      {askDiscard ? (
        <div
          role="alertdialog"
          aria-label={C.discardTitle}
          className="flex flex-col gap-3 border-t border-line pt-4"
        >
          <p className="font-semibold text-fg">{C.discardTitle}</p>
          <p className="text-sm text-fg-secondary">{C.discardBody}</p>
          <div className="flex flex-wrap justify-end gap-3">
            <Button
              variant="secondary"
              onClick={() => phase.kind === 'ready' && setPhase({ ...phase, ask: false })}
            >
              {C.discardKeep}
            </Button>
            <Button variant="destructive-solid" onClick={onClose}>
              {C.discardConfirm}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
          {phase.kind === 'ready' ? (
            <>
              <Button variant="link" onClick={() => setPhase({ kind: 'input' })}>
                {C.back}
              </Button>
              <span className="flex-1" />
              <Button variant="secondary" onClick={() => void run()}>
                {C.tryAgain}
              </Button>
              <Button onClick={() => onUse(phase.text, hasText ? mode : 'replace')}>{C.use}</Button>
            </>
          ) : phase.kind === 'writing' ? (
            <>
              <span className="flex-1" />
              <Button variant="secondary" onClick={stop}>
                {C.stop}
              </Button>
            </>
          ) : (
            <>
              {blocked ? (
                <p id={`${noteId}-blocked`} className="flex-1 text-sm text-fg-muted">
                  {C.blocked}
                </p>
              ) : (
                <span className="flex-1" />
              )}
              <Button variant="secondary" onClick={onClose}>
                {C.cancel}
              </Button>
              <Button
                disabled={blocked || phase.kind === 'limit'}
                {...(blocked ? { 'aria-describedby': `${noteId}-blocked` } : {})}
                onClick={() => void run()}
              >
                <Icon name="zap" className="me-2" />
                {phase.kind === 'failed' ? C.tryAgain : C.generate}
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function UsedRow({
  label,
  value,
  missing,
}: {
  readonly label: string;
  readonly value: string;
  readonly missing: boolean;
}) {
  const empty = value === '';
  return (
    <div className="flex gap-2">
      <dt className="w-32 shrink-0 text-fg-muted">{label}</dt>
      <dd className={empty && missing ? 'text-critical-fg' : 'text-fg'}>
        {empty ? (missing ? C.missing : C.none) : value}
      </dd>
    </div>
  );
}

function LeftOutLine({ leftOut }: { readonly leftOut: LeftOut }) {
  const line = leftOutLine(leftOut);
  return line === null ? null : <p className="text-sm text-attention-fg">{line}</p>;
}
