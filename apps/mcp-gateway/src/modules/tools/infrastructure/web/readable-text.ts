/**
 * HTML reduced to the text a model reads.
 *
 * Regular expressions over HTML, knowingly. A model needs the prose of a page,
 * not its tree, and a full parser plus a readability library is a dependency
 * tree in the one service that talks to arbitrary third parties. What is lost
 * -- a table's layout, a malformed page's odd corner -- costs a little
 * accuracy; what is kept is small enough to review line by line.
 */

/** Elements whose content is never prose: code, styling, and page chrome. */
const DROPPED = [
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'iframe',
  'object',
  'head',
  'nav',
  'footer',
  'aside',
  'form',
];

/** Elements that end a line of text where they close. */
const BLOCKS =
  /<\/?(?:p|div|br|hr|h[1-6]|ul|ol|li|dl|dt|dd|tr|table|section|article|main|header|blockquote|pre|figure|figcaption)\b[^>]*>/gi;

/**
 * ISO 8859-1's entities, U+00A0 to U+00FF in order. The whole block rather than
 * a hand-picked few: `&atilde;` and `&ccedil;` are how an older Portuguese page
 * writes half its words, and a missing one leaves the model reading markup.
 */
const LATIN_1 = (
  'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn ' +
  'sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave ' +
  'Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ' +
  'ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN ' +
  'szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute ' +
  'icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml ' +
  'yacute thorn yuml'
)
  .split(' ')
  .map((name, index): [string, string] => [name, String.fromCodePoint(0xa0 + index)]);

/** Case-sensitive, as HTML's are: `&Agrave;` and `&agrave;` are different letters. */
const NAMED_ENTITIES: ReadonlyMap<string, string> = new Map([
  ...LATIN_1,
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
  ['ndash', '–'],
  ['mdash', '—'],
  ['hellip', '…'],
  ['lsquo', '‘'],
  ['rsquo', '’'],
  ['ldquo', '“'],
  ['rdquo', '”'],
  ['trade', '™'],
  ['euro', '€'],
  ['bull', '•'],
]);

export function readableText(html: string): { title?: string; text: string } {
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch === null ? '' : collapse(decodeEntities(stripTags(titleMatch[1] ?? '')));

  let body = html.replace(/<!--[\s\S]*?-->/g, ' ');
  for (const element of DROPPED) {
    body = body.replace(new RegExp(`<${element}\\b[\\s\\S]*?<\\/${element}\\s*>`, 'gi'), ' ');
  }

  body = body.replace(/<li\b[^>]*>/gi, '\n- ').replace(BLOCKS, '\n');

  const text = decodeEntities(stripTags(body))
    .split('\n')
    .map(collapse)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { ...(title !== '' && { title }), text };
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, ' ');
}

function collapse(line: string): string {
  return line.replace(/[ \t\f\v\u00a0]+/g, ' ').trim();
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, entity: string) => {
    if (entity.startsWith('#')) {
      const code =
        entity[1] === 'x' || entity[1] === 'X'
          ? parseInt(entity.slice(2), 16)
          : parseInt(entity.slice(1), 10);
      // A code point out of range, or a surrogate, is not a character.
      return Number.isInteger(code) &&
        code > 0 &&
        code <= 0x10ffff &&
        (code < 0xd800 || code > 0xdfff)
        ? String.fromCodePoint(code)
        : match;
    }
    return NAMED_ENTITIES.get(entity) ?? match;
  });
}
