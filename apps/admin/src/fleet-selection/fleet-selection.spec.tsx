// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { checkForm, EMPTY_FORM, moved, scoreOf } from './form.ts';
import { FleetSelectionPanel } from './fleet-selection-panel.tsx';
import type { Selection } from './types.ts';
import { expectToast } from '../../test/toast-spy.ts';

const call = vi.mocked(callApi);
const wrap = (node: ReactNode) => (
  <NextIntlClientProvider locale="en-AU" messages={messages}>
    {node}
  </NextIntlClientProvider>
);

const MODEL = '01990000-0000-7000-8000-000000000001';
const MODEL3 = '01990000-0000-7000-8000-000000000003';
const selection = (patch: Partial<Selection> = {}): Selection => ({
  models: [
    { id: MODEL, name: 'Cheapest first', rule: { kind: 'cheapest' }, version: 1 },
    {
      id: MODEL3,
      name: 'Own fleet first',
      rule: { kind: 'fixed_priority', order: ['mondapac_drive'] },
      version: 1,
    },
  ],
  active: { instant: null, same_day: null, scheduled: null },
  defaultOrder: ['mondapac_drive', 'uber_direct', 'zoom2u', 'auspost'],
  fleets: [
    {
      fleet: 'mondapac_drive',
      displayName: 'Mondapac Drive',
      enabled: true,
      methods: ['instant', 'same_day'],
      reliability: 90,
      effectiveReliability: 90,
    },
    {
      fleet: 'uber_direct',
      displayName: 'Uber Direct',
      enabled: false,
      methods: [],
      reliability: null,
      effectiveReliability: 50,
    },
    {
      fleet: 'zoom2u',
      displayName: 'Zoom2u',
      enabled: false,
      methods: [],
      reliability: null,
      effectiveReliability: 50,
    },
    {
      fleet: 'auspost',
      displayName: 'Australia Post',
      enabled: false,
      methods: [],
      reliability: null,
      effectiveReliability: 50,
    },
  ],
  ...patch,
});

const mount = (initial: Selection, canManage = true) =>
  render(wrap(<FleetSelectionPanel initial={initial} canManage={canManage} csrfToken="csrf" />));
/** The dialog is a native modal; jsdom keeps it in the tree, so the confirm button is reachable. */
const confirmDialog = () =>
  fireEvent.click(screen.getByRole('button', { name: 'Confirm', hidden: true }));
const ok = <T,>(body: T) => ({ ok: true as const, status: 200, body });
const refused = (status: number, code: string) => ({
  ok: false as const,
  failure: { status, code },
});

vi.setConfig({ testTimeout: 30_000 });

beforeEach(() => {
  vi.resetAllMocks();
  // jsdom has no modal support: a stub makes `showModal` open the element.
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
});
afterEach(cleanup);

describe('the model form checks', () => {
  it('accepts the three kinds and flags what is wrong', () => {
    expect(checkForm({ ...EMPTY_FORM, name: 'A' })).toEqual({
      ok: true,
      name: 'A',
      rule: { kind: 'cheapest' },
    });
    expect(checkForm({ ...EMPTY_FORM, name: ' ', kind: 'weighted' })).toEqual({
      ok: false,
      invalid: ['name'],
    });
    const zero = { price: '0', eta: '0', reliability: '0' };
    expect(checkForm({ ...EMPTY_FORM, name: 'A', kind: 'weighted', weights: zero })).toEqual({
      ok: false,
      invalid: ['weights'],
    });
    expect(
      checkForm({ ...EMPTY_FORM, name: 'A', kind: 'weighted', weights: { ...zero, eta: '101' } }),
    ).toEqual({ ok: false, invalid: ['weights'] });
    expect(checkForm({ ...EMPTY_FORM, name: 'A', kind: 'fixed_priority', order: [] })).toEqual({
      ok: false,
      invalid: ['order'],
    });
    expect(
      checkForm({ ...EMPTY_FORM, name: 'A', kind: 'fixed_priority', order: ['zoom2u'] }),
    ).toEqual({ ok: true, name: 'A', rule: { kind: 'fixed_priority', order: ['zoom2u'] } });
  });

  it('reads a score as a whole number from 0 to 100 and moves a fleet by one place', () => {
    expect(['0', '100', ' 7 '].map(scoreOf)).toEqual([0, 100, 7]);
    expect(['101', '-1', '1.5', '', 'x'].map(scoreOf)).toEqual([null, null, null, null, null]);
    expect(moved(['zoom2u', 'auspost'], 1, -1)).toEqual(['auspost', 'zoom2u']);
    expect(moved(['zoom2u', 'auspost'], 0, -1)).toEqual(['zoom2u', 'auspost']);
  });
});

describe('the fleet selection page', () => {
  it('shows the models, the fleets and the reliability score as admin-set', () => {
    mount(selection());

    expect(screen.getByRole('heading', { name: 'Cheapest first' })).toBeTruthy();
    expect(screen.getByText('Lowest quote wins. A tie goes to Mondapac Drive.')).toBeTruthy();
    expect(screen.getAllByText('Not active for any method').length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { name: 'Mondapac Drive' })).toBeTruthy();
    expect(screen.getByText('On in this Market')).toBeTruthy();
    expect(screen.getAllByText('Off in this Market')[0]).toBeTruthy();
    expect(screen.getByText(/set for now/)).toBeTruthy();
    expect(screen.getAllByText('Not set. The router uses 50.')[0]).toBeTruthy();
  });

  it('is read-only without the manage permission', () => {
    mount(selection(), false);

    expect(screen.queryByRole('button', { name: 'Save active models' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'New model' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save score' })).toBeNull();
    expect(screen.getAllByText('Reliability (0 to 100):')).toHaveLength(4);
  });

  it('saves only the methods whose model changed', async () => {
    call.mockResolvedValue(
      ok(selection({ active: { instant: MODEL, same_day: null, scheduled: null } })),
    );
    mount(selection());

    fireEvent.change(screen.getByLabelText('Instant'), { target: { value: MODEL } });
    fireEvent.click(screen.getByRole('button', { name: 'Save active models' }));
    confirmDialog();

    await expectToast('Active models saved. They apply to the next booking.');
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith(
      'PUT',
      'shipping/admin/fleet-selection/active/instant',
      { modelId: MODEL },
      'csrf',
    );
    expect(screen.getByText('Active for: Instant')).toBeTruthy();
  });

  it('goes back to the built-in order with a null model', async () => {
    const active = selection({ active: { instant: MODEL, same_day: null, scheduled: null } });
    call.mockResolvedValue(ok(selection()));
    mount(active);

    fireEvent.change(screen.getByLabelText('Instant'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save active models' }));
    confirmDialog();

    await waitFor(() => expect(call).toHaveBeenCalled());
    expect(call).toHaveBeenCalledWith(
      'PUT',
      'shipping/admin/fleet-selection/active/instant',
      { modelId: null },
      'csrf',
    );
  });

  it('creates a weighted model, then reads the page again', async () => {
    call.mockResolvedValueOnce(ok({})).mockResolvedValueOnce(ok(selection()));
    mount(selection());

    fireEvent.click(screen.getByRole('button', { name: 'New model' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Balanced' } });
    fireEvent.change(screen.getByLabelText('Kind'), { target: { value: 'weighted' } });
    fireEvent.change(screen.getByLabelText('Price'), { target: { value: '60' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save model' }));

    await expectToast('Model created.');
    expect(call).toHaveBeenNthCalledWith(
      1,
      'POST',
      'shipping/admin/fleet-selection/models',
      {
        name: 'Balanced',
        rule: { kind: 'weighted', weights: { price: 60, eta: 30, reliability: 20 } },
      },
      'csrf',
    );
    expect(call).toHaveBeenNthCalledWith(2, 'GET', 'shipping/admin/fleet-selection');
  });

  it('flags a bad form without calling the API', () => {
    mount(selection());

    fireEvent.click(screen.getByRole('button', { name: 'New model' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save model' }));

    expect(screen.getByText('Enter a name of 1 to 60 characters.')).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
  });

  it('builds a fixed priority list: move, remove and add', async () => {
    call.mockResolvedValueOnce(ok({})).mockResolvedValueOnce(ok(selection()));
    mount(selection());

    fireEvent.click(screen.getByRole('button', { name: 'New model' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Drive last' } });
    fireEvent.change(screen.getByLabelText('Kind'), { target: { value: 'fixed_priority' } });
    fireEvent.click(screen.getByRole('button', { name: 'Move Mondapac Drive down' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Uber Direct' }));
    fireEvent.click(screen.getByLabelText('Add Australia Post (off in this Market)'));
    fireEvent.click(screen.getByRole('button', { name: 'Save model' }));

    await waitFor(() => expect(call).toHaveBeenCalledTimes(2));
    expect(call.mock.calls[0]?.[2]).toEqual({
      name: 'Drive last',
      rule: {
        kind: 'fixed_priority',
        order: ['mondapac_drive', 'zoom2u', 'auspost'],
      },
    });
  });

  it('sends the version read when editing, and shows what is stored after a conflict', async () => {
    call.mockResolvedValueOnce(refused(409, 'shipping.fleet-model-conflict')).mockResolvedValueOnce(
      ok(
        selection({
          models: [{ id: MODEL, name: 'Newer', rule: { kind: 'cheapest' }, version: 2 }],
        }),
      ),
    );
    mount(selection());

    fireEvent.click(screen.getByRole('button', { name: 'Edit Cheapest first' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Mine' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save model' }));

    await waitFor(() => expect(screen.getByText(/Someone saved this model first/)).toBeTruthy());
    expect(call.mock.calls[0]).toEqual([
      'PUT',
      `shipping/admin/fleet-selection/models/${MODEL}`,
      { name: 'Mine', rule: { kind: 'cheapest' }, expectedVersion: 1 },
      'csrf',
    ]);
    expect(screen.getByRole('heading', { name: 'Newer' })).toBeTruthy();
    expect(screen.queryByLabelText('Name')).toBeNull();
  });

  it('says a name is taken', async () => {
    call.mockResolvedValueOnce(refused(409, 'shipping.fleet-model-name-taken'));
    mount(selection());

    fireEvent.click(screen.getByRole('button', { name: 'New model' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'cheapest first' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save model' }));

    await waitFor(() =>
      expect(screen.getByText('Another model already has this name.')).toBeTruthy(),
    );
  });

  it('saves a reliability score for one fleet and refuses a bad one', async () => {
    call.mockResolvedValue(ok(selection()));
    mount(selection());
    const drive = screen.getByRole('heading', { name: 'Mondapac Drive' }).closest('li')!;

    fireEvent.change(within(drive).getByLabelText('Reliability (0 to 100)'), {
      target: { value: '120' },
    });
    fireEvent.click(within(drive).getByRole('button', { name: 'Save score' }));
    expect(within(drive).getByText('Enter a whole number from 0 to 100.')).toBeTruthy();
    expect(call).not.toHaveBeenCalled();

    fireEvent.change(within(drive).getByLabelText('Reliability (0 to 100)'), {
      target: { value: '75' },
    });
    fireEvent.click(within(drive).getByRole('button', { name: 'Save score' }));

    await expectToast('Score saved.');
    expect(call).toHaveBeenCalledWith(
      'PUT',
      'shipping/admin/fleet-selection/fleets/mondapac_drive/reliability',
      { score: 75 },
      'csrf',
    );
  });

  it('sends a signed-out admin to the session-ended page', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    call.mockResolvedValue(refused(401, 'session.invalid'));
    mount(selection());

    fireEvent.change(screen.getByLabelText('Instant'), { target: { value: MODEL } });
    fireEvent.click(screen.getByRole('button', { name: 'Save active models' }));
    confirmDialog();

    await waitFor(() => expect(assign).toHaveBeenCalledWith('/session-ended'));
    vi.unstubAllGlobals();
  });
});

describe('the review changes', () => {
  it('shows what each changed method goes from and to, and sends nothing until confirmed', () => {
    mount(selection({ active: { instant: MODEL3, same_day: null, scheduled: null } }));

    fireEvent.change(screen.getByLabelText('Instant'), { target: { value: MODEL } });
    fireEvent.click(screen.getByRole('button', { name: 'Save active models' }));

    expect(
      screen.getByText(
        'Instant: Own fleet first → Cheapest first. Every new Instant order will use this rule.',
      ),
    ).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Go back', hidden: true }));
    expect(call).not.toHaveBeenCalled();
  });

  it('lists the kind in each model option', () => {
    mount(selection());
    expect(
      within(screen.getByLabelText('Instant')).getByRole('option', {
        name: 'Cheapest first (Cheapest)',
      }),
    ).toBeTruthy();
  });

  it('warns and asks again before saving a model that is active', async () => {
    call.mockResolvedValueOnce(ok({})).mockResolvedValueOnce(ok(selection()));
    mount(selection({ active: { instant: MODEL, same_day: null, scheduled: null } }));

    fireEvent.click(screen.getByRole('button', { name: 'Edit Cheapest first' }));
    expect(screen.getByText(/This model is active for Instant/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save model' }));
    expect(call).not.toHaveBeenCalled();
    expect(screen.getByText(/^Cheapest first is active for Instant/)).toBeTruthy();
    confirmDialog();

    await waitFor(() => expect(call).toHaveBeenCalledTimes(2));
  });

  it('says a viewer can look but not change', () => {
    mount(selection(), false);
    expect(screen.getByText('You can view but not change delivery fleets.')).toBeTruthy();
  });

  it('ties a weights error to its inputs and focuses the first one', () => {
    mount(selection());

    fireEvent.click(screen.getByRole('button', { name: 'New model' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'W' } });
    fireEvent.change(screen.getByLabelText('Kind'), { target: { value: 'weighted' } });
    for (const label of ['Price', 'Arrival time', 'Reliability']) {
      fireEvent.change(screen.getByLabelText(label), { target: { value: '0' } });
    }
    fireEvent.click(screen.getByRole('button', { name: 'Save model' }));

    const price = screen.getByLabelText('Price');
    expect(price.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(price);
    expect(screen.getAllByText('At least one weight must be above 0')).toHaveLength(3);
    const group = screen.getByRole('group', { name: 'Weights' });
    const alert = screen.getByText('Enter whole numbers from 0 to 100, not all 0.');
    expect(group.getAttribute('aria-describedby')).toBe(alert.id);
    expect(call).not.toHaveBeenCalled();
  });

  it('shows each weight as a share of the total', () => {
    mount(selection());

    fireEvent.click(screen.getByRole('button', { name: 'New model' }));
    fireEvent.change(screen.getByLabelText('Kind'), { target: { value: 'weighted' } });

    expect(screen.getByText('50 of 100 (50%)')).toBeTruthy();
    expect(screen.getByText('Total: 100')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Price'), { target: { value: '100' } });
    expect(screen.getByText('100 of 150 (67%)')).toBeTruthy();
    expect(screen.getByText('Total: 150')).toBeTruthy();
  });

  it('focuses the name when the form opens', () => {
    mount(selection());
    fireEvent.click(screen.getByRole('button', { name: 'New model' }));
    expect(document.activeElement).toBe(screen.getByLabelText('Name'));
  });

  it('announces a move and keeps focus on a usable arrow', () => {
    mount(selection());
    fireEvent.click(screen.getByRole('button', { name: 'New model' }));
    fireEvent.change(screen.getByLabelText('Kind'), { target: { value: 'fixed_priority' } });

    const up = screen.getByRole('button', { name: 'Move Uber Direct up' });
    up.focus();
    fireEvent.click(up);

    expect(screen.getByText('Uber Direct moved to position 1')).toBeTruthy();
    // It is first now, so its Up arrow is disabled and focus goes to Down.
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Move Uber Direct down' }),
    );
  });

  it('marks a fleet that is off in this Market in the add list', () => {
    mount(selection());
    fireEvent.click(screen.getByRole('button', { name: 'New model' }));
    fireEvent.change(screen.getByLabelText('Kind'), { target: { value: 'fixed_priority' } });
    expect(screen.getByLabelText('Add Australia Post (off in this Market)')).toBeTruthy();
  });

  it('moves focus to the note that the page was reloaded after a conflict', async () => {
    call
      .mockResolvedValueOnce(refused(409, 'shipping.fleet-model-conflict'))
      .mockResolvedValueOnce(ok(selection()));
    mount(selection());
    fireEvent.click(screen.getByRole('button', { name: 'Edit Cheapest first' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Mine' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save model' }));

    const notice = await screen.findByText(/Someone saved this model first/);
    await waitFor(() => expect(document.activeElement).toBe(notice.closest('[tabindex]')));
  });
});

describe('right-to-left readiness', () => {
  // The admin has one English catalogue and a fixed `dir="ltr"` today. When a Persian catalogue
  // arrives the page must mirror without edits, so it uses logical spacing and alignment only.
  it('uses no physical left or right classes', () => {
    const files = readdirSync(__dirname).filter(
      (name) => /\.tsx$/.test(name) && !/spec/.test(name),
    );
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = readFileSync(join(__dirname, file), 'utf8');
      expect(text, file).not.toMatch(
        /\b(?:m|p)[lr]-\d|\btext-(?:left|right)\b|\b(?:left|right)-\d/,
      );
    }
  });
});
