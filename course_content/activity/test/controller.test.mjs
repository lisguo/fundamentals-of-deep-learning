// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createCourseTracker,
  isCourseNotebook,
  validateConfig,
} from "../src/controller.js";
const config = {
  baseUrl: "https://activity.example.com",
  artifact: {
    artifact_id: "artifact_test",
    artifact_version: "test-v1",
    artifact_digest: `sha256:${"a".repeat(64)}`,
  },
  markers: Array.from({ length: 9 }, (_, i) => ({
    notebook: `tutorials/${i}.ipynb`,
    tag: `dli:complete:${i}`,
  })),
};
const event = (i) => ({
  path: config.markers[i].notebook,
  cellType: "code",
  tags: [config.markers[i].tag],
  success: true,
  executionCount: 1,
});
function fixture() {
  const calls = [];
  let progress = 0,
    completed = false,
    starts = 0;
  const client = {
    async getState() {
      return {
        progressPercent: progress,
        completedAt: completed ? "2026-10-08T00:00:00Z" : null,
      };
    },
    async progress(n, opts) {
      calls.push(["progress", n, opts.idempotencyKey]);
      progress = n;
    },
    async complete(opts) {
      calls.push(["complete", opts.idempotencyKey]);
      completed = true;
    },
  };
  const tracker = createCourseTracker(config, async () => {
    starts++;
    return client;
  });
  return { tracker, client, calls, starts: () => starts };
}
test("only configured notebooks can start tracking", () => {
  assert.equal(isCourseNotebook("tutorials/0.ipynb", config), true);
  assert.equal(isCourseNotebook("other/0.ipynb", config), false);
  assert.equal(isCourseNotebook(undefined, config), false);
});
test("reject ambiguous markers and credential-bearing configuration", () => {
  assert.doesNotThrow(() => validateConfig(config));
  for (const change of [
    { baseUrl: "https://example.com/?token=secret" },
    { markers: [] },
    { markers: [config.markers[0], config.markers[0]] },
    { artifact: {} },
  ])
    assert.throws(() => validateConfig({ ...config, ...change }));
});
test("one session for simultaneous starts and markers", async () => {
  const f = fixture();
  await Promise.all([
    f.tracker.start(),
    f.tracker.start(),
    f.tracker.recordExecution(event(0)),
  ]);
  assert.equal(f.starts(), 1);
  assert.equal(f.tracker.executedCount, 1);
});
test("failed, unmarked, raw, markdown, and wrong-notebook executions do not count", async () => {
  const f = fixture();
  for (const change of [
    { success: false },
    { success: undefined },
    { executionCount: null },
    { executionCount: undefined },
    { tags: [] },
    { tags: null },
    { cellType: "markdown" },
    { cellType: "raw" },
    { path: "other/0.ipynb" },
  ])
    await f.tracker.recordExecution({ ...event(0), ...change });
  assert.equal(f.tracker.executedCount, 0);
  assert.equal(f.starts(), 0);
  assert.deepEqual(f.calls, []);
});
test("a marker counts once even after rerun or kernel restart", async () => {
  const f = fixture();
  await f.tracker.recordExecution(event(0));
  await f.tracker.recordExecution(event(0));
  assert.equal(f.tracker.executedCount, 1);
  assert.deepEqual(f.calls, [["progress", 11, "fdl:markers:progress:11"]]);
});
test("final marker alone cannot complete; all nine required even out of order", async () => {
  const f = fixture();
  await f.tracker.recordExecution(event(8));
  assert.equal(f.tracker.progressPercent, 11);
  assert.equal(
    f.calls.some((x) => x[0] === "complete"),
    false,
  );
  for (let i = 0; i < 8; i++) await f.tracker.recordExecution(event(i));
  assert.equal(f.tracker.executedCount, 9);
  assert.deepEqual(
    f.calls.map((x) => x.slice(0, 2)),
    [
      ["progress", 11],
      ["progress", 22],
      ["progress", 33],
      ["progress", 44],
      ["progress", 55],
      ["progress", 66],
      ["progress", 77],
      ["progress", 88],
      ["progress", 100],
      ["complete", "fdl:markers:completed"],
    ],
  );
  assert.equal(f.tracker.status, "completed");
});
test("concurrent executions never send decreasing progress or duplicate completion", async () => {
  const f = fixture();
  await Promise.all(
    Array.from({ length: 9 }, (_, i) => f.tracker.recordExecution(event(i))),
  );
  assert.equal(f.starts(), 1);
  assert.equal(f.tracker.status, "completed");
  const values = f.calls.filter((x) => x[0] === "progress").map((x) => x[1]);
  assert.deepEqual(
    values,
    [...new Set(values)].sort((a, b) => a - b),
  );
  assert.equal(f.calls.filter((x) => x[0] === "complete").length, 1);
});
test("buffer evidence on API failure, retry logical write with same key", async () => {
  const f = fixture();
  const original = f.client.progress;
  const attempts = [];
  let fail = true;
  f.client.progress = async (n, opts) => {
    attempts.push(opts.idempotencyKey);
    if (fail) throw Error("offline");
    return original(n, opts);
  };
  await assert.rejects(f.tracker.recordExecution(event(0)));
  assert.equal(f.tracker.executedCount, 1);
  assert.equal(f.tracker.status, "error");
  fail = false;
  await f.tracker.retry();
  assert.deepEqual(attempts, [
    "fdl:markers:progress:11",
    "fdl:markers:progress:11",
  ]);
  assert.equal(f.tracker.status, "started");
});
test("a later marker retries pending evidence after initialization failure", async () => {
  const f = fixture();
  let starts = 0;
  const tracker = createCourseTracker(config, async () => {
    if (++starts === 1) throw Error("offline");
    return f.client;
  });
  await assert.rejects(tracker.recordExecution(event(0)));
  await tracker.recordExecution(event(1));
  assert.equal(tracker.executedCount, 2);
  assert.equal(tracker.progressPercent, 22);
  assert.deepEqual(f.calls, [["progress", 22, "fdl:markers:progress:22"]]);
});
test("completion is only confirmed from server state, with retry for async writes", async () => {
  const f = fixture();
  const original = f.client.complete;
  f.client.complete = async () => ({ written: false });
  for (let i = 0; i < 8; i++) await f.tracker.recordExecution(event(i));
  await assert.rejects(f.tracker.recordExecution(event(8)));
  assert.equal(f.tracker.status, "error");
  f.client.complete = original;
  await f.tracker.retry();
  assert.equal(f.tracker.status, "completed");
  assert.ok(
    f.calls
      .filter((x) => x[0] === "progress" && x[1] === 100)
      .every((x) => x[2] === "fdl:markers:progress:100"),
  );
});

test("completion retry restores 100 when SDK replaces an expired session", async () => {
  const f = fixture();
  const progress = f.client.progress;
  const complete = f.client.complete;
  let replacement = false,
    restored = false;
  f.client.complete = async (opts) => {
    if (!replacement) {
      replacement = true;
      return { written: false };
    }
    if (restored) return complete(opts);
    return { written: false };
  };
  const getState = f.client.getState;
  f.client.getState = async () =>
    replacement && !restored
      ? { progressPercent: 0, completedAt: null }
      : getState();
  f.client.progress = async (n, opts) => {
    if (replacement) restored = true;
    return progress(n, opts);
  };
  for (let i = 0; i < 8; i++) await f.tracker.recordExecution(event(i));
  await assert.rejects(f.tracker.recordExecution(event(8)));
  await f.tracker.retry();
  assert.equal(f.tracker.status, "completed");
  assert.deepEqual(
    f.calls.filter((x) => x[0] === "progress" && x[1] === 100).map((x) => x[2]),
    ["fdl:markers:progress:100", "fdl:markers:progress:100"],
  );
});
