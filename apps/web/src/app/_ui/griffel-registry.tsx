'use client';

import {
  createDOMRenderer,
  RendererProvider,
  renderToStyleElements,
} from '@fluentui/react-components';
import { useServerInsertedHTML } from 'next/navigation';
import { useRef, useState, type ReactElement, type ReactNode } from 'react';

/**
 * Collects Griffel's styles during the server render and flushes them into the
 * streamed document, so the first paint is already styled.
 *
 * `renderToStyleElements` returns everything the renderer has collected so far,
 * not a delta since the last call. A second flush would therefore repeat every
 * rule, so this emits once. That is correct only while the console renders in a
 * single pass -- it has no `loading.tsx` and no Suspense boundary. Introducing
 * either means replacing this guard with a per-bucket delta, not deleting it.
 */
export function GriffelRegistry({ children }: { children: ReactNode }): ReactElement {
  const [renderer] = useState(createDOMRenderer);
  const flushed = useRef(false);

  useServerInsertedHTML(() => {
    if (flushed.current) return null;
    flushed.current = true;
    return <>{renderToStyleElements(renderer)}</>;
  });

  return <RendererProvider renderer={renderer}>{children}</RendererProvider>;
}
