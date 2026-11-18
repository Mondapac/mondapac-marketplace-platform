// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

  it('ignores Enter and Space on the focused button', async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    render(
      <Button softDisabled onClick={onClick}>
        Publish
      </Button>,
    );
    screen.getByRole('button', { name: 'Publish' }).focus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(onClick).not.toHaveBeenCalled();
  });

  it('does not submit the form on Enter in a text field, but an enabled button does', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
    const form = (soft: boolean) => (
      <form onSubmit={onSubmit}>
        <input aria-label="Title" />
        <Button type="submit" softDisabled={soft}>
          Send
        </Button>
      </form>
    );
    const { unmount } = render(form(true));
    await user.type(screen.getByLabelText('Title'), 'x{Enter}');
    expect(onSubmit).not.toHaveBeenCalled();
    unmount();
    render(form(false));
    await user.type(screen.getByLabelText('Title'), 'x{Enter}');
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('stays natively disabled when also soft disabled', () => {
    const onClick = vi.fn();
    render(
      <Button disabled softDisabled onClick={onClick}>
        Publish
      </Button>,
    );
    const button = screen.getByRole<HTMLButtonElement>('button', { name: 'Publish' });
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('becomes active again when softDisabled turns off', () => {
    const onClick = vi.fn();
    const { rerender } = render(
      <Button softDisabled onClick={onClick}>
        Publish
      </Button>,
    );
    rerender(
      <Button softDisabled={false} onClick={onClick}>
        Publish
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Publish' });
    expect(button.hasAttribute('aria-disabled')).toBe(false);
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('has no hover class on a soft-disabled secondary button', () => {
    render(
      <Button variant="secondary" softDisabled>
        Publish
      </Button>,
    );
    expect(screen.getByRole('button').className).not.toContain('hover:');
  });
});
