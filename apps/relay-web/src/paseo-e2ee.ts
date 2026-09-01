/**
 * The single Node-facing compatibility seam for Paseo's published E2EE
 * channel. Keep product code importing this module rather than package
 * internals: the browser counterpart is aliased by Vite in web/vite.config.ts.
 */
export {
  createClientChannel,
  createDaemonChannel,
  exportPublicKey,
  generateKeyPair,
} from "@getpaseo/relay/e2ee";

export type {
  EncryptedChannel,
  EncryptedChannelEvents,
  KeyPair,
  Transport,
  TransportMessage,
} from "@getpaseo/relay/e2ee";
