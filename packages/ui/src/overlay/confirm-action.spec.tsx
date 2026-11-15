// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmAction, type ConfirmActionProps } from './confirm-action.tsx';

beforeEach(() => {
  // jsdom has no modal <dialog>.
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});
afterEach(cleanup);

const base = (over: Partial<ConfirmActionProps> = {}): ConfirmActionProps => ({
  open: true,
  level: 2,
  title: 'Suspend Ada?',
  body: 'She is signed out.',
  rowName: 'Ada',
  confirmLabel: 'Suspend',
  cancelLabel: 'Keep',
  pending: false,
  onConfirm: () => {},
  onCancel: () => {},
  ...over,
});

describe('ConfirmAction', () => {
  it('level 2 confirms at once with a red button, and focus starts on Cancel', () => {
    const onConfirm = vi.fn();
    render(<ConfirmAction {...base({ onConfirm })} />);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Keep' }));
    const confirm = screen.getByRole('button', { name: 'Suspend' });
    expect(confirm.className).toContain('bg-critical-solid');
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith('');
  });

  it('keeps Confirm off until a required reason is given, then passes it on', () => {
    const onConfirm = vi.fn();
    render(<ConfirmAction {...base({ onConfirm, reason: { label: 'Reason', required: true } })} />);
    const confirm = screen.getByRole('button', { name: 'Suspend' });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: ' fraud ' } });
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith('fraud');
  });

  it('level 3 needs the row name typed exactly', () => {
    const onConfirm = vi.fn();
    render(<ConfirmAction {...base({ level: 3, typeLabel: 'Type the name', onConfirm })} />);
    const confirm = screen.getByRole<HTMLButtonElement>('button', { name: 'Suspend' });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Type the name'), { target: { value: 'Ad' } });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Type the name'), { target: { value: 'Ada' } });
    expect(confirm.disabled).toBe(false);
  });

  it('shows the step-up note and the failure of the last try', () => {
    render(<ConfirmAction {...base({ level: 3, stepUpNote: 'A code is next.', error: 'No.' })} />);
    expect(screen.getByText('A code is next.')).toBeTruthy();
    expect(screen.getByText('No.')).toBeTruthy();
  });

  it('cannot be cancelled while the request runs', () => {
    const onCancel = vi.fn();
    render(<ConfirmAction {...base({ pending: true, onCancel })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('starts empty again when it is closed and opened again', () => {
    const { rerender } = render(
      <ConfirmAction {...base({ level: 3, typeLabel: 'Type the name' })} />,
    );
    fireEvent.change(screen.getByLabelText('Type the name'), { target: { value: 'Ada' } });
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Suspend' }).disabled).toBe(false);
    rerender(<ConfirmAction {...base({ open: false, level: 3, typeLabel: 'Type the name' })} />);
    rerender(<ConfirmAction {...base({ level: 3, typeLabel: 'Type the name' })} />);
    expect(screen.getByLabelText<HTMLInputElement>('Type the name').value).toBe('');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Suspend' }).disabled).toBe(true);
  });

  it('level 3 with no row name never enables Confirm', () => {
    render(<ConfirmAction {...base({ level: 3, rowName: '', typeLabel: 'Type the name' })} />);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Suspend' }).disabled).toBe(true);
  });
});
