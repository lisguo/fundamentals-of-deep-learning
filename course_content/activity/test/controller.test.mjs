// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCourseTracker, isCourseNotebook, validateConfig } from '../src/controller.js';

const config = { baseUrl: 'https://activity.example.com', artifact: {
  artifact_id: 'artifact_test', artifact_version: 'test-v1', artifact_digest: `sha256:${'a'.repeat(64)}`
}, notebooks: ['tutorials/01_mnist.ipynb', 'tutorials/02_asl.ipynb'] };

function fixture() {
  const calls = [];
  let completed = false;
  const client = {
    async getState() { calls.push('state'); return { progressPercent: completed ? 100 : 0, completedAt: completed ? '2026-10-08T00:00:00Z' : null }; },
    async progress(n, opts) { calls.push(['progress', n, opts.idempotencyKey]); },
    async complete(opts) { calls.push(['complete', opts.idempotencyKey]); completed = true; return { written: true }; }
  };
  let starts = 0;
  const tracker = createCourseTracker(config, async () => { starts++; return client; });
  return { tracker, client, calls, starts: () => starts };
}

test('only explicitly configured notebook paths start the course', () => {
  assert.equal(isCourseNotebook('tutorials/01_mnist.ipynb', config), true);
  for (const path of ['other/01_mnist.ipynb', 'tutorials/notes.ipynb', null]) {
    assert.equal(isCourseNotebook(path, config), false);
  }
});

test('reject invalid config and token-bearing URLs', () => {
  assert.doesNotThrow(() => validateConfig(config));
  for (const change of [{ baseUrl: 'http://example.com' }, { baseUrl: 'https://example.com/?token=secret' }, { notebooks: [] }, { artifact: {} }]) {
    assert.throws(() => validateConfig({ ...config, ...change }));
  }
});

test('coalesces simultaneous starts and keeps one session across notebooks', async () => {
  const f = fixture();
  await Promise.all([f.tracker.start(), f.tracker.start()]);
  await f.tracker.start();
  assert.equal(f.starts(), 1);
});

test('completion requires a started course', async () => {
  const f = fixture();
  await assert.rejects(f.tracker.complete());
  assert.equal(f.starts(), 0);
});

test('completion sends 100 first, confirms state, and ignores duplicate clicks', async () => {
  const f = fixture();
  await f.tracker.start();
  await Promise.all([f.tracker.complete(), f.tracker.complete()]);
  await f.tracker.complete();
  assert.deepEqual(f.calls.filter(x => Array.isArray(x)), [
    ['progress', 100, 'fdl:self-reported:progress:100'],
    ['complete', 'fdl:self-reported:completed']
  ]);
  assert.equal(f.tracker.status, 'completed');
});

test('failed progress never sends completion; retry retains logical keys', async () => {
  const f = fixture();
  const progress = f.client.progress;
  let fail = true;
  f.client.progress = async (...args) => { if (fail) throw new Error('offline'); return progress(...args); };
  await f.tracker.start();
  await assert.rejects(f.tracker.complete());
  assert.equal(f.calls.some(x => Array.isArray(x) && x[0] === 'complete'), false);
  fail = false;
  await f.tracker.complete();
  assert.equal(f.tracker.status, 'completed');
});

test('completion is not claimed without server completedAt', async () => {
  const f = fixture();
  f.client.complete = async () => ({ written: false });
  await f.tracker.start();
  await assert.rejects(f.tracker.complete());
  assert.equal(f.tracker.status, 'error');
});

test('failed initialization can be retried', async () => {
  const f = fixture();
  let attempts = 0;
  const tracker = createCourseTracker(config, async () => { if (++attempts === 1) throw new Error('offline'); return f.client; });
  await assert.rejects(tracker.start());
  await tracker.start();
  assert.equal(attempts, 2);
  assert.equal(tracker.status, 'started');
});
