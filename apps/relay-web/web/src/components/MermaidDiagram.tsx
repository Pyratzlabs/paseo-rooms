import { useEffect, useId, useState } from "react";

export function MermaidDiagram({ source }: { source: string }) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [result, setResult] = useState<{
    source: string;
    svg: string | null;
  } | null>(null);
  const [dark, setDark] = useState(
    () =>
      typeof matchMedia === "function" &&
      matchMedia("(prefers-color-scheme: dark)").matches,
  );
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const update = () => setDark(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    let canceled = false;
    setResult(null);
    void import("../mermaid")
      .then(({ renderMermaid }) =>
        renderMermaid(`room-diagram-${id}`, source, dark),
      )
      .then(
        (svg) => {
          if (!canceled) setResult({ source, svg });
        },
        () => {
          if (!canceled) setResult({ source, svg: null });
        },
      );
    return () => {
      canceled = true;
    };
  }, [id, source, dark]);
  const current = result?.source === source ? result : null;
  return (
    <section className="mermaid-diagram" aria-label="Mermaid diagram">
      {current?.svg ? (
        <>
          <div
            className="mermaid-svg"
            dangerouslySetInnerHTML={{ __html: current.svg }}
          />
          <details>
            <summary>Diagram source</summary>
            <pre>
              <code>{source}</code>
            </pre>
          </details>
        </>
      ) : (
        <>
          <p role="status">
            {current
              ? "Could not render diagram. Source shown below."
              : "Rendering diagram…"}
          </p>
          <pre>
            <code className="language-mermaid">{source}</code>
          </pre>
        </>
      )}
    </section>
  );
}
