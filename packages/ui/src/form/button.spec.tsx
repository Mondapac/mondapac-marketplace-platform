// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Button } from './button.tsx';

afterEach(cleanup);

describe('Button softDisabled', () => {
  it('stays focusable, is aria-disabled and does not use the disabled attribute', () => {
    render(<Button softDisabled>Publish</Button>);
    const button = screen.getByRole<HTMLButtonElement>('button', { name: 'Publish' });
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    button.focus();
    expect(document.activeElement).toBe(button);
    expect(button.className).toContain('cursor-not-allowed');
    expect(button.className).not.toContain('hover:bg-accent-hover');
  });

  it('does not call onClick', () => {
    const onClick = vi.fn();
    render(
      <Button softDisabled onClick={onClick}>
        Publish
      </Button>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('does not submit its form', () => {
    const onSubmit = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <Button type="submit" softDisabled>
          Send
        </Button>
      </form>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('keeps the aria-describedby the caller passes', () => {
    render(
      <>
        <Button softDisabled aria-describedby="why">
          Publish
        </Button>
        <p id="why">Add a title.</p>
      </>,
    );
    expect(screen.getByRole('button').getAttribute('aria-describedby')).toBe('why');
  });

  it('is an ordinary button when not soft disabled', () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Publish</Button>);
    const button = screen.getByRole('button', { name: 'Publish' });
    expect(button.getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
