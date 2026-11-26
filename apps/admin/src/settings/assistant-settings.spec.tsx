// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from '@mondapac/ui';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { formOf, refusedFields, settingsOf } from './assistant-form.ts';
import { AssistantSettingsPanel } from './assistant-settings-panel.tsx';
import type { AssistantSettings, AssistantSettingsAnswer } from './assistant-types.ts';

const call = vi.mocked(callApi);
const wrap = (node: ReactNode) => (
  <NextIntlClientProvider locale="en-AU" messages={messages}>
    {node}
  </NextIntlClientProvider>
);

const DEFAULTS: AssistantSettings = {
  enabled: false,
  audience: 'internal',
  audiencePercent: null,
  scope: 'read-only',
  users: 'guests-and-customers',
  guestMessageLimit: 20,
  customerMessageLimit: 40,
  retention: '30-days',
  replyLanguage: 'buyer',
  supportHandoff: 'email-link',
  basketProposals: false,
  welcomeText: null,
};
// Same as the API's UNAVAILABLE_OPTIONS: cart suggestions are selectable since S1-B1.
const UNAVAILABLE = { scope: [], supportHandoff: ['in-panel-form'] } as const;

const answer = (
  settings: Partial<AssistantSettings> = {},
  more: Partial<AssistantSettingsAnswer> = {},
): AssistantSettingsAnswer => ({
  version: 0,
  settings: { ...DEFAULTS, ...settings },
  apiKey: 'not-set',
  spend: { todayMicroUsd: 0, monthMicroUsd: 0, conversationsToday: 0, lastAutoOff: null },
  unavailableOptions: UNAVAILABLE,
  ...more,
});

const mount = (initial: AssistantSettingsAnswer, canManage = true) =>
  render(wrap(<AssistantSettingsPanel initial={initial} canManage={canManage} csrfToken="csrf" />));
const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
/** A change that is valid, so the save bar shows. */
const touch = (value = '21') =>
  fireEvent.change(screen.getByLabelText('Messages per guest'), { target: { value } });

/** One row of the Compare list: the saved and typed values, read as text. */
const compared = (label: string | RegExp) => {
  const list = screen.getByRole('list', { name: 'Changes compared' });
  const item = within(list).getByText(label).closest('li')!;
  const [saved, yours] = [...item.querySelectorAll('q')].map((q) => q.textContent);
  return { saved, yours, item };
};

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('AssistantSettingsPanel', () => {
  it('shows the shipped defaults: off, internal only, read-only answers', () => {
    mount(answer());
    expect(screen.getByLabelText<HTMLInputElement>('Assistant switched on').checked).toBe(false);
    expect(screen.getByLabelText<HTMLSelectElement>('Show to').value).toBe('internal');
    expect(screen.getByLabelText<HTMLSelectElement>('What it can do').value).toBe('read-only');
    expect(screen.getByLabelText<HTMLInputElement>('Messages per guest').value).toBe('20');
    // The status card and the two switch rows say Off.
    expect(screen.getAllByText('Off')).toHaveLength(3);
    // Nothing changed: no save bar.
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).toBeNull();
  });

  it('shows the key only as set or not set, and offers unavailable options disabled', () => {
    mount(answer());
    expect(screen.getByText('Not set')).toBeTruthy();
    const form = screen.getByRole<HTMLOptionElement>('option', {
      name: 'Form inside the chat window (not available yet)',
    });
    expect(form.disabled).toBe(true);
  });

  it('offers cart suggestions and keeps basket proposals off by default', () => {
    mount(answer());
    const cart = screen.getByRole<HTMLOptionElement>('option', {
      name: 'Answer and suggest cart actions',
    });
    expect(cart.disabled).toBe(false);
    expect(screen.getByLabelText<HTMLInputElement>('Basket proposals from a list').checked).toBe(
      false,
    );
  });

  it('saves the basket proposals switch with every other field unchanged', async () => {
    call.mockResolvedValue({
      ok: true,
      status: 200,
      body: answer({ basketProposals: true }, { version: 1 }),
    });
    mount(answer());
    fireEvent.click(screen.getByLabelText('Basket proposals from a list'));
    expect(screen.getByText('1 unsaved change')).toBeTruthy();
    save();
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(call).toHaveBeenCalledWith(
      'PUT',
      'assistant/admin/settings',
      { expectedVersion: 0, settings: { ...DEFAULTS, basketProposals: true } },
      'csrf',
    );
    await waitFor(() =>
      expect(screen.getByLabelText<HTMLInputElement>('Basket proposals from a list').checked).toBe(
        true,
      ),
    );
  });

  it('saves the cart suggestions scope', async () => {
    call.mockResolvedValue({
      ok: true,
      status: 200,
      body: answer({ scope: 'cart-suggestions' }, { version: 1 }),
    });
    mount(answer());
    fireEvent.change(screen.getByLabelText('What it can do'), {
      target: { value: 'cart-suggestions' },
    });
    save();
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(call.mock.calls[0]![2]).toMatchObject({
      settings: { ...DEFAULTS, scope: 'cart-suggestions' },
    });
  });

  it('discards the basket proposals switch and saves it back to off', async () => {
    mount(answer());
    const box = screen.getByLabelText<HTMLInputElement>('Basket proposals from a list');
    fireEvent.click(box);
    expect(box.checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(box.checked).toBe(false);
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).toBeNull();
    cleanup();

    call.mockResolvedValue({ ok: true, status: 200, body: answer({}, { version: 3 }) });
    mount(answer({ basketProposals: true }, { version: 2 }));
    fireEvent.click(screen.getByLabelText('Basket proposals from a list'));
    save();
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(call.mock.calls[0]![2]).toMatchObject({
      expectedVersion: 2,
      settings: { ...DEFAULTS, basketProposals: false },
    });
  });

  it('compares the basket proposals switch after a conflict', async () => {
    call
      .mockResolvedValueOnce({ ok: false, failure: { status: 409, code: 'assistant.conflict' } })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: answer({ basketProposals: true }, { version: 4 }),
      });
    mount(answer());
    fireEvent.click(screen.getByLabelText('Basket proposals from a list'));
    fireEvent.click(screen.getByLabelText('Basket proposals from a list'));
    fireEvent.click(screen.getByLabelText('Assistant switched on'));
    save();
    expect(await screen.findByText('Someone else saved these settings first')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show what changed' }));
    expect(compared('Basket proposals from a list')).toMatchObject({ saved: 'On', yours: 'Off' });
  });

  it('has no model tier picker or model row: the models are the AI Gateway lists (G4d1)', () => {
    mount(answer());
    expect(screen.queryByLabelText('Model')).toBeNull();
    expect(screen.queryByText('Configured model')).toBeNull();
    expect(screen.queryByRole('option', { name: /Fast|Balanced/ })).toBeNull();
  });

  it('never sends a model tier with a save', async () => {
    call.mockResolvedValue({
      ok: true,
      status: 200,
      body: answer({ enabled: true }, { version: 1 }),
    });
    mount(answer());
    fireEvent.click(screen.getByLabelText('Assistant switched on'));
    save();
    await waitFor(() => expect(call).toHaveBeenCalled());
    const body = call.mock.calls[0]?.[2] as { settings: Record<string, unknown> };
    expect(Object.keys(body.settings)).not.toContain('modelTier');
  });

  it('renders server text inert', () => {
    const markup = '<img src=x onerror="alert(1)">';
    const { container } = mount(answer({ welcomeText: markup }), false);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getAllByText(markup).length).toBe(1);
  });

  it('warns when switched on without a key', () => {
    mount(answer({ enabled: true }));
    expect(screen.getByText(/buyers do not see it yet/)).toBeTruthy();
    cleanup();
    mount(answer({ enabled: true }, { apiKey: 'set' }));
    expect(screen.queryByText(/buyers do not see it yet/)).toBeNull();
  });

  it('fills the status card with spend, conversations, cost and the last switch-off', () => {
    render(
      wrap(
        <AssistantSettingsPanel
          initial={answer(
            {},
            {
              spend: {
                todayMicroUsd: 2_345_000,
                monthMicroUsd: 61_500_000,
                conversationsToday: 17,
                lastAutoOff: { at: '2026-11-18T03:00:00Z', cap: 'daily' },
              },
            },
          )}
          canManage
          csrfToken="csrf"
          zone="Australia/Brisbane"
          averageCostUsd={0.0123}
        />,
      ),
    );
    // The caps are the AI Gateway's since G4d2: the card shows the spend only.
    expect(screen.getByText('USD 2.35')).toBeTruthy();
    expect(screen.getByText('USD 61.50')).toBeTruthy();
    expect(screen.queryByText(/ of USD /)).toBeNull();
    expect(screen.getByText('17')).toBeTruthy();
    expect(screen.getByText('USD 0.0123 over the last 30 days')).toBeTruthy();
    expect(screen.getByText(/Daily cap reached, /)).toBeTruthy();
  });

  it('says so when no cap ever switched the assistant off and no cost is known', () => {
    mount(answer());
    expect(screen.getByText('Never switched off by a cap')).toBeTruthy();
    expect(screen.getAllByText('Recorded once buyers have chatted').length).toBeGreaterThan(0);
  });

  it('shows a read-only summary without the manage permission', () => {
    mount(answer({ audience: 'percent', audiencePercent: 25 }), false);
    expect(
      screen
        .queryAllByRole('button')
        .filter((b) => !b.getAttribute('aria-label')?.startsWith('About ')),
    ).toEqual([]);
    expect(
      screen.getByText('Only the Platform Administrator can change these settings.'),
    ).toBeTruthy();
    expect(screen.getByText('25% of visitors')).toBeTruthy();
    expect(screen.getByText("The storefront's default text")).toBeTruthy();
    expect(screen.getByText('Basket proposals from a list')).toBeTruthy();
  });

  it('saves every field with the version it read', async () => {
    call.mockResolvedValue({
      ok: true,
      status: 200,
      body: answer({ enabled: true, audience: 'percent', audiencePercent: 10 }, { version: 1 }),
    });
    mount(answer());
    const success = vi.spyOn(toast, 'success').mockReturnValue('toast');
    fireEvent.click(screen.getByLabelText('Assistant switched on'));
    fireEvent.change(screen.getByLabelText('Show to'), { target: { value: 'percent' } });
    fireEvent.change(screen.getByLabelText('Share of visitors (%)'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('Messages per customer'), { target: { value: '60' } });
    expect(screen.getByText('4 unsaved changes')).toBeTruthy();
    save();
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(call).toHaveBeenCalledWith(
      'PUT',
      'assistant/admin/settings',
      {
        expectedVersion: 0,
        settings: {
          ...DEFAULTS,
          enabled: true,
          audience: 'percent',
          audiencePercent: 10,
          customerMessageLimit: 60,
        },
      },
      'csrf',
    );
    await waitFor(() =>
      expect(success).toHaveBeenCalledWith(expect.stringMatching(/Settings saved/)),
    );
    expect(screen.getByText('Saved version 1')).toBeTruthy();
    // Saved: the fields are the saved values again, so the bar is gone.
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).toBeNull();
  });

  it('names bad fields once they are left, before calling the API', () => {
    mount(answer());
    fireEvent.change(screen.getByLabelText('Messages per guest'), { target: { value: '61' } });
    fireEvent.change(screen.getByLabelText('Messages per customer'), { target: { value: '121' } });
    // While typing nothing is flagged yet.
    expect(screen.queryByText('Enter a whole number from 5 to 60.')).toBeNull();
    fireEvent.blur(screen.getByLabelText('Messages per guest'));
    fireEvent.blur(screen.getByLabelText('Messages per customer'));
    // No Save click: once left, the errors, the count and the summary are there.
    expect(screen.getByText('Enter a whole number from 5 to 60.')).toBeTruthy();
    expect(screen.getByText('Enter a whole number from 5 to 120.')).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
    // The bar counts the errors and Save is off until they are fixed.
    expect(screen.getByText(/2 need fixing/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    const summary = screen.getByRole('group', { name: /needs? fixing/ });
    expect(summary.textContent).toContain('2 settings need fixing');
    fireEvent.click(screen.getByRole('link', { name: 'Messages per guest' }));
    expect(document.activeElement).toBe(screen.getByLabelText('Messages per guest'));
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save changes' }).disabled).toBe(
      true,
    );
    fireEvent.change(screen.getByLabelText('Messages per guest'), { target: { value: '30' } });
    expect(screen.queryByText('Enter a whole number from 5 to 60.')).toBeNull();
    expect(screen.getByText(/1 needs fixing/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Messages per customer'), { target: { value: '100' } });
    expect(screen.queryByText(/needs fixing/)).toBeNull();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save changes' }).disabled).toBe(
      false,
    );
  });

  it('marks changed fields, counts them and discards them', () => {
    mount(answer());
    const field = screen.getByLabelText<HTMLInputElement>('Messages per guest');
    expect(field.className).not.toContain('border-attention-solid');
    touch();
    expect(field.className).toContain('border-attention-solid');
    expect(screen.getByText('1 unsaved change')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(field.value).toBe('20');
    expect(field.className).not.toContain('border-attention-solid');
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).toBeNull();
  });

  it('keeps the draft after a conflict, compares with what is saved now, and then sends the new version', async () => {
    call
      .mockResolvedValueOnce({ ok: false, failure: { status: 409, code: 'assistant.conflict' } })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: answer(
          { guestMessageLimit: 30, welcomeText: '<img src=x onerror=alert(1)> hi' },
          { version: 4 },
        ),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: answer({ guestMessageLimit: 25 }, { version: 5 }),
      });
    mount(answer());
    touch();
    save();
    expect(await screen.findByText('Someone else saved these settings first')).toBeTruthy();
    expect(call).toHaveBeenNthCalledWith(
      1,
      'PUT',
      'assistant/admin/settings',
      expect.objectContaining({ expectedVersion: 0 }),
      'csrf',
    );
    expect(call).toHaveBeenNthCalledWith(2, 'GET', 'assistant/admin/settings');
    // The admin's draft is kept, not replaced by the saved settings.
    expect(screen.getByLabelText<HTMLInputElement>('Messages per guest').value).toBe('21');
    expect(screen.getByText('Saved version 4')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Show what changed' }));
    expect(compared('Messages per guest')).toMatchObject({ saved: '30', yours: '21' });
    // The welcome message is user content: shown as text, never as markup.
    const welcome = compared('Welcome message');
    expect(welcome.saved).toBe('<img src=x onerror=alert(1)> hi');
    expect(welcome.yours).toBe("The storefront's default text");
    expect(welcome.item.querySelector('img')).toBeNull();

    touch('25');
    save();
    await waitFor(() => expect(call).toHaveBeenCalledTimes(3));
    expect(call).toHaveBeenNthCalledWith(
      3,
      'PUT',
      'assistant/admin/settings',
      expect.objectContaining({ expectedVersion: 4 }),
      'csrf',
    );
    await waitFor(() =>
      expect(screen.queryByText('Someone else saved these settings first')).toBeNull(),
    );
  });

  it('marks the fields the API refused', async () => {
    call.mockResolvedValue({
      ok: false,
      failure: {
        status: 400,
        code: 'validation.failed',
        details: { fields: [{ path: 'welcomeText', code: 'format' }] },
      },
    });
    mount(answer());
    touch();
    save();
    // Under the field and in the summary banner.
    expect(await screen.findAllByText(/without < or >/)).toHaveLength(2);
    expect(
      screen.getByText('Some settings were refused. Check the fields and try again.'),
    ).toBeTruthy();
  });

  it('shows a refusal in words', async () => {
    call.mockResolvedValue({ ok: false, failure: { status: 403, code: 'access.denied' } });
    mount(answer());
    touch();
    save();
    expect(
      await screen.findByText('Your role cannot change the shopping assistant settings.'),
    ).toBeTruthy();
  });
});

describe('assistant form', () => {
  it('has no spend cap inputs: the caps are the AI Gateway caps of the buyer chat (G4d2)', () => {
    const form = formOf(DEFAULTS);
    expect(Object.keys(form)).not.toContain('dailySpendCap');
    const sent = settingsOf(form, UNAVAILABLE);
    expect(sent.ok && Object.keys(sent.settings)).not.toContain('dailySpendCapUsdCents');
    expect(sent.ok && Object.keys(sent.settings)).not.toContain('monthlySpendCapUsdCents');
  });

  it('shows no spend cap field on the page', () => {
    mount(answer());
    expect(screen.queryByLabelText('Daily cap')).toBeNull();
    expect(screen.queryByLabelText('Monthly cap')).toBeNull();
    expect(screen.queryByText('Spend caps')).toBeNull();
  });

  it('sends null for an empty welcome text and refuses markup or hidden characters', () => {
    const base = formOf(DEFAULTS);
    const empty = settingsOf({ ...base, welcomeText: '   ' }, UNAVAILABLE);
    expect(empty.ok && empty.settings.welcomeText).toBeNull();
    for (const bad of ['<b>hi</b>', 'a‮b', 'x'.repeat(201)]) {
      const check = settingsOf({ ...base, welcomeText: bad }, UNAVAILABLE);
      expect(check.ok ? [] : check.invalid).toEqual(['welcomeText']);
    }
    const persian = settingsOf({ ...base, welcomeText: 'می‌توانم کمک کنم' }, UNAVAILABLE);
    expect(persian.ok).toBe(true);
  });

  it('refuses an option that is not available yet and keeps the percent only for percent', () => {
    const base = formOf(DEFAULTS);
    const cart = settingsOf(
      { ...base, scope: 'cart-suggestions' },
      { ...UNAVAILABLE, scope: ['cart-suggestions'] },
    );
    expect(cart.ok ? [] : cart.invalid).toEqual(['scope']);
    const all = settingsOf({ ...base, audience: 'all', audiencePercent: '50' }, UNAVAILABLE);
    expect(all.ok && all.settings.audiencePercent).toBeNull();
  });

  it('keeps only the refused fields the form shows', () => {
    expect(
      refusedFields({
        status: 400,
        code: 'validation.failed',
        details: {
          fields: [
            { path: 'guestMessageLimit', code: 'range' },
            { path: 'other', code: 'unknown-field' },
          ],
        },
      }),
    ).toEqual(['guestMessageLimit']);
  });
});

describe('last changed and history (panel settings T3a)', () => {
  it('shows who changed the page last and opens its own history route', async () => {
    HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
      this.removeAttribute('open');
    };
    vi.mocked(callApi).mockReset();
    vi.mocked(callApi).mockResolvedValue({
      ok: true,
      status: 200,
      body: { items: [], next: null },
    });
    mount(
      answer(
        {},
        {
          lastChanged: {
            at: new Date(Date.now() - 2 * 86_400_000).toISOString(),
            byDisplayName: 'Sara K.',
            byKind: 'member' as const,
          },
        },
      ),
    );

    expect(screen.getByTestId('last-changed').textContent).toBe(
      'Last changed by Sara K. · 2 days ago · View history',
    );
    fireEvent.click(screen.getByRole('button', { name: 'View history' }));
    await waitFor(() =>
      expect(vi.mocked(callApi)).toHaveBeenCalledWith(
        'GET',
        'assistant/admin/settings/history?limit=20',
      ),
    );
    expect(await screen.findByText('No changes yet')).toBeTruthy();
  });
});
