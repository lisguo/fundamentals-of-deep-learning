// SPDX-FileCopyrightText: 2026 NVIDIA CORPORATION & AFFILIATES
// SPDX-License-Identifier: Apache-2.0
import { INotebookTracker, NotebookActions } from "@jupyterlab/notebook";
import { Widget } from "@lumino/widgets";
import { DLIActivity } from "./activity-sdk.js";
import {
  createCourseTracker,
  isCourseNotebook,
  validateConfig,
} from "./controller.js";

export default {
  id: "@dli/fdl-activity-pilot:plugin",
  autoStart: true,
  requires: [INotebookTracker],
  activate: async (app, notebooks) => {
    // Opt-in: the file is local-only and relative to ServerApp.root_dir.
    let config;
    try {
      const file = await app.serviceManager.contents.get(
        "activity-config.local.json",
        { content: true },
      );
      config = validateConfig(
        typeof file.content === "string"
          ? JSON.parse(file.content)
          : file.content,
      );
    } catch (error) {
      if (error?.response?.status !== 404) {
        console.warn(
          "FDL activity tracking is disabled: check activity-config.local.json.",
        );
      }
      return;
    }

    const panel = new Widget();
    panel.id = "fdl-activity-panel";
    panel.title.label = "Course activity";
    panel.title.caption = "FDL activity pilot";
    panel.title.closable = false;
    panel.node.style.cssText =
      "padding:16px;min-width:240px;overflow:auto;color:var(--jp-ui-font-color1);background:var(--jp-layout-color1);";
    const add = (tag, text) => {
      const element = document.createElement(tag);
      element.textContent = text;
      panel.node.append(element);
      return element;
    };
    add("h2", "Fundamentals of Deep Learning");
    add("p", "Local activity pilot");
    const status = add("p", "Open a course notebook to start tracking.");
    status.setAttribute("role", "status");
    const details = add("p", "");
    const progress = add(
      "p",
      `0 of ${config.markers.length} notebook markers executed (0%).`,
    );
    const checklist = add("ul", "");
    const items = config.markers.map((marker) => {
      const item = document.createElement("li");
      item.textContent = marker.notebook.split("/").pop();
      checklist.append(item);
      return item;
    });
    const retry = add("button", "Retry");
    retry.type = "button";
    retry.hidden = true;
    retry.style.cssText = "padding:8px 12px;margin-left:8px;cursor:pointer;";
    add(
      "p",
      "Progress counts successful executions of marked cells. All notebook markers are required for completion.",
    );
    add("p", "This records execution, not assessment scores or certification.");
    add(
      "p",
      "Tracking stays in this browser tab. Reloading or opening another tab starts a new anonymous session.",
    );
    const messages = {
      starting: "Connecting to the Activity API…",
      started: "Tracking marked cell executions.",
      recording: "Sending course progress…",
      completing: "Recording your completion…",
      completed: "All notebook markers executed. Completion recorded.",
      error:
        "Activity could not be confirmed. You can keep using the course and retry.",
    };
    const tracker = createCourseTracker(
      config,
      (options) => DLIActivity.initialize(options),
      (next, state) => {
        status.textContent = messages[next];
        progress.textContent = `${tracker.executedCount} of ${config.markers.length} notebook markers executed (${tracker.progressPercent}%).`;
        items.forEach((item, i) => {
          const marker = config.markers[i];
          item.textContent = `${tracker.hasExecuted(marker.tag) ? "✓" : "○"} ${marker.notebook.split("/").pop()}`;
        });
        retry.hidden = next !== "error";
        details.textContent = state?.sessionId
          ? `Session: ${state.sessionId}`
          : "";
      },
    );
    const run = async (operation) => {
      try {
        await operation;
      } catch (_) {
        /* Safe status is rendered by the controller. */
      }
    };
    retry.addEventListener("click", () => {
      void run(tracker.retry());
    });
    NotebookActions.executed.connect((_, event) => {
      // The executed notebook may be in a background tab. Never use currentWidget here.
      const owner = notebooks.find(
        (widget) => widget.content === event.notebook,
      );
      if (!owner) return;
      void run(
        tracker.recordExecution({
          path: owner.context.path,
          cellType: event.cell.model.type,
          tags: event.cell.model.getMetadata("tags"),
          success: event.success,
          executionCount: event.cell.model.executionCount,
        }),
      );
    });
    app.shell.add(panel, "right", { rank: 800 });

    const observe = () => {
      if (isCourseNotebook(notebooks.currentWidget?.context.path, config)) {
        app.shell.activateById(panel.id);
        if (tracker.status === "idle") void run(tracker.start());
      }
    };
    notebooks.currentChanged.connect(observe);
    // Restoration waits for activation; awaiting it here would deadlock startup.
    void app.restored.then(observe);
  },
};
