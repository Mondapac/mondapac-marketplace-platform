// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RangeForm } from './range-form.tsx';

afterEach(cleanup);

const labels = { form: 'Custom range', from: 'From', to: 'To', apply: 'Apply' };

function Harness(props: {
  fromError?: string;
  toError?: string;
  generalError?: string | null;
  showing?: string | null;
  signal?: number;
  onApply?: () => void;
}) {
  const [range, setRange] = useState({ from: '2024-01-01', to: '2026-11-23' });
  return (
    <RangeForm
      labels={labels}
      {...range}
      min="2025-10-24"
      max="2026-11-23"
      fromError={props.fromError}
      toError={props.toError}
      generalError={props.generalError ?? null}
      help="Market days."
      showing={props.showing === undefined ? 'Showing 30 days until you apply.' : props.showing}
      busy={false}
      focusSignal={props.signal ?? 0}
      onChange={setRange}
      onApply={props.onApply ?? (() => undefined)}
    />
  );
}

describe('RangeForm', () => {
  it('sets min and max on the pickers and submits through Apply', () => {
    const onApply = vi.fn();
    render(<Harness onApply={onApply} />);
    expect(screen.getByLabelText<HTMLInputElement>('From').min).toBe('2025-10-24');
    expect(screen.getByLabelText<HTMLInputElement>('From').max).toBe('2026-11-23');
    expect(screen.getByLabelText<HTMLInputElement>('To').max).toBe('2026-11-23');
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it('announces one field error, once, and moves focus to the invalid input', () => {
    const { rerender } = render(<Harness fromError="Start no earlier than 24 Oct 2025." />);
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    rerender(<Harness fromError="Start no earlier than 24 Oct 2025." signal={1} />);
    expect(document.activeElement).toBe(screen.getByLabelText('From'));
  });

  it('puts a general refusal under the pair and hides the "showing" line when asked', () => {
    render(<Harness generalError="This range is not accepted." showing={null} />);
    expect(screen.getByRole('alert').textContent).toBe('This range is not accepted.');
    expect(screen.queryByText(/until you apply/)).toBeNull();
  });
});
