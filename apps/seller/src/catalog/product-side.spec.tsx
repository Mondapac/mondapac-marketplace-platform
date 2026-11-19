// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';
import { StatusCard } from './product-side.tsx';

afterEach(cleanup);

function mount(over: { canSubmit: boolean; pending: boolean }, onSubmit = vi.fn()) {
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <StatusCard
        status="draft"
        waiting={false}
        published={false}
        blockers={over.canSubmit ? null : 'To submit: add a title.'}
        canSubmit={over.canSubmit}
        pending={over.pending}
        onSubmit={onSubmit}
        replacePending={null}
      />
    </NextIntlClientProvider>,
  );
  return onSubmit;
}

describe('StatusCard Submit for review button', () => {
  it('is natively disabled while a request runs, even when submitting is allowed', () => {
    const onSubmit = mount({ canSubmit: true, pending: true });
    const submit = screen.getByRole<HTMLButtonElement>('button', { name: 'Submit for review' });
    expect(submit.disabled).toBe(true);
    expect(submit.hasAttribute('aria-disabled')).toBe(false);
    fireEvent.click(submit);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('is an active button when nothing is missing and nothing runs', () => {
    const onSubmit = mount({ canSubmit: true, pending: false });
    const submit = screen.getByRole<HTMLButtonElement>('button', { name: 'Submit for review' });
    expect(submit.disabled).toBe(false);
    expect(submit.hasAttribute('aria-disabled')).toBe(false);
    fireEvent.click(submit);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('is focusable and inert while fields are missing', () => {
    const onSubmit = mount({ canSubmit: false, pending: false });
    const submit = screen.getByRole<HTMLButtonElement>('button', { name: 'Submit for review' });
    expect(submit.disabled).toBe(false);
    expect(submit.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(submit);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
