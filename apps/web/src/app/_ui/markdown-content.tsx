import type { ReactElement } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * What a model wrote, rendered as the Markdown it writes in -- the rules only,
 * no styling, so they can be tested without a design system in the way.
 *
 * Treated as untrusted: an agent with web-fetch answers with text a stranger's
 * page put in front of it, and that page can carry instructions.
 *
 * - No raw HTML. It is dropped, not escaped into view and not rendered.
 * - Links go through react-markdown's URL filter, which drops `javascript:`
 *   and every other scheme that runs something, and open in a new tab that
 *   cannot reach back into the console.
 * - No image is fetched. An `<img>` loads the moment it renders, so an injected
 *   "show this image" with the conversation in its query string would carry
 *   that conversation out through the reader's own browser. An image becomes a
 *   link, which somebody has to choose to open.
 */
const COMPONENTS: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow">
      {children}
    </a>
  ),
  img: ({ src, alt }) =>
    typeof src === 'string' && src !== '' ? (
      <a href={src} target="_blank" rel="noopener noreferrer nofollow">
        {alt !== undefined && alt !== '' ? `Image: ${alt}` : 'Image'}
      </a>
    ) : null,
  // A wide table scrolls inside its own box instead of stretching the card.
  table: ({ children }) => (
    <div data-table-wrap="">
      <table>{children}</table>
    </div>
  ),
};

export function MarkdownContent({ text }: { text: string }): ReactElement {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS} skipHtml>
      {text}
    </ReactMarkdown>
  );
}
