import { Fragment, memo, useMemo } from 'react';
import type { ReactNode } from 'react';
import { parseMarkdown } from './parse';
import type { Block, Inline } from './parse';

/**
 * An answer, rendered as the document it is written as.
 *
 * Every node is a React element built from the parsed tree. There is no raw-HTML
 * escape hatch in this file, so markup inside an answer stays inert text, and
 * link targets are screened by `safeHref` in the parser.
 */

function renderInline(nodes: readonly Inline[], keyPrefix: string): ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${keyPrefix}.${index}`;
    switch (node.kind) {
      case 'text':
        return <Fragment key={key}>{node.text}</Fragment>;
      case 'break':
        return <br key={key} />;
      case 'code':
        return (
          <code key={key} className="v-md__code-inline">
            {node.text}
          </code>
        );
      case 'strong':
        return <strong key={key}>{renderInline(node.children, key)}</strong>;
      case 'em':
        return <em key={key}>{renderInline(node.children, key)}</em>;
      case 'del':
        return <del key={key}>{renderInline(node.children, key)}</del>;
      case 'link':
        return (
          <a key={key} href={node.href} target="_blank" rel="noopener noreferrer nofollow">
            {renderInline(node.children, key)}
          </a>
        );
    }
  });
}

function renderBlock(block: Block, key: string): ReactNode {
  switch (block.kind) {
    case 'paragraph':
      return <p key={key}>{renderInline(block.children, key)}</p>;
    case 'heading': {
      const Tag = `h${block.level}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
      return <Tag key={key}>{renderInline(block.children, key)}</Tag>;
    }
    case 'rule':
      return <hr key={key} />;
    case 'quote':
      return <blockquote key={key}>{renderBlocks(block.children, key)}</blockquote>;
    case 'code':
      return (
        <div key={key} className="v-md__code" data-open={block.open ? 'true' : undefined}>
          {block.language !== '' ? (
            <div className="v-md__code-label" aria-hidden="true">
              {block.language}
            </div>
          ) : null}
          {/* tabIndex lets a keyboard user scroll a long line sideways. */}
          <pre tabIndex={0}>
            <code>{block.text}</code>
          </pre>
        </div>
      );
    case 'list': {
      const items = block.items.map((item, index) => (
        <li key={`${key}.${index}`} className={item.checked === null ? undefined : 'v-md__task'}>
          {item.checked === null ? null : (
            <input
              type="checkbox"
              checked={item.checked}
              readOnly
              disabled
              aria-label={item.checked ? 'Done' : 'Not done'}
            />
          )}
          {renderBlocks(item.children, `${key}.${index}`, true)}
        </li>
      ));
      return block.ordered ? (
        <ol key={key} start={block.start !== 1 ? block.start : undefined}>
          {items}
        </ol>
      ) : (
        <ul key={key}>{items}</ul>
      );
    }
    case 'table':
      return (
        // The wrapper scrolls, not the page: a wide table stays usable at 360dp.
        <div key={key} className="v-md__table" tabIndex={0} role="region" aria-label="Table">
          <table>
            <thead>
              <tr>
                {block.head.map((cell, column) => (
                  <th
                    key={column}
                    style={
                      block.align[column] ? { textAlign: block.align[column] as 'left' } : undefined
                    }
                  >
                    {renderInline(cell, `${key}.h${column}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, column) => (
                    <td
                      key={column}
                      style={
                        block.align[column]
                          ? { textAlign: block.align[column] as 'left' }
                          : undefined
                      }
                    >
                      {renderInline(cell, `${key}.r${rowIndex}c${column}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

function renderBlocks(blocks: readonly Block[], keyPrefix: string, tight = false): ReactNode[] {
  // A list item with a single paragraph shows its text directly, so the bullet
  // and the words share a line instead of the paragraph dropping below it.
  if (tight && blocks.length >= 1 && blocks[0]?.kind === 'paragraph') {
    const [first, ...rest] = blocks;
    return [
      <span key={`${keyPrefix}.lead`} className="v-md__lead">
        {renderInline(
          (first as Extract<Block, { kind: 'paragraph' }>).children,
          `${keyPrefix}.lead`,
        )}
      </span>,
      ...rest.map((block, index) => renderBlock(block, `${keyPrefix}.${index + 1}`)),
    ];
  }
  return blocks.map((block, index) => renderBlock(block, `${keyPrefix}.${index}`));
}

export interface MarkdownProps {
  readonly text: string;
  /** Extra class for the wrapper. */
  readonly className?: string;
}

/**
 * Renders answer text. Memoised on the string, so a streamed answer re-parses
 * only when its text actually changed.
 */
export const Markdown = memo(function Markdown({ text, className }: MarkdownProps) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <div className={className === undefined ? 'v-md' : `v-md ${className}`}>
      {blocks.map((block, index) => renderBlock(block, `b${index}`))}
    </div>
  );
});
