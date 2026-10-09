import mermaid from "mermaid";
import DOMPurify from "dompurify";

// Mermaid configuration is global. Serialize initialization and rendering so
// concurrent diagrams (including theme changes) cannot affect each other.
let pending: Promise<unknown> = Promise.resolve();

export function renderMermaid(
  id: string,
  source: string,
  dark: boolean,
): Promise<string> {
  const render = pending.then(async () => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      theme: dark ? "dark" : "default",
      htmlLabels: false,
      maxTextSize: 50_000,
      maxEdges: 500,
      secure: [
        "secure",
        "securityLevel",
        "startOnLoad",
        "maxTextSize",
        "maxEdges",
        "suppressErrorRendering",
        "htmlLabels",
        "themeCSS",
        "dompurifyConfig",
      ],
    });
    const container = document.createElement("div");
    container.setAttribute("aria-hidden", "true");
    container.style.cssText =
      "position:absolute;left:-100000px;top:0;width:1000px;pointer-events:none";
    document.body.append(container);
    try {
      const { svg } = await mermaid.render(id, source, container);
      return DOMPurify.sanitize(svg, {
        USE_PROFILES: { svg: true, svgFilters: true },
        FORBID_TAGS: ["foreignObject", "image", "a"],
      });
    } finally {
      container.remove();
    }
  });
  pending = render.catch(() => undefined);
  return render;
}
