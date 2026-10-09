import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { MermaidDiagram } from "./MermaidDiagram";

/** Ignore raw HTML; Mermaid SVG goes through a separate strict renderer. */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
          table: ({ children }) => (
            <div
              className="markdown-table"
              role="region"
              aria-label="Markdown table"
              tabIndex={0}
            >
              <table>{children}</table>
            </div>
          ),
          pre: ({ children, node }) => {
            const code = node?.children[0];
            const language =
              code?.type === "element" ? code.properties.className : undefined;
            if (
              Array.isArray(language) &&
              language.includes("language-mermaid")
            ) {
              const raw = text.slice(
                node?.position?.start.offset,
                node?.position?.end.offset,
              );
              const lines = raw.trimEnd().split("\n");
              const opening = lines[0].match(/^ {0,3}(`{3,}|~{3,})/);
              const closing = lines.at(-1)?.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
              // An incomplete streamed fence is readable code until its closing
              // delimiter arrives; do not run the parser on every token.
              if (
                opening &&
                closing &&
                lines.length > 1 &&
                opening[1][0] === closing[1][0] &&
                closing[1].length >= opening[1].length &&
                code?.type === "element"
              ) {
                const source = code.children
                  .map((child) => (child.type === "text" ? child.value : ""))
                  .join("")
                  .replace(/\n$/, "");
                return <MermaidDiagram source={source} />;
              }
            }
            return <pre>{children}</pre>;
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
