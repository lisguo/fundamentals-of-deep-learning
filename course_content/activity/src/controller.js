// SPDX-FileCopyrightText: 2026 NVIDIA CORPORATION & AFFILIATES
// SPDX-License-Identifier: Apache-2.0

export function validateConfig(config) {
  const url = new URL(config.baseUrl);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "Use an HTTPS API base URL without credentials, query, or fragment.",
    );
  }
  const artifact = config.artifact;
  if (
    !artifact ||
    typeof artifact.artifact_id !== "string" ||
    !artifact.artifact_id ||
    typeof artifact.artifact_version !== "string" ||
    !artifact.artifact_version ||
    !/^sha256:[0-9a-f]{64}$/.test(artifact.artifact_digest || "")
  ) {
    throw new Error(
      "Supply the registered artifact ID, version, and SHA-256 digest.",
    );
  }
  if (
    !Array.isArray(config.markers) ||
    !config.markers.length ||
    config.markers.some(
      (marker) =>
        !marker ||
        typeof marker.notebook !== "string" ||
        !marker.notebook.endsWith(".ipynb") ||
        marker.notebook.startsWith("/") ||
        marker.notebook.split("/").includes("..") ||
        typeof marker.tag !== "string" ||
        !/^dli:complete:[a-z0-9_-]+$/.test(marker.tag),
    ) ||
    new Set(config.markers.map((marker) => marker.notebook)).size !==
      config.markers.length ||
    new Set(config.markers.map((marker) => marker.tag)).size !==
      config.markers.length
  ) {
    throw new Error(
      "Supply one uniquely tagged completion marker per course notebook.",
    );
  }
  return config;
}

export function isCourseNotebook(path, config) {
  return config.markers.some((marker) => marker.notebook === path);
}

export function createCourseTracker(config, initialize, onChange = () => {}) {
  validateConfig(config);
  const executed = new Set();
  let activity;
  let initialized = false;
  let queue = Promise.resolve();
  let status = "idle";
  let state;
  let acknowledgedPercent = 0;
  const percent = () =>
    Math.floor((100 * executed.size) / config.markers.length);
  const update = (next) => {
    status = next;
    onChange(next, state);
  };

  async function connect() {
    if (initialized) return;
    update("starting");
    activity ??= await initialize({
      baseUrl: config.baseUrl,
      artifact: {
        artifact_id: config.artifact.artifact_id,
        artifact_version: config.artifact.artifact_version,
        artifact_digest: config.artifact.artifact_digest,
      },
    });
    state = await activity.getState();
    initialized = true;
  }

  // Serialize writes; later markers can retry evidence retained after an outage.
  function enqueue(task) {
    queue = queue.then(task, task).catch((error) => {
      update("error");
      throw error;
    });
    return queue;
  }

  async function synchronize() {
    await connect();
    if (status === "completed") return;
    const target = percent();
    // Reassert final progress on retries: the SDK may have replaced an expired session.
    if (target > acknowledgedPercent || target === 100) {
      update("recording");
      await activity.progress(target, {
        idempotencyKey: `fdl:markers:progress:${target}`,
      });
      acknowledgedPercent = target;
    }
    if (target === 100) {
      update("completing");
      await activity.complete({ idempotencyKey: "fdl:markers:completed" });
      state = await activity.getState();
      if (!state.completedAt)
        throw new Error(
          "The server has not confirmed completion. Retry shortly.",
        );
      update("completed");
    } else {
      update("started");
    }
  }

  function recordExecution({ path, cellType, tags, success, executionCount }) {
    if (
      success !== true ||
      cellType !== "code" ||
      !Array.isArray(tags) ||
      !Number.isInteger(executionCount) ||
      executionCount < 1
    )
      return Promise.resolve();
    const marker = config.markers.find(
      (item) => item.notebook === path && tags.includes(item.tag),
    );
    if (!marker || executed.has(marker.tag)) return Promise.resolve();
    executed.add(marker.tag);
    return enqueue(synchronize);
  }

  return {
    start: () => enqueue(synchronize),
    recordExecution,
    retry: () => enqueue(synchronize),
    get status() {
      return status;
    },
    get state() {
      return state;
    },
    get executedCount() {
      return executed.size;
    },
    get progressPercent() {
      return percent();
    },
    hasExecuted: (tag) => executed.has(tag),
  };
}
