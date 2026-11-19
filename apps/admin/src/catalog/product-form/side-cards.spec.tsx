// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/en.json';
import { StatusCard } from './side-cards.tsx';

afterEach(cleanup);

function mount(over: { canPublish: boolean; pending: boolean }, onPublish = vi.fn()) {
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <StatusCard
        status="draft"
        publishedNo={null}
        nextNo={1}
        hasRevision={false}
        blockers={over.canPublish ? null : 'To publish: add a title.'}
        canPublish={over.canPublish}
        pending={over.pending}
        onPublish={onPublish}
        onDiscard={null}
        active={null}
      />
    </NextIntlClientProvider>,
  );
  return onPublish;
}

describe('StatusCard Publish button', () => {
  it('is natively disabled while a request runs, even when publishing is allowed', () => {
    const onPublish = mount({ canPublish: true, pending: true });
    const publish = screen.getByRole<HTMLButtonElement>('button', { name: 'Publish' });
    expect(publish.disabled).toBe(true);
    expect(publish.hasAttribute('aria-disabled')).toBe(false);
    fireEvent.click(publish);
    expect(onPublish).not.toHaveBeenCalled();
  });

  it('is an active button when nothing is missing and nothing runs', () => {
    const onPublish = mount({ canPublish: true, pending: false });
    const publish = screen.getByRole<HTMLButtonElement>('button', { name: 'Publish' });
    expect(publish.disabled).toBe(false);
    expect(publish.hasAttribute('aria-disabled')).toBe(false);
    fireEvent.click(publish);
    expect(onPublish).toHaveBeenCalledTimes(1);
  });

  it('is focusable and inert while fields are missing', () => {
    const onPublish = mount({ canPublish: false, pending: false });
    const publish = screen.getByRole<HTMLButtonElement>('button', { name: 'Publish' });
    expect(publish.disabled).toBe(false);
    expect(publish.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(publish);
    expect(onPublish).not.toHaveBeenCalled();
  });
});
