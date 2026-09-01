/**
 * Browser-facing side of the Paseo encrypted-channel compatibility seam.
 * Vite resolves this public specifier to Paseo's published dist artifact in
 * vite.config.ts because the package's browser export currently names an
 * unshipped source file.
 */
export { createClientChannel } from "@getpaseo/relay/e2ee";
