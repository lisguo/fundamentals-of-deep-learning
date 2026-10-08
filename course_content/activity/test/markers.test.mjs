// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("all nine configured tags exist on one code cell each; final tag is the requested decode", async () => {
  const config = JSON.parse(
    await readFile(
      new URL("../activity-config.example.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(config.markers.length, 9);
  for (const marker of config.markers) {
    const book = JSON.parse(
      await readFile(
        new URL(`../../${marker.notebook}`, import.meta.url),
        "utf8",
      ),
    );
    const tagged = book.cells.filter((c) =>
      c.metadata?.tags?.includes(marker.tag),
    );
    assert.equal(tagged.length, 1, marker.notebook);
    assert.equal(tagged[0].cell_type, "code");
    assert.ok(!tagged[0].source.join("").includes("do_shutdown"));
    if (marker.tag === "dli:complete:06")
      assert.equal(
        tagged[0].source.join(""),
        "question_answering_tokenizer.decode(answer_sequence)",
      );
  }
});
