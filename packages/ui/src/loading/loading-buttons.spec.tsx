// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Button } from '../form/button.tsx';
import { IconButton } from '../form/icon-button.tsx';

// Panel loading L1: a busy button shows a 14 px spinner at once, its in-progress label, keeps its
// width and focus, and ignores a second click. A busy icon button swaps its icon for the spinner.

afterEach(cleanup);

function Save({ onSave }: { readonly onSave: () => void }) {
  const [saving, setSaving] = useState(false);
  return (
    <Button
      loading={saving}
      loadingLabel="Saving…"
      onClick={() => {
        onSave();
        setSaving(true);
      }}
    >
      Save changes
    </Button>
  );
}

describe('Button loading', () => {
  it('shows the spinner and the in-progress label, keeps focus and ignores a second click', () => {
    const onSave = vi.fn();
    render(<Save onSave={onSave} />);
    const button = screen.getByRole('button');
    expect(screen.queryByTestId('spinner')).toBeNull();
    button.focus();
    act(() => button.click());
    expect(button.textContent).toBe('Saving…');
    expect(screen.getByTestId('spinner').getAttribute('aria-hidden')).toBe('true');
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.hasAttribute('disabled')).toBe(false);
    expect(document.activeElement).toBe(button);
    act(() => button.click());
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('holds the width it had at rest', () => {
    const width = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(132);
    const { rerender } = render(<Button>Save changes</Button>);
    rerender(
      <Button loading loadingLabel="Saving…">
        Save changes
      </Button>,
    );
    expect(screen.getByRole('button').style.minWidth).toBe('132px');
    rerender(<Button>Save changes</Button>);
    expect(screen.getByRole('button').style.minWidth).toBe('');
    width.mockRestore();
  });

  it('keeps its label when no in-progress label is given', () => {
    render(<Button loading>Export</Button>);
    expect(screen.getByRole('button').textContent).toBe('Export');
    expect(screen.getByTestId('spinner')).not.toBeNull();
  });
});

describe('IconButton loading', () => {
  it('replaces the icon with the spinner and ignores clicks', () => {
    const onClick = vi.fn();
    render(<IconButton icon="arrow-left" label="Back" loading onClick={onClick} />);
    const button = screen.getByRole('button', { name: 'Back' });
    expect(button.querySelectorAll('svg')).toHaveLength(1);
    expect(screen.getByTestId('spinner')).not.toBeNull();
    expect(button.getAttribute('aria-busy')).toBe('true');
    act(() => button.click());
    expect(onClick).not.toHaveBeenCalled();
  });
});
