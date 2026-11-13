// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiWriterModal, type AiWriterModalProps } from './ai-writer-modal.tsx';
import { DescriptionWriter, mergeDraft } from './description-writer.tsx';
import {
  loadWriterStatus,
  requestDraft,
  type WriterCall,
  type WriterOutcome,
  type WriterRequest,
} from './writer-api.ts';
import { clampDetails, leftOutLine } from './writer-copy.ts';

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute('open');
  };
});
afterEach(cleanup);

const NO_LEFT_OUT = { certification: 0, other: 0 };

function setup(over: Partial<AiWriterModalProps> = {}) {
  const props: AiWriterModalProps = {
    open: true,
    onClose: vi.fn(),
    formTitle: 'Sella basmati rice',
    formCategory: 'Pantry › Rice',
    formDetails: [{ name: 'Brand', value: 'Tilda' }],
    hasText: false,
    resetZone: 'Australia/Brisbane',
    generate: vi.fn<AiWriterModalProps['generate']>(() =>
      Promise.resolve({ kind: 'draft', text: 'A good rice.', leftOut: NO_LEFT_OUT }),
    ),
    onUse: vi.fn(),
    onOff: vi.fn(),
    ...over,
  };
  render(<AiWriterModal {...props} />);
  return props;
}

describe('copy helpers', () => {
  it('words the left-out line by reason and number', () => {
    expect(leftOutLine({ certification: 1, other: 0 })).toBe(
      '1 sentence was left out: it named a certification.',
    );
    expect(leftOutLine({ certification: 0, other: 1 })).toBe(
      '1 sentence was left out: it added details the form doesn’t have.',
    );
    expect(leftOutLine({ certification: 0, other: 2 })).toBe(
      '2 sentences were left out: they added details the form doesn’t have.',
    );
    expect(leftOutLine({ certification: 2, other: 1 })).toContain('3 sentences were left out');
    expect(leftOutLine(NO_LEFT_OUT)).toBeNull();
  });

  it('clamps details to the API limits and drops empty ones', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ name: `n${String(i)}`, value: 'v' }));
    expect(clampDetails(many)).toHaveLength(20);
    expect(clampDetails([{ name: 'a', value: '  ' }])).toEqual([]);
    expect(clampDetails([{ name: 'a', value: 'x'.repeat(200) }])[0]?.value).toHaveLength(120);
  });

  it('adds below the text that is there, or replaces it', () => {
    expect(mergeDraft('Old.', 'New.', 'replace')).toBe('New.');
    expect(mergeDraft('Old.  ', 'New.', 'append')).toBe('Old.\n\nNew.');
    expect(mergeDraft('  ', 'New.', 'append')).toBe('New.');
  });
});

describe('the modal inputs', () => {
  it('opens on Keywords, and adds and removes chips with Enter and the x button', async () => {
    const user = userEvent.setup();
    setup();
    const input = screen.getByRole('textbox', { name: 'Keywords' });
    expect(document.activeElement).toBe(input);
    await user.type(input, 'biryani{Enter}aged{Enter}');
    expect(screen.getByText('biryani')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Remove biryani' }));
    expect(screen.queryByText('biryani')).toBeNull();
    expect(screen.getByText('aged')).toBeTruthy();
  });

  it('disables the keyword input at 10 and shows "10 of 10"', async () => {
    const user = userEvent.setup();
    setup();
    const input = screen.getByRole('textbox', { name: 'Keywords' });
    for (let i = 0; i < 10; i += 1) await user.type(input, `w${String(i)}{Enter}`);
    const full = screen.getByPlaceholderText('10 of 10');
    expect((full as HTMLInputElement).disabled).toBe(true);
  });

  it('counts the note and caps it at 300', async () => {
    const user = userEvent.setup();
    setup();
    const note = screen.getByRole('textbox', { name: 'Short note' });
    expect((note as HTMLTextAreaElement).maxLength).toBe(300);
    await user.type(note, 'Firm grains');
    expect(screen.getByText('11 / 300')).toBeTruthy();
  });

  it('blocks Generate without a title or category and says Missing in the form box', () => {
    setup({ formTitle: ' ', formCategory: '' });
    const generate = screen.getByRole('button', { name: 'Generate' });
    expect((generate as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Add a title and category first.')).toBeTruthy();
    expect(screen.getAllByText('Missing')).toHaveLength(2);
  });

  it('sends the form values, keywords, note, tone and length', async () => {
    const user = userEvent.setup();
    const props = setup();
    await user.type(screen.getByRole('textbox', { name: 'Keywords' }), 'biryani{Enter}');
    await user.type(screen.getByRole('textbox', { name: 'Short note' }), ' Cooks fast ');
    await user.selectOptions(screen.getByLabelText('Tone'), 'warm');
    await user.selectOptions(screen.getByLabelText('Length'), '150');
    await user.click(screen.getByRole('button', { name: 'Generate' }));
    await screen.findByText('Draft · check it before you use it');
    expect(vi.mocked(props.generate).mock.calls[0]?.[0]).toEqual({
      title: 'Sella basmati rice',
      category: 'Pantry › Rice',
      details: [{ name: 'Brand', value: 'Tilda' }],
      keywords: ['biryani'],
      note: ' Cooks fast ',
      tone: 'warm',
      length: 150,
    } satisfies WriterRequest);
  });
});

describe('writing, ready and the other states', () => {
  it('writes: shows the banner, Stop aborts the request and returns to the inputs, kept', async () => {
    const user = userEvent.setup();
    let signal: AbortSignal | undefined;
    const props = setup({
      generate: (_request, s) => {
        signal = s;
        return new Promise<WriterOutcome>(() => undefined);
      },
    });
    await user.type(screen.getByRole('textbox', { name: 'Keywords' }), 'biryani{Enter}');
    await user.click(screen.getByRole('button', { name: 'Generate' }));
    expect(screen.getByText(/Writing a draft/)).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Keywords' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Stop' }));
    expect(signal?.aborted).toBe(true);
    expect(props.onClose).not.toHaveBeenCalled();
    expect(screen.getByText('biryani')).toBeTruthy();
  });

  it('does not close on Esc while writing, but does in the input state', async () => {
    const user = userEvent.setup();
    const props = setup({ generate: () => new Promise<WriterOutcome>(() => undefined) });
    const dialog = document.querySelector('dialog') as HTMLDialogElement;
    const esc = () => fireEvent(dialog, new Event('cancel', { cancelable: true }));
    await user.click(screen.getByRole('button', { name: 'Generate' }));
    esc();
    expect(props.onClose).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Stop' }));
    esc();
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('shows the draft as text, the left-out line and Use text without a mode when the field is empty', async () => {
    const user = userEvent.setup();
    const props = setup({
      generate: () =>
        Promise.resolve({
          kind: 'draft',
          text: 'First.\n\n<b>Second</b> <img src=x onerror=alert(1)>',
          leftOut: { certification: 1, other: 0 },
        }),
    });
    await user.click(screen.getByRole('button', { name: 'Generate' }));
    expect(await screen.findByText('Draft · check it before you use it')).toBeTruthy();
    // Never HTML: the markup shows as literal text and no element is made from it.
    expect(screen.getByText('<b>Second</b> <img src=x onerror=alert(1)>')).toBeTruthy();
    expect(document.querySelector('dialog b, dialog img')).toBeNull();
    expect(screen.getByText('1 sentence was left out: it named a certification.')).toBeTruthy();
    expect(screen.queryByText('The description already has text')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Use text' }));
    expect(props.onUse).toHaveBeenCalledWith(
      'First.\n\n<b>Second</b> <img src=x onerror=alert(1)>',
      'replace',
    );
  });

  it('offers Replace or Add below when the field has text, and passes the choice', async () => {
    const user = userEvent.setup();
    const props = setup({ hasText: true });
    await user.click(screen.getByRole('button', { name: 'Generate' }));
    await screen.findByText('The description already has text');
    expect(screen.getByLabelText<HTMLInputElement>('Replace it').checked).toBe(true);
    await user.click(screen.getByLabelText('Add below it'));
    await user.click(screen.getByRole('button', { name: 'Use text' }));
    expect(props.onUse).toHaveBeenCalledWith('A good rice.', 'append');
  });

  it('asks "Discard this draft?" when closed in the ready state; Keep keeps, Discard closes', async () => {
    const user = userEvent.setup();
    const props = setup();
    await user.click(screen.getByRole('button', { name: 'Generate' }));
    await screen.findByText('Draft · check it before you use it');
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.getByText('Discard this draft?')).toBeTruthy();
    expect(props.onClose).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Keep draft' }));
    expect(screen.queryByText('Discard this draft?')).toBeNull();
    fireEvent(
      document.querySelector('dialog') as HTMLDialogElement,
      new Event('cancel', { cancelable: true }),
    );
    expect(screen.getByText('Discard this draft?')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('Back to edit returns to the inputs with what was typed', async () => {
    const user = userEvent.setup();
    setup();
    await user.type(screen.getByRole('textbox', { name: 'Keywords' }), 'aged{Enter}');
    await user.click(screen.getByRole('button', { name: 'Generate' }));
    await screen.findByText('Draft · check it before you use it');
    await user.click(screen.getByRole('button', { name: 'Back to edit' }));
    expect(screen.getByText('aged')).toBeTruthy();
  });

  it('Try again asks for a new draft', async () => {
    const user = userEvent.setup();
    const props = setup();
    await user.click(screen.getByRole('button', { name: 'Generate' }));
    await screen.findByText('Draft · check it before you use it');
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(props.generate).toHaveBeenCalledTimes(2));
  });

  it('shows a failed banner with the inputs kept, and Try again retries', async () => {
    const user = userEvent.setup();
    const generate = vi
      .fn<AiWriterModalProps['generate']>()
      .mockResolvedValueOnce({ kind: 'failed' })
      .mockResolvedValueOnce({ kind: 'draft', text: 'Ok.', leftOut: NO_LEFT_OUT });
    setup({ generate });
    await user.click(screen.getByRole('button', { name: 'Generate' }));
    expect(await screen.findByText('We couldn’t write a draft.')).toBeTruthy();
    expect(
      screen.getByText('Try again, or write it yourself. Your form wasn’t changed.'),
    ).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Keywords' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Ok.')).toBeTruthy();
  });

  it('shows the limit with the zone from the refusal, and disables Generate', async () => {
    const user = userEvent.setup();
    setup({
      generate: () => Promise.resolve({ kind: 'limit', resetZone: 'Pacific/Auckland' }),
    });
    await user.click(screen.getByRole('button', { name: 'Generate' }));
    expect(await screen.findByText('Today’s AI drafts are used up.')).toBeTruthy();
    expect(
      screen.getByText(
        'They reset at midnight Pacific/Auckland time. You can still write the description yourself.',
      ),
    ).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Generate' }).disabled).toBe(true);
  });

  it('falls back to the status zone when the limit refusal has none', async () => {
    const user = userEvent.setup();
    setup({ generate: () => Promise.resolve({ kind: 'limit', resetZone: null }) });
    await user.click(screen.getByRole('button', { name: 'Generate' }));
    expect(await screen.findByText(/midnight Australia\/Brisbane time/)).toBeTruthy();
  });

  it('shows the withheld state with the left-out line', async () => {
    const user = userEvent.setup();
    setup({
      generate: () =>
        Promise.resolve({ kind: 'withheld', leftOut: { certification: 2, other: 0 } }),
    });
    await user.click(screen.getByRole('button', { name: 'Generate' }));
    expect(await screen.findByText('The draft could not be used.')).toBeTruthy();
    expect(screen.getByText(/2 sentences were left out: they named a certification/)).toBeTruthy();
  });

  it('tells the owner the writer is off (409) and closes', async () => {
    const user = userEvent.setup();
    const props = setup({ generate: () => Promise.resolve({ kind: 'off' }) });
    await user.click(screen.getByRole('button', { name: 'Generate' }));
    await waitFor(() => expect(props.onOff).toHaveBeenCalled());
    expect(props.onClose).toHaveBeenCalled();
  });
});

describe('the API mapping', () => {
  const answer =
    (result: Awaited<ReturnType<WriterCall>>): WriterCall =>
    () =>
      Promise.resolve(result);
  const request: WriterRequest = {
    title: 'T',
    category: 'C',
    details: [],
    keywords: [],
    note: '',
    tone: 'clear-friendly',
    length: 80,
  };
  const draft = (result: Awaited<ReturnType<WriterCall>>) =>
    requestDraft(answer(result), 'base', 'tok', request, new AbortController().signal);
  const fail = (status: number, code: string, details?: object) =>
    ({
      ok: false,
      failure: { status, code, ...(details === undefined ? {} : { details }) },
    }) as const;

  it('sorts every refusal into its state', async () => {
    expect(await draft(fail(409, 'ai.writer-off'))).toEqual({ kind: 'off' });
    expect(
      await draft(fail(422, 'ai.draft-withheld', { leftOut: { certification: 1, other: 2 } })),
    ).toEqual({ kind: 'withheld', leftOut: { certification: 1, other: 2 } });
    expect(await draft(fail(429, 'ai.limit-reached', { resetZone: 'Asia/Kuala_Lumpur' }))).toEqual({
      kind: 'limit',
      resetZone: 'Asia/Kuala_Lumpur',
    });
    expect(await draft(fail(429, 'request.throttled'))).toEqual({ kind: 'throttled' });
    expect(await draft(fail(503, 'ai.writer-failed'))).toEqual({ kind: 'failed' });
    expect(await draft(fail(503, 'access.unavailable'))).toEqual({ kind: 'failed' });
    expect(await draft(fail(400, 'validation.failed'))).toEqual({ kind: 'failed' });
    expect(await draft(fail(0, 'network'))).toEqual({ kind: 'failed' });
  });

  it('reads a draft and treats an empty or malformed answer as failed', async () => {
    expect(
      await draft({
        ok: true,
        body: { text: 'Hi.', leftOut: { certification: 0, other: 1 }, promptVersion: 'v1' },
      }),
    ).toEqual({ kind: 'draft', text: 'Hi.', leftOut: { certification: 0, other: 1 } });
    expect(await draft({ ok: true, body: { text: '  ' } })).toEqual({ kind: 'failed' });
    expect(await draft({ ok: true, body: null })).toEqual({ kind: 'failed' });
  });

  it('posts only the closed set of fields, leaving out what is empty', async () => {
    const call = vi.fn<WriterCall>(() => Promise.resolve({ ok: true, body: { text: 'x' } }));
    await requestDraft(
      call,
      'catalog/own/description-writer',
      'tok',
      request,
      new AbortController().signal,
    );
    expect(call.mock.calls[0]?.[0]).toBe('POST');
    expect(call.mock.calls[0]?.[1]).toBe('catalog/own/description-writer/drafts');
    expect(call.mock.calls[0]?.[2]).toEqual({
      title: 'T',
      category: 'C',
      tone: 'clear-friendly',
      length: 80,
    });
    expect(call.mock.calls[0]?.[3]).toBe('tok');
  });

  it('reads the status and treats any failure as off', async () => {
    expect(
      await loadWriterStatus(
        answer({ ok: true, body: { available: true, resetZone: 'Z/Y' } }),
        'b',
      ),
    ).toEqual({ available: true, resetZone: 'Z/Y' });
    expect(await loadWriterStatus(answer(fail(403, 'access.denied')), 'b')).toMatchObject({
      available: false,
    });
    expect(
      await loadWriterStatus(answer({ ok: true, body: { available: 'yes' } }), 'b'),
    ).toMatchObject({
      available: false,
    });
  });
});

describe('the button', () => {
  function Host({ call, current = '' }: { call: WriterCall; current?: string }) {
    const [text, setText] = useState(current);
    return (
      <>
        <DescriptionWriter
          call={call}
          base="catalog/own/description-writer"
          csrfToken="tok"
          title="Rice"
          category="Pantry"
          details={[]}
          current={text}
          onText={setText}
        />
        <output data-testid="field">{text}</output>
      </>
    );
  }

  it('is hidden when the writer is off', async () => {
    const call: WriterCall = () =>
      Promise.resolve({ ok: true, body: { available: false, resetZone: 'Z' } });
    render(<Host call={call} />);
    await act(() => Promise.resolve());
    expect(screen.queryByRole('button', { name: 'Write with AI' })).toBeNull();
  });

  it('is hidden when the status read fails', async () => {
    const call: WriterCall = () =>
      Promise.resolve({ ok: false, failure: { status: 503, code: 'access.unavailable' } });
    render(<Host call={call} />);
    await act(() => Promise.resolve());
    expect(screen.queryByRole('button', { name: 'Write with AI' })).toBeNull();
  });

  it('opens the modal, puts the draft into the field as text', async () => {
    const user = userEvent.setup();
    const call = vi.fn<WriterCall>((method) =>
      Promise.resolve(
        method === 'GET'
          ? { ok: true, body: { available: true, resetZone: 'Australia/Brisbane' } }
          : { ok: true, body: { text: 'Drafted.', leftOut: NO_LEFT_OUT, promptVersion: 'v1' } },
      ),
    );
    render(<Host call={call} current="Existing." />);
    const button = await screen.findByRole('button', { name: 'Write with AI' });
    await user.click(button);
    expect(screen.getByRole('dialog', { name: 'Write description with AI' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Generate' }));
    await screen.findByText('Draft · check it before you use it');
    await user.click(screen.getByLabelText('Add below it'));
    await user.click(screen.getByRole('button', { name: 'Use text' }));
    expect(screen.getByTestId('field').textContent).toBe('Existing.\n\nDrafted.');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
