import assert from "node:assert/strict";
import test from "node:test";
import {
  createClientChannel,
  createDaemonChannel,
  exportPublicKey,
  generateKeyPair,
  type Transport,
  type TransportMessage,
} from "../src/paseo-e2ee.js";

class LoopbackTransport implements Transport {
  peer: LoopbackTransport | null = null;
  onmessage: ((message: TransportMessage) => void) | null = null;
  onclose: ((code: number, reason: string) => void) | null = null;
  onerror: ((error: Error) => void) | null = null;

  send(data: string | ArrayBuffer): void {
    const message: TransportMessage = {
      data,
      isBinary: data instanceof ArrayBuffer,
    };
    queueMicrotask(() => this.peer?.onmessage?.(message));
  }

  close(code = 1000, reason = "closed"): void {
    queueMicrotask(() => this.peer?.onclose?.(code, reason));
  }
}

function linkedTransports(): [LoopbackTransport, LoopbackTransport] {
  const client = new LoopbackTransport();
  const host = new LoopbackTransport();
  client.peer = host;
  host.peer = client;
  return [client, host];
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("Paseo E2EE public API establishes a binary Node channel", async () => {
  const [clientTransport, hostTransport] = linkedTransports();
  const hostKeyPair = generateKeyPair();
  const clientReceived = deferred<ArrayBuffer>();
  const hostReceived = deferred<ArrayBuffer>();

  const hostPromise = createDaemonChannel(hostTransport, hostKeyPair, {
    onmessage(data) {
      assert.ok(data instanceof ArrayBuffer);
      hostReceived.resolve(data);
    },
  });
  const client = await createClientChannel(
    clientTransport,
    exportPublicKey(hostKeyPair.publicKey),
    {
      onmessage(data) {
        assert.ok(data instanceof ArrayBuffer);
        clientReceived.resolve(data);
      },
    },
  );
  const host = await hostPromise;

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.isOpen(), true);
  assert.equal(host.isOpen(), true);

  const toHost = new TextEncoder().encode("browser-to-host").buffer;
  await client.send(toHost);
  assert.deepEqual(
    new Uint8Array(await hostReceived.promise),
    new Uint8Array(toHost),
  );

  const toClient = new TextEncoder().encode("host-to-browser").buffer;
  await host.send(toClient);
  assert.deepEqual(
    new Uint8Array(await clientReceived.promise),
    new Uint8Array(toClient),
  );
});
