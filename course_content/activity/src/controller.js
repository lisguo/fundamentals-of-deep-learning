// SPDX-FileCopyrightText: 2026 NVIDIA CORPORATION & AFFILIATES
// SPDX-License-Identifier: Apache-2.0

export function validateConfig(config) {
  const url = new URL(config.baseUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('Use an HTTPS API base URL without credentials, query, or fragment.');
  }
  const artifact = config.artifact;
  if (!artifact || typeof artifact.artifact_id !== 'string' || !artifact.artifact_id ||
      typeof artifact.artifact_version !== 'string' || !artifact.artifact_version ||
      !/^sha256:[0-9a-f]{64}$/.test(artifact.artifact_digest || '')) {
    throw new Error('Supply the registered artifact ID, version, and SHA-256 digest.');
  }
  if (!Array.isArray(config.notebooks) || !config.notebooks.length ||
      config.notebooks.some(path => typeof path !== 'string' || !path.endsWith('.ipynb') ||
        path.startsWith('/') || path.split('/').includes('..'))) {
    throw new Error('Supply course notebook paths relative to the Jupyter root.');
  }
  return config;
}

export function isCourseNotebook(path, config) {
  return config.notebooks.includes(path);
}

export function createCourseTracker(config, initialize, onChange = () => {}) {
  validateConfig(config);
  let activity;
  let starting;
  let finishing;
  let status = 'idle';
  let state;
  const update = next => { status = next; onChange(next, state); };

  async function start() {
    if (starting) return starting;
    if (activity && status !== 'error') return;
    update('starting');
    starting = (async () => {
      try {
        activity ??= await initialize({ baseUrl: config.baseUrl, artifact: {
          artifact_id: config.artifact.artifact_id,
          artifact_version: config.artifact.artifact_version,
          artifact_digest: config.artifact.artifact_digest
        } });
        state = await activity.getState();
        update(state.completedAt ? 'completed' : 'started');
      } catch (error) {
        update('error');
        throw error;
      }
    })();
    try { await starting; } finally { starting = undefined; }
  }

  async function complete() {
    if (finishing) return finishing;
    if (status === 'completed') return;
    if (!activity || status === 'starting') throw new Error('Open a course notebook and start tracking first.');
    update('completing');
    finishing = (async () => {
      try {
        await activity.progress(100, { idempotencyKey: 'fdl:self-reported:progress:100' });
        await activity.complete({ idempotencyKey: 'fdl:self-reported:completed' });
        state = await activity.getState();
        if (!state.completedAt) throw new Error('The server has not confirmed completion.');
        update('completed');
      } catch (error) {
        update('error');
        throw error;
      }
    })();
    try { await finishing; } finally { finishing = undefined; }
  }

  return { start, complete, get status() { return status; }, get state() { return state; } };
}
