import assert from "node:assert/strict";
import test from "node:test";
import { RelayOutbound, RELAY_OUTBOUND_LIMITS } from "../src/relay-outbound.js";

function output() {
  const writes: Array<{ data: string; done: (error?: Error) => void }> = [];
  let buffered = 0;
  const errors: Error[] = [];
  const writer = new RelayOutbound(
    {
      get bufferedAmount() {
        return buffered;
      },
      send(data, done) {
        writes.push({ data, done });
      },
    },
    (error) => errors.push(error),
  );
  return {
    writer,
    writes,
    errors,
    pressure(value: number) {
      buffered = value;
    },
  };
}

test("producer accounting and cancellation preserve the shared in-flight write and fair healthy output", async () => {
  const { writer, writes, errors } = output();
  let shed = false;
  const first = writer.send("producer", "p".repeat(100 * 1024), () => {
    shed = true;
  });
  assert.equal(writes.length, 1);
  assert.equal(writer.ownerBytes("healthy"), 0);
  const second = writer.send("producer", "q".repeat(100 * 1024), () => {
    shed = true;
  });
  const third = writer.send("producer", "r".repeat(100 * 1024), () => {
    shed = true;
  });
  assert.equal(shed, true);
  await Promise.all([
    assert.rejects(first),
    assert.rejects(second),
    assert.rejects(third),
  ]);
  const healthy = writer.send("healthy", "healthy", () =>
    assert.fail("healthy producer shed"),
  );
  assert.equal(
    writes.length,
    1,
    "dropping the producer must retain its shared physical write until callback",
  );
  writes[0].done();
  assert.equal(writes.length, 2);
  assert.equal(writes[1].data, "healthy");
  writes[1].done();
  await healthy;
  assert.deepEqual(errors, []);
  writer.close();
});

test("global queue pressure sheds the largest queued producer and bounds urgent control bursts", async () => {
  const { writer, writes, errors } = output();
  const pending: Promise<void>[] = [];
  const shed: string[] = [];
  try {
    pending.push(writer.send("flight", "flight", () => {}));
    pending.push(
      writer.send("large", "l".repeat(240 * 1024), () => shed.push("large")),
    );
    pending.push(writer.send("healthy", "healthy", () => shed.push("healthy")));
    for (let index = 0; index < 20; index++)
      pending.push(
        writer.send(`other-${index}`, "x".repeat(200 * 1024), () =>
          shed.push(`other-${index}`),
        ),
      );
    assert.ok(shed.includes("large"));
    assert.ok(!shed.includes("healthy"));
    assert.equal(writes.length, 1);
    for (let index = 0; index < 12; index++)
      pending.push(writer.control(`control-${index}`));
    for (let index = 0; index <= RELAY_OUTBOUND_LIMITS.controlBurst; index++)
      writes[index].done();
    assert.equal(
      writes[RELAY_OUTBOUND_LIMITS.controlBurst + 1].data,
      "healthy",
    );
    assert.deepEqual(errors, []);
  } finally {
    writer.close();
    await Promise.allSettled(pending);
  }
});

test("high shared buffer waits without blaming healthy producers and callback epochs stay isolated", async () => {
  const first = output(),
    second = output();
  first.pressure(600 * 1024);
  const old = first.writer.send("old", "old", () => assert.fail());
  assert.equal(first.writes.length, 0);
  assert.equal(first.writer.ownerBytes("healthy"), 0);
  first.pressure(0);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(first.writes.length, 1);
  first.writer.close();
  await assert.rejects(old);
  const current = second.writer.send("new", "new", () => assert.fail());
  first.writes[0].done();
  assert.equal(second.writes.length, 1);
  assert.equal(second.writer.ownerBytes("new"), 3);
  second.writes[0].done();
  await current;
  second.writer.close();
  assert.deepEqual(first.errors, []);
});

test("excess management controls reject only new operations without resetting healthy rooms", async () => {
  const { writer, writes, errors } = output();
  const pending: Promise<void>[] = [];
  try {
    pending.push(writer.send("flight", "flight", () => {}));
    const controls = Array.from({ length: 100 }, (_, index) =>
      writer.control(`close-${index}`),
    );
    pending.push(...controls);
    const healthy = writer.send("healthy", "healthy", () =>
      assert.fail("healthy shed"),
    );
    pending.push(healthy);
    for (let index = 0; index <= RELAY_OUTBOUND_LIMITS.controlBurst; index++)
      writes[index].done();
    assert.equal(
      writes[RELAY_OUTBOUND_LIMITS.controlBurst + 1].data,
      "healthy",
    );
    let index = RELAY_OUTBOUND_LIMITS.controlBurst + 1;
    while (index < writes.length) writes[index++].done();
    await healthy;
    const statuses = await Promise.allSettled(controls);
    assert.equal(
      statuses.filter((value) => value.status === "fulfilled").length,
      64,
    );
    assert.equal(
      statuses.filter((value) => value.status === "rejected").length,
      36,
    );
    assert.deepEqual(errors, []);
  } finally {
    writer.close();
    await Promise.allSettled(pending);
  }
});

test("paused enqueue/drop churn removes round-robin metadata immediately and idle watchdog cannot close the host", async () => {
  const { writer, writes, errors, pressure } = output();
  pressure(600 * 1024);
  const pending: Promise<void>[] = [];
  const previous = RELAY_OUTBOUND_LIMITS.stallMs;
  RELAY_OUTBOUND_LIMITS.stallMs = 5;
  try {
    for (let index = 0; index < 2000; index++) {
      const key = `guest-${index}`;
      pending.push(writer.send(key, "small", () => {}));
      writer.dropOwner(key);
    }
    assert.equal(
      (writer as unknown as { ready: unknown[] }).ready.length,
      0,
      "cancelled owners must not accumulate behind shared pressure",
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(errors, []);
    RELAY_OUTBOUND_LIMITS.stallMs = previous;
    pressure(0);
    const healthy = writer.send("healthy", "healthy", () => assert.fail());
    writes[0].done();
    await healthy;
    assert.deepEqual(errors, []);
  } finally {
    RELAY_OUTBOUND_LIMITS.stallMs = previous;
    writer.close();
    await Promise.allSettled(pending);
  }
});

test("guest close and HTTP notice floods stay in the data lane and preserve pong and registration progress", async () => {
  const { writer, writes, errors, pressure } = output();
  const pending: Promise<void>[] = [];
  pressure(600 * 1024);
  try {
    for (let index = 0; index < 100; index++)
      pending.push(writer.send(`http:${index}`, `503-${index}`, () => {}));
    for (let index = 0; index < 100; index++)
      pending.push(writer.send(`close:${index}`, `close-${index}`, () => {}));
    pending.push(writer.send("healthy", "healthy", () => assert.fail()));
    pending.push(writer.control("pong", "pong"));
    pending.push(writer.control("registration"));
    pressure(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(writes[0].data, "pong");
    writes[0].done();
    assert.equal(writes[1].data, "registration");
    let index = 1;
    while (index < writes.length) writes[index++].done();
    await Promise.all(pending);
    assert.deepEqual(errors, []);
    assert.ok(writes.some((value) => value.data === "healthy"));
  } finally {
    writer.close();
    await Promise.allSettled(pending);
  }
});

test("closing a scheduler with pending work does not rearm progress timers", async () => {
  const { writer, writes, errors } = output();
  const pending = [
    writer.send("one", "one", () => {}),
    writer.send("two", "two", () => {}),
  ];
  writer.close();
  assert.equal((writer as unknown as { progress: unknown }).progress, null);
  await Promise.allSettled(pending);
  writes[0].done();
  assert.equal((writer as unknown as { progress: unknown }).progress, null);
  assert.deepEqual(errors, []);
});
