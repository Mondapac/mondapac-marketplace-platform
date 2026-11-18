// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { BottomSheet } from './bottom-sheet.tsx';

afterEach(cleanup);

describe('BottomSheet', () => {
  it('lets a long title wrap instead of cutting it with an ellipsis', () => {
    HTMLDialogElement.prototype.showModal = function showModal() {
      this.setAttribute('open', '');
    };
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
  });
});
