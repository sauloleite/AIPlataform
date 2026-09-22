'use client';

import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import type { ReactElement } from 'react';

import { MarkdownContent } from './markdown-content';

const useStyles = makeStyles({
  // `pre-wrap` on a parent would turn every newline between two blocks into a
  // blank line of its own; the blocks already space themselves.
  root: {
    whiteSpace: 'normal',
    overflowWrap: 'anywhere',
    '& > :first-child': { marginBlockStart: 0 },
    '& > :last-child': { marginBlockEnd: 0 },
    '& p': { marginBlock: tokens.spacingVerticalS },
    '& h1': { fontSize: tokens.fontSizeBase500, lineHeight: tokens.lineHeightBase500 },
    '& h2': { fontSize: tokens.fontSizeBase400, lineHeight: tokens.lineHeightBase400 },
    '& h3': { fontSize: tokens.fontSizeBase300, lineHeight: tokens.lineHeightBase300 },
    '& h4': { fontSize: tokens.fontSizeBase300, lineHeight: tokens.lineHeightBase300 },
    '& :is(h1, h2, h3, h4, h5, h6)': {
      fontWeight: tokens.fontWeightSemibold,
      marginBlockStart: tokens.spacingVerticalL,
      marginBlockEnd: tokens.spacingVerticalXS,
    },
    '& :is(ul, ol)': { marginBlock: tokens.spacingVerticalS, paddingInlineStart: '1.5em' },
    '& li': { marginBlock: tokens.spacingVerticalXXS },
    '& li > p': { marginBlock: 0 },
    '& code': {
      fontFamily: tokens.fontFamilyMonospace,
      fontSize: '0.9em',
      backgroundColor: tokens.colorNeutralBackground3,
      borderRadius: tokens.borderRadiusSmall,
      padding: '0.1em 0.3em',
    },
    '& pre': {
      backgroundColor: tokens.colorNeutralBackground3,
      borderRadius: tokens.borderRadiusMedium,
      padding: tokens.spacingVerticalS,
      overflowX: 'auto',
    },
    '& pre code': { backgroundColor: 'transparent', padding: 0 },
    '& blockquote': {
      marginInline: 0,
      paddingInlineStart: tokens.spacingHorizontalM,
      borderInlineStartWidth: '3px',
      borderInlineStartStyle: 'solid',
      borderInlineStartColor: tokens.colorNeutralStroke2,
      color: tokens.colorNeutralForeground2,
    },
    '& hr': {
      border: 'none',
      borderBlockStartWidth: '1px',
      borderBlockStartStyle: 'solid',
      borderBlockStartColor: tokens.colorNeutralStroke2,
      marginBlock: tokens.spacingVerticalM,
    },
    '& a': { color: tokens.colorBrandForegroundLink },
    '& [data-table-wrap]': { overflowX: 'auto', marginBlock: tokens.spacingVerticalS },
    '& table': { borderCollapse: 'collapse' },
    '& :is(th, td)': {
      border: `1px solid ${tokens.colorNeutralStroke2}`,
      padding: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalS}`,
      textAlign: 'start',
    },
  },
});

/** A model's answer, in the console's type scale. The rules are in `MarkdownContent`. */
export function Markdown({ text, className }: { text: string; className?: string }): ReactElement {
  const styles = useStyles();

  return (
    <div className={mergeClasses(styles.root, className)}>
      <MarkdownContent text={text} />
    </div>
  );
}
