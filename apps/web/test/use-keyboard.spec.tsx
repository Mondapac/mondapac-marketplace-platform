// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Dock } from '../src/shell/dock.tsx';
import { KEYBOARD_MIN_DROP, isTextEntry, useKeyboardOpen } from '../src/shell/use-keyboard.ts';

const root = document.documentElement;
const open = () => root.getAttribute('data-keyboard');

/** matchMedia that answers `(pointer: coarse)` and lets a test flip it. */
function stubPointer(initial: boolean) {
  let coarse = initial;
  const listeners = new Set<() => void>();
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      get matches() {
        return coarse;
      },
      addEventListener: (_: string, fn: () => void) => listeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
    })),
  );
  return (value: boolean) => {
    coarse = value;
    listeners.forEach((fn) => fn());
  };
}

/** A visual viewport that a test can resize. */
function stubViewport(height: number, scale = 1) {
  const listeners = new Set<() => void>();
  const viewport = {
    height,
    scale,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  };
  Object.defineProperty(window, 'visualViewport', { value: viewport, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: 667, configurable: true });
  return (next: number, nextScale = 1) => {
    viewport.height = next;
    viewport.scale = nextScale;
    listeners.forEach((fn) => fn());
  };
}

function Probe() {
  useKeyboardOpen();
  return (
    <form>
      <input aria-label="text" />
      <input aria-label="search" type="search" />
      <input aria-label="other" />
      <input aria-label="check" type="checkbox" />
      <input aria-label="disabled" disabled />
      <input aria-label="readonly" readOnly />
      <textarea aria-label="area" />
      <select aria-label="pick">
        <option>a</option>
      </select>
      <button type="button">go</button>
    </form>
  );
}

beforeEach(() => {
  Object.defineProperty(window, 'visualViewport', { value: undefined, configurable: true });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  root.removeAttribute('data-keyboard');
  root.style.removeProperty('--sf-dock-height');
});

const focus = (node: HTMLElement) => act(() => node.focus());
const blur = (node: HTMLElement) => act(() => node.blur());

describe('useKeyboardOpen', () => {
  it('sets data-keyboard="open" while a text field has focus on a touch device, and clears it on blur', () => {
    stubPointer(true);
    const { getByLabelText } = render(<Probe />);
    expect(open()).toBeNull();
    for (const label of ['text', 'search', 'area', 'pick']) {
      const field = getByLabelText(label);
      focus(field);
      expect(open(), label).toBe('open');
      blur(field);
      expect(open(), label).toBeNull();
    }
  });

  it('does nothing with a mouse', () => {
    stubPointer(false);
    const { getByLabelText } = render(<Probe />);
    focus(getByLabelText('text'));
    expect(open()).toBeNull();
  });

  it('ignores fields that bring up no keyboard', () => {
    stubPointer(true);
    const { getByLabelText, getByText } = render(<Probe />);
    for (const node of [
      getByLabelText('check'),
      getByLabelText('disabled'),
      getByLabelText('readonly'),
      getByText('go'),
    ]) {
      focus(node);
      expect(open()).toBeNull();
    }
  });

  it('stays open while focus moves from one field to another', () => {
    stubPointer(true);
    const { getByLabelText } = render(<Probe />);
    const first = getByLabelText('text');
    const second = getByLabelText('other');
    focus(first);
    fireEvent.focusOut(first, { relatedTarget: second });
    expect(open()).toBe('open');
    focus(second);
    expect(open()).toBe('open');
    blur(second);
    expect(open()).toBeNull();
  });

  it('closes when focus moves to a button', () => {
    stubPointer(true);
    const { getByLabelText, getByText } = render(<Probe />);
    focus(getByLabelText('text'));
    focus(getByText('go'));
    expect(open()).toBeNull();
  });

  it('follows the pointer changing from coarse to fine', () => {
    const setCoarse = stubPointer(true);
    const { getByLabelText } = render(<Probe />);
    focus(getByLabelText('text'));
    expect(open()).toBe('open');
    act(() => setCoarse(false));
    expect(open()).toBeNull();
  });

  it('counts a visual viewport that lost the keyboard height as open, but not a zoomed one', () => {
    stubPointer(true);
    const resize = stubViewport(667);
    render(<Probe />);
    expect(open()).toBeNull();
    act(() => resize(667 - KEYBOARD_MIN_DROP));
    expect(open()).toBe('open');
    act(() => resize(667));
    expect(open()).toBeNull();
    act(() => resize(300, 2.5));
    expect(open()).toBeNull();
  });

  it('removes the attribute when the page unmounts', () => {
    stubPointer(true);
    const { getByLabelText, unmount } = render(<Probe />);
    focus(getByLabelText('text'));
    unmount();
    expect(open()).toBeNull();
  });

  it('starts open when a field is focused on load', () => {
    stubPointer(true);
    const field = document.createElement('input');
    document.body.append(field);
    field.focus();
    render(<Probe />);
    expect(open()).toBe('open');
    field.remove();
  });
});

describe('isTextEntry', () => {
  it('is false for a null target and for a plain element', () => {
    expect(isTextEntry(null)).toBe(false);
    expect(isTextEntry(document.createElement('div'))).toBe(false);
  });

  it('is true for an editable element', () => {
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    expect(isTextEntry(editable)).toBe(true);
    editable.setAttribute('contenteditable', 'false');
    expect(isTextEntry(editable)).toBe(false);
  });
});

describe('Dock', () => {
  it('writes its height to --sf-dock-height, and follows it', () => {
    stubPointer(true);
    let notify: () => void = () => undefined;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(fn: () => void) {
          notify = fn;
        }
        observe() {}
        disconnect() {}
      },
    );
    let height = 65;
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(() => height);
    const { unmount } = render(
      <Dock>
        <nav className="tabbar" />
      </Dock>,
    );
    expect(root.style.getPropertyValue('--sf-dock-height')).toBe('65px');
    height = 335;
    act(() => notify());
    expect(root.style.getPropertyValue('--sf-dock-height')).toBe('335px');
    unmount();
    expect(root.style.getPropertyValue('--sf-dock-height')).toBe('');
    vi.restoreAllMocks();
  });

  it('hides the tab bar through the attribute the CSS keys on', () => {
    stubPointer(true);
    const { container } = render(
      <Dock>
        <input aria-label="q" />
      </Dock>,
    );
    act(() => container.querySelector('input')!.focus());
    expect(open()).toBe('open');
  });
});
