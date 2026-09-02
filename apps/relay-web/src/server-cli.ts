import { startLocalRoomServer } from "./server.js";

startLocalRoomServer().catch((error) => {
  console.error("paseo-rooms failed to start:", error);
  process.exitCode = 1;
});
