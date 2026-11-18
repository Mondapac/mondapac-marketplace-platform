// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BottomSheet } from './bottom-sheet.tsx';

const original = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute('open', '');
  };
});
afterEach(() => {
  cleanup();
  if (original === undefined) Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
  else Object.defineProperty(HTMLDialogElement.prototype, 'showModal', original);
});

describe('BottomSheet', () => {
  it('lets a long title wrap instead of cutting it with an ellipsis', () => {
    render(
      <BottomSheet
        open
        title="Reject SR-1042 and put the previous value back?"
        closeLabel="Close"
        onClose={() => undefined}
      >
        <p>Body</p>
      </BottomSheet>,
    );
    const heading = screen.getByRole('heading', { name: /put the previous value back/ });
    expect(heading.className).toContain('break-words');
    expect(heading.className).not.toContain('truncate');
    // The header never shrinks, the close button keeps its size and only the body scrolls.
    expect(heading.parentElement?.className).toContain('shrink-0');
    expect(screen.getByRole('button', { name: 'Close' }).parentElement?.className).toContain(
      'shrink-0',
    );
    expect(screen.getByText('Body').parentElement?.className).toContain('overflow-y-auto');
  });
});
