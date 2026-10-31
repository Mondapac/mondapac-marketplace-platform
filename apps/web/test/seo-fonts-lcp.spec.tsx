// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it } from 'vitest';
import messages from '../messages/en.json';
import { Gallery } from '../src/product/gallery.tsx';

afterEach(cleanup);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'node_modules' || name === '.next' || name === 'test') return [];
    return statSync(path).isDirectory() ? sourceFiles(path) : [path];
  });
}

describe('self-hosted fonts', () => {
  it('names no Google Fonts host anywhere in apps/web source', () => {
    const offenders = ['app', 'src', 'public', 'server.mjs', 'next.config.ts', 'proxy.ts']
      .flatMap((entry) => {
        const path = join(process.cwd(), entry);
        return statSync(path).isDirectory() ? sourceFiles(path) : [path];
      })
      .filter((file) => /fonts\.(googleapis|gstatic)\.com/.test(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });
});

describe('product gallery LCP image', () => {
  it('loads the main photo with high priority and lazy-loads the rest', () => {
    const { container } = render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <Gallery
          name="Lamb shoulder"
          category="meat"
          photos={['/a.jpg', '/b.jpg', '/c.jpg']}
          certifications={[]}
          special={false}
        />
      </NextIntlClientProvider>,
    );
    const images = [...container.querySelectorAll<HTMLImageElement>('.gslide img')];
    expect(images).toHaveLength(3);
    expect(images[0]!.getAttribute('fetchpriority')).toBe('high');
    expect(images[0]!.getAttribute('loading')).toBeNull();
    expect(images[1]!.getAttribute('loading')).toBe('lazy');
    expect(images[1]!.getAttribute('fetchpriority')).not.toBe('high');
  });
});
