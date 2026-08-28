import type { ReactNode } from "react";

function Inline({ text }: { text: string }): ReactNode {
  return text
    .split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^\s)]+\))/g)
    .map((bit, index) => {
      if (/^`[^`]+`$/.test(bit))
        return <code key={index}>{bit.slice(1, -1)}</code>;
      if (/^\*\*[^*]+\*\*$/.test(bit))
        return <strong key={index}>{bit.slice(2, -2)}</strong>;
      const link = bit.match(/^\[([^\]]+)\]\(([^\s)]+)\)$/);
      if (link) {
        try {
          const url = new URL(link[2], location.href);
          if (["https:", "http:", "mailto:"].includes(url.protocol)) {
            return (
              <a
                key={index}
                href={url.href}
                target="_blank"
                rel="noopener noreferrer"
              >
                {link[1]}
              </a>
            );
          }
        } catch {
          /* plain text fallback */
        }
      }
      return bit;
    });
}

/** Deliberately small, text-only Markdown subset. No raw HTML reaches the DOM. */
export function Markdown({ text }: { text: string }) {
  const lines = text.split("\n");
  const nodes: ReactNode[] = [];
  let index = 0;
  for (let line = 0; line < lines.length;) {
    const fence = lines[line].match(/^\s*```([^\s`]*)?\s*$/);
    if (fence) {
      const language = fence[1] || undefined;
      const code: string[] = [];
      line++;
      while (line < lines.length && !/^\s*```\s*$/.test(lines[line]))
        code.push(lines[line++].replace(/^ {0,3}/, ""));
      if (line < lines.length) line++;
      nodes.push(
        <pre key={index++}>
          <code className={language ? `language-${language}` : undefined}>
            {code.join("\n")}
          </code>
        </pre>,
      );
      continue;
    }
    const heading = lines[line].match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      const Tag = heading[1].length === 1 ? "h2" : "h3";
      nodes.push(
        <Tag key={index++}>
          <Inline text={heading[2]} />
        </Tag>,
      );
      line++;
      continue;
    }
    const bullet = lines[line].match(/^\s*([-*]|\d+\.)\s+(.+)$/);
    if (bullet) {
      const ordered = /\d+\./.test(bullet[1]);
      const values: string[] = [];
      while (line < lines.length) {
        const next = lines[line].match(/^\s*([-*]|\d+\.)\s+(.+)$/);
        if (!next || /\d+\./.test(next[1]) !== ordered) break;
        values.push(next[2]);
        line++;
      }
      const List = ordered ? "ol" : "ul";
      nodes.push(
        <List
          key={index++}
          {...(ordered ? { start: Number.parseInt(bullet[1], 10) } : {})}
        >
          {values.map((value, item) => (
            <li key={item}>
              <Inline text={value} />
            </li>
          ))}
        </List>,
      );
      continue;
    }
    const paragraph: string[] = [];
    while (
      line < lines.length &&
      lines[line] &&
      !/^(#{1,3})\s+/.test(lines[line]) &&
      !/^\s*```/.test(lines[line]) &&
      !/^\s*([-*]|\d+\.)\s+/.test(lines[line])
    )
      paragraph.push(lines[line++]);
    if (paragraph.length)
      nodes.push(
        <p key={index++}>
          <Inline text={paragraph.join("\n")} />
        </p>,
      );
    else line++;
  }
  return <div className="markdown">{nodes}</div>;
}
