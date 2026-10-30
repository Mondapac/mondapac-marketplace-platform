import type { PanelToolsLabels } from './panel-tools.tsx';

/**
 * The palette's texts, read from the app's catalogue under the `palette.*` keys both panels share
 * (the keys are fixed here, the words stay in each app's messages, ADR-0033 decision 10).
 * `text` returns the message as written, placeholders such as `{query}` and `{count}` included.
 */
export function panelToolsLabels(text: (key: string) => string): PanelToolsLabels {
  return {
    search: text('palette.search'),
    palette: {
      title: text('palette.title'),
      placeholder: text('palette.placeholder'),
      close: text('palette.close'),
      results: text('palette.results'),
      recent: text('palette.recent'),
      kind: {
        page: text('palette.kind.page'),
        setting: text('palette.kind.setting'),
        action: text('palette.kind.action'),
      },
      empty: text('palette.empty'),
      countOne: text('palette.count-one'),
      countMany: text('palette.count-many'),
      hintMove: text('palette.hint-move'),
      hintOpen: text('palette.hint-open'),
      hintClose: text('palette.hint-close'),
    },
    pin: {
      pin: text('palette.pin.pin'),
      unpin: text('palette.pin.unpin'),
      limit: text('palette.pin.limit'),
    },
    pinned: text('palette.pinned'),
    shortcuts: {
      title: text('palette.shortcuts.title'),
      close: text('palette.shortcuts.close'),
      openSearch: text('palette.shortcuts.open-search'),
      showList: text('palette.shortcuts.show-list'),
      then: text('palette.shortcuts.then'),
    },
  };
}
