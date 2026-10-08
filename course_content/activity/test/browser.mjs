// SPDX-License-Identifier: Apache-2.0
// Real kernel execution in temporary lightweight notebooks; never train course models.
import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const login = (await fs.readFile(process.env.AUTH_URL_FILE, "utf8")).trim();
const live = process.env.LIVE_ACTIVITY === "1";
const config = JSON.parse(
  await fs.readFile(
    new URL("../../activity-config.local.json", import.meta.url),
    "utf8",
  ),
);
const id = crypto.randomUUID();
const fixtureRoot = new URL(`../browser-fixtures/${id}/`, import.meta.url);
await fs.mkdir(fixtureRoot, { recursive: true });
const testConfig = {
  ...config,
  markers: config.markers.map((m, i) => ({
    ...m,
    notebook: `activity/browser-fixtures/${id}/${m.notebook.split("/").pop()}`,
  })),
};
const cell = (source, tags = []) => ({
  cell_type: "code",
  metadata: { tags },
  execution_count: null,
  outputs: [],
  source: [source],
});
for (let i = 0; i < 9; i++) {
  // Final fixture uses the exact decode expression, with an explicitly fake tokenizer.
  const source =
    i === 8
      ? "question_answering_tokenizer.decode(answer_sequence)"
      : 'print("marker executed")';
  const setup =
    i === 8
      ? 'question_answering_tokenizer = type("TestTokenizer", (), {"decode": lambda self, seq: "fixture"})()\nanswer_sequence = [1]'
      : 'print("unmarked cell")';
  const book = {
    nbformat: 4,
    nbformat_minor: 4,
    metadata: {
      kernelspec: {
        name: "python3",
        language: "python",
        display_name: "Python 3 (ipykernel)",
      },
    },
    cells: [cell(setup), cell(source, [testConfig.markers[i].tag])],
  };
  await fs.writeFile(new URL(testConfig.markers[i].notebook.split("/").pop(), fixtureRoot), JSON.stringify(book));
}
const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 2000 } });
const page = await context.newPage();
const writes = [],
  responses = [];
let progress = 0,
  completedAt = null,
  sessions = 0,
  failProgress = false;
const sessionId = "019f0000-0000-7000-8000-000000000001";
const state = () => ({
  session_id: sessionId,
  tracking_mode: "anonymous",
  progress_percent: progress,
  completed_at: completedAt,
});
await page.route(
  "**/api/contents/activity-config.local.json?*",
  async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.content =
      typeof body.content === "string"
        ? JSON.stringify(testConfig)
        : testConfig;
    await route.fulfill({ response, json: body });
  },
);
if (!live) {
  await page.route(`${config.baseUrl}/**`, async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname,
      body = request.postDataJSON();
    let result,
      status = 200;
    if (path === "/v1/activity-sessions") {
      sessions++;
      result = {
        session_id: sessionId,
        session_token: "test-token-not-a-real-credential",
        expires_at: new Date(Date.now() + 86400000).toISOString(),
      };
    } else if (path.endsWith("/state")) result = state();
    else if (path.endsWith("/updates")) {
      writes.push({
        type: body.type,
        progress: body.payload.progress_percent,
        key: request.headers()["idempotency-key"],
      });
      if (body.type === "progress" && failProgress) {
        status = 503;
        result = { detail: "test outage" };
      } else {
        if (body.type === "progress") progress = body.payload.progress_percent;
        if (body.type === "completed") completedAt = new Date().toISOString();
        result = {
          update_id: crypto.randomUUID(),
          received_at: new Date().toISOString(),
          state: state(),
        };
        status = 201;
      }
    } else throw Error("Unexpected Activity request");
    await route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(result),
    });
  });
} else {
  page.on("response", async (response) => {
    if (!response.url().startsWith(config.baseUrl)) return;
    const request = response.request(),
      entry = {
        method: request.method(),
        path: new URL(response.url()).pathname,
        status: response.status(),
      };
    if (request.method() === "POST" && entry.path.endsWith("/updates"))
      entry.body = request.postDataJSON();
    try {
      const data = await response.json();
      entry.result = Object.fromEntries(
        ["session_id", "update_id", "progress_percent", "completed_at"]
          .filter((k) => k in data)
          .map((k) => [k, data[k]]),
      );
    } catch (_) {}
    responses.push(entry);
  });
}
try {
  const url = new URL(login);
  url.pathname = `/lab/workspaces/marker-test-${id}`;
  await page.goto(url.href, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.jupyterapp?.commands);
  const panel = page.locator("#fdl-activity-panel");
  await panel.waitFor({ state: "attached", timeout: 60000 });
  assert.equal(sessions, 0);
  for (const marker of testConfig.markers) {
    await expect(panel.getByText(marker.label, { exact: true })).toHaveCount(1);
    if (marker.description)
      await expect(panel.getByText(marker.description, { exact: true })).toHaveCount(1);
  }
  assert.equal(
    await panel.getByRole("button", { name: "Mark course complete" }).count(),
    0,
  );
  const open = async (i) => {
    await page.evaluate(async (path) => {
      const app = window.jupyterapp;
      const widget = await app.commands.execute("docmanager:open", {
        path,
        factory: "Notebook",
      });
      await widget.context.ready;
      await widget.sessionContext.ready;
      await widget.sessionContext.session.kernel.ready;
      app.shell.activateById(widget.id);
    }, testConfig.markers[i].notebook);
  };
  const run = async (index, source) => {
    await page.evaluate(
      async ({ index, source }) => {
        const app = window.jupyterapp,
          widget = app.shell.currentWidget;
        const book = widget.content;
        book.activeCellIndex = index;
        book.deselectAll();
        if (source !== undefined)
          book.activeCell.model.sharedModel.setSource(source);
        await app.commands.execute("notebook:run-cell");
      },
      { index, source },
    );
  };
  const count = async (n) => {
    await expect(panel.locator('li[data-completed="true"]')).toHaveCount(n, { timeout: 30000 });
    await expect(panel.getByRole("progressbar")).toHaveCount(0);
  };
  const capture = async (path) => {
    const bounds = await panel.boundingBox();
    const status = await panel.getByRole("status").boundingBox();
    await page.screenshot({ path, clip: { x: bounds.x, y: bounds.y, width: bounds.width, height: status.y + status.height + 16 - bounds.y } });
  };
  // Final marker first: proves it cannot complete by itself.
  await open(8);
  await run(1, ""); // Empty tagged cells do not execute and must not count.
  await count(0);
  await run(1, "question_answering_tokenizer.decode(answer_sequence)"); // Missing tokenizer -> execution error.
  await count(0);
  await run(0); // Unmarked setup -> no credit.
  await count(0);
  await run(1);
  await count(1);
  await run(1); // Repeat -> no extra credit.
  await count(1);
  assert.equal(
    await panel
      .getByText("All notebook markers executed. Completion recorded.", {
        exact: true,
      })
      .count(),
    0,
  );
  // Restart the final notebook kernel and rerun; browser evidence is retained.
  await page.evaluate(async () => {
    const w = window.jupyterapp.shell.currentWidget;
    await w.sessionContext.session.kernel.restart();
  });
  await run(0);
  await run(1);
  await count(1);
  for (let i = 0; i < 8; i++) {
    await open(i);
    if (!live && i === 0) failProgress = true;
    await run(1);
    await count(i + 2);
    if (!live && i === 0) {
      await panel.getByRole("button", { name: "Retry", exact: true }).waitFor();
      failProgress = false;
      await panel.getByRole("button", { name: "Retry", exact: true }).click();
    }
    if (i === 2 && process.env.PARTIAL_SCREENSHOT_PATH)
      await capture(process.env.PARTIAL_SCREENSHOT_PATH);
    // Await delivery so API acceptance ordering is independently observable.
    if (i < 7)
      await panel
        .getByText("Tracking marked cell executions.", { exact: true })
        .waitFor({ timeout: 30000 });
  }
  // Async API consumers can lag acceptance: explicit retry does not recount cells.
  await expect(async () => {
    const retry = panel.getByRole("button", { name: "Retry", exact: true });
    if (await retry.isVisible()) await retry.click();
    await expect(
      panel.getByText("All notebook markers executed. Completion recorded.", {
        exact: true,
      }),
    ).toBeVisible({ timeout: 1500 });
  }).toPass({ timeout: 30000 });
  if (!live) {
    assert.equal(sessions, 1);
    assert.equal(progress, 100);
    assert.ok(completedAt);
    assert.equal(writes.filter((x) => x.type === "completed").length, 1);
  }
  const storage = await page.evaluate(() => [
    ...Object.entries(localStorage),
    ...Object.entries(sessionStorage),
  ]);
  assert.ok(
    storage.every(
      ([k, v]) => !/session_token|test-token-not-a-real-credential/.test(k + v),
    ),
  );
  await expect(panel.getByText("✓ Course complete", { exact: true })).toBeVisible();
  if (process.env.SCREENSHOT_PATH)
    await capture(process.env.SCREENSHOT_PATH);
  console.log(
    JSON.stringify(
      {
        mode: live
          ? "live-api-with-fixture-executions"
          : "intercepted-api-with-fixture-executions",
        result: "PASS",
        writes: live ? undefined : writes,
        responses: live ? responses : undefined,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error("Browser test failed:", error.message.split("\n")[0]);
  console.error(
    "Panel:",
    await page
      .locator("#fdl-activity-panel")
      .textContent({ timeout: 2000 })
      .catch(() => "not loaded"),
  );
  if (live) console.error(JSON.stringify(responses, null, 2));
  if (process.env.SCREENSHOT_PATH)
    await page.screenshot({
      path: process.env.SCREENSHOT_PATH,
      fullPage: true,
    });
  process.exitCode = 1;
} finally {
  // Shut down only kernels created for these temporary fixtures.
  await page
    .evaluate(async (prefix) => {
      const app = window.jupyterapp;
      if (!app) return;
      await app.serviceManager.sessions.refreshRunning();
      for (const session of app.serviceManager.sessions.running())
        if (session.path.startsWith(prefix))
          await app.serviceManager.sessions.shutdown(session.id);
    }, `activity/browser-fixtures/${id}/`)
    .catch(() => {});
  await browser.close();
  await fs.rm(fixtureRoot, { recursive: true, force: true });
}
