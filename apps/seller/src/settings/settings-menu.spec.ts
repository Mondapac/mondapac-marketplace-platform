import { buildSettingsMenuGroups } from '@mondapac/ui';
import { describe, expect, it } from 'vitest';
import messages from '../../messages/en.json';
import { settingEntries, visibleSettings } from './settings-nav.ts';

const label = (key: string): string =>
  key
    .split('.')
    .reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], messages) as string;
const menu = (keys: string[]) =>
  buildSettingsMenuGroups(visibleSettings(keys), settingEntries, label);

describe('seller Settings menu', () => {
  it('lists only the pages whose view key the user holds', () => {
    const links = menu(['inventory.stock.view']).flatMap((g) => g.links.map((l) => l.id));
    expect(links).toEqual(['stock-locations']);
  });

  it('is empty without any settings view key', () => {
    expect(menu([])).toEqual([]);
  });
});
