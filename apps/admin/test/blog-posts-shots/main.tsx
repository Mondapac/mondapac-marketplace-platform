import { NextIntlClientProvider } from 'next-intl';
import { createRoot } from 'react-dom/client';
import messages from '../../messages/en.json';
import '../../app/globals.css';
import { PostsList } from '../../src/blog/posts-list.tsx';

createRoot(document.getElementById('root')!).render(
  <NextIntlClientProvider locale="en-AU" messages={messages}>
    <main className="mx-auto max-w-7xl p-4 md:p-6">
      <h1 className="mb-2 text-2xl font-semibold">{messages.blog.title}</h1>
      <PostsList
        paging="pages"
        accountId="0190a000-0000-7000-8000-0000000000a1"
        marketId="AU"
        zone="Australia/Brisbane"
        canEdit
        initialView="all"
      />
    </main>
  </NextIntlClientProvider>,
);
