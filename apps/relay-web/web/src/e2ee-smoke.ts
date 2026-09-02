import { createClientChannel } from "./paseo-e2ee";

// This is a build-only entry point. Assigning the API makes Rollup retain the
// full browser dependency graph, proving the Vite export workaround works.
Object.assign(globalThis, { __paseoRoomsE2eeSmoke: createClientChannel });
