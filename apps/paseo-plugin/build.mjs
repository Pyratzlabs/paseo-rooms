import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));

// Paseo 0.8 accepts local modules only under client/, server/, or shared/.
// Bundle the workspace sources (including the matching room server) into those
// runtime directories before Paseo compiles the root entries. Keep host-provided
// modules external so hooks, RPCs, and schemas use Paseo's own runtime instances.
export async function buildPlugin(outdir = root) {
  for (const runtime of ["client", "server"]) {
    await build({
      absWorkingDir: root,
      entryPoints: [
        `apps/paseo-plugin/index.${runtime}.${runtime === "client" ? "tsx" : "ts"}`,
      ],
      outfile: `${outdir}/${runtime}/plugin.js`,
      bundle: true,
      format: "esm",
      platform: runtime === "client" ? "neutral" : "node",
      target: runtime === "client" ? "es2020" : "node20",
      jsx: "automatic",
      external: [
        "@getpaseo/plugin",
        "@getpaseo/plugin/*",
        "zod",
        ...(runtime === "client"
          ? ["react", "react/*", "react-native", "@tanstack/react-query"]
          : []),
      ],
    });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await buildPlugin();
}
