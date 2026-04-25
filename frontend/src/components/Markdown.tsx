import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Renders markdown using the editorial palette: serif body for prose, mono
 * for code, terracotta for accents/links. Used wherever an LLM-produced text
 * value lands in the UI (mostly inside JsonView for run inputs/outputs).
 */
export function Markdown({ children }: { children: string }) {
  return (
    <div
      style={{
        fontFamily: 'var(--serif)',
        fontSize: 13,
        lineHeight: 1.55,
        color: 'var(--ink-2)',
      }}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p style={{ margin: '0 0 8px' }}>{children}</p>,
          h1: ({ children }) => (
            <h1
              className="serif"
              style={{ fontSize: 18, fontWeight: 500, margin: '6px 0 6px', color: 'var(--ink)' }}
            >
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2
              className="serif"
              style={{ fontSize: 16, fontWeight: 500, margin: '6px 0 6px', color: 'var(--ink)' }}
            >
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3
              className="serif"
              style={{ fontSize: 14, fontWeight: 500, margin: '4px 0 4px', color: 'var(--ink)' }}
            >
              {children}
            </h3>
          ),
          h4: ({ children }) => (
            <h4
              className="smallcaps"
              style={{ margin: '4px 0 4px', color: 'var(--ink-2)' }}
            >
              {children}
            </h4>
          ),
          em: ({ children }) => (
            <em style={{ fontStyle: 'italic', color: 'var(--ink)' }}>{children}</em>
          ),
          strong: ({ children }) => (
            <strong style={{ color: 'var(--ink)', fontWeight: 600 }}>{children}</strong>
          ),
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: 'var(--accent-ink)', textDecoration: 'underline' }}
            >
              {children}
            </a>
          ),
          ul: ({ children }) => (
            <ul style={{ paddingLeft: 18, margin: '0 0 8px' }}>{children}</ul>
          ),
          ol: ({ children }) => (
            <ol style={{ paddingLeft: 18, margin: '0 0 8px' }}>{children}</ol>
          ),
          li: ({ children }) => <li style={{ marginBottom: 2 }}>{children}</li>,
          blockquote: ({ children }) => (
            <blockquote
              style={{
                borderLeft: '2px solid var(--rule)',
                paddingLeft: 10,
                color: 'var(--ink-3)',
                margin: '0 0 8px',
                fontStyle: 'italic',
              }}
            >
              {children}
            </blockquote>
          ),
          hr: () => (
            <hr
              style={{ border: 0, borderTop: '1px solid var(--rule)', margin: '12px 0' }}
            />
          ),
          code: ({ inline, children, className }: any) => {
            if (inline) {
              return (
                <code
                  className="mono"
                  style={{
                    background: 'var(--paper-2)',
                    padding: '0 4px',
                    borderRadius: 2,
                    fontSize: '0.92em',
                    color: 'var(--ink)',
                  }}
                >
                  {children}
                </code>
              );
            }
            return (
              <code className={`mono ${className ?? ''}`} style={{ fontSize: 11.5 }}>
                {children}
              </code>
            );
          },
          pre: ({ children }) => (
            <pre
              className="scroll"
              style={{
                background: 'var(--paper-2)',
                border: '1px solid var(--rule-2)',
                borderRadius: 3,
                padding: 10,
                overflow: 'auto',
                margin: '0 0 8px',
                fontSize: 11.5,
                lineHeight: 1.55,
                color: 'var(--ink-2)',
                whiteSpace: 'pre',
              }}
            >
              {children}
            </pre>
          ),
          table: ({ children }) => (
            <div style={{ overflowX: 'auto', margin: '0 0 8px' }}>
              <table
                style={{
                  borderCollapse: 'collapse',
                  fontSize: 12,
                  fontFamily: 'var(--sans)',
                }}
              >
                {children}
              </table>
            </div>
          ),
          th: ({ children }) => (
            <th
              className="smallcaps"
              style={{
                textAlign: 'left',
                padding: '4px 8px',
                borderBottom: '1px solid var(--rule)',
              }}
            >
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td
              style={{
                padding: '4px 8px',
                borderBottom: '1px solid var(--rule-2)',
                color: 'var(--ink-2)',
              }}
            >
              {children}
            </td>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
