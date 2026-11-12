'use client';

import { Banner, Button, Select, TextField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { callApi } from '../../api/client.ts';
import { API_BLOG_POSTS, BLOG_PATH, POST_KINDS, postPath, type PostKind } from '../types.ts';
import { editorProblemOf, type EditorProblem } from './editor-errors.ts';
import { LIMITS, type PostDetail } from './types.ts';

/**
 * The start of a post: its type and a title. The draft is created at once and the editor opens on
 * it; the address is made from the title and can be changed there.
 */
export function NewPostForm({ csrfToken }: { readonly csrfToken: string }) {
  const t = useTranslations('blog.editor');
  const tc = useTranslations('blog');
  const [kind, setKind] = useState<PostKind>('product');
  const [title, setTitle] = useState('');
  const [problem, setProblem] = useState<EditorProblem | null>(null);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);

  async function create() {
    if (busy.current) return;
    if (title.trim() === '') {
      setProblem({
        key: 'blog.editor.error.title-required',
        reload: false,
        fields: [],
        findings: [],
      });
      return;
    }
    busy.current = true;
    setPending(true);
    setProblem(null);
    const result = await callApi<PostDetail>(
      'POST',
      API_BLOG_POSTS,
      { kind, content: { title: title.trim(), excerpt: '', body: [] } },
      csrfToken,
    );
    if (result.ok) {
      window.location.assign(postPath(result.body.id));
      return;
    }
    busy.current = false;
    setPending(false);
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    setProblem(editorProblemOf(result.failure));
  }

  return (
    <form
      className="flex max-w-xl flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void create();
      }}
    >
      <p className="text-fg-muted">{t('new.intro')}</p>
      <Select
        label={t('side.type')}
        value={kind}
        disabled={pending}
        options={POST_KINDS.map((value) => ({ value, label: tc(`kind.${value}`) }))}
        onChange={(event) => setKind(event.target.value as PostKind)}
      />
      <TextField
        label={t('field.title')}
        value={title}
        maxLength={LIMITS.title}
        disabled={pending}
        autoComplete="off"
        onChange={(event) => setTitle(event.target.value)}
      />
      {problem === null ? null : (
        <Banner tone="critical">
          <span>{t(problem.key.replace('blog.editor.', ''))}</span>
        </Banner>
      )}
      <div className="flex gap-2">
        <Button type="submit" loading={pending} disabled={pending}>
          {t('new.create')}
        </Button>
        <a
          className="inline-flex items-center px-3 font-medium text-link underline"
          href={BLOG_PATH}
        >
          {t('new.cancel')}
        </a>
      </div>
    </form>
  );
}
