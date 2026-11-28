import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBrowserManager } from "../src/browser.ts";
import { createBrowserFixture, fixtureOrigin } from "./fixtures.ts";

test("closeSession releases the session slot when cookie persistence fails", {
  timeout: 120_000,
}, async (t) => {
  const fixture = await createBrowserFixture();
  t.after(async () => {
    try {
      await fixture.close();
    } finally {
      assert.deepEqual(fixture.unexpected, []);
    }
  });
  const dataDir = await mkdtemp(join(tmpdir(), "openfuse-browser-close-"));
  const browser = await createBrowserManager({ dataDir, maxSessions: 1 }, fixture.createProxy);
  const id = randomUUID();
  const next = randomUUID();
  try {
    await browser.create(id, `${fixtureOrigin}/page`);
    // A directory where storage.json would be written makes profile persistence fail.
    await mkdir(join(dataDir, id, "storage.json"), { recursive: true });
    await browser.closeSession(id);
    assert.equal(
      browser.list().find((session) => session.id === id)?.status,
      "closed",
      "the session must read back as closed",
    );
    const reopened = await browser.create(next, `${fixtureOrigin}/page`);
    assert.equal(reopened.status, "active");
    await browser.closeSession(next);
  } finally {
    await browser.close();
    await rm(dataDir, { recursive: true, force: true });
    for (const sessionId of [id, next])
      await rm(join("/tmp", `openfuse-downloads-${sessionId}`), { recursive: true, force: true });
  }
});
