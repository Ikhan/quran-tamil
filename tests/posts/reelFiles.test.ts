import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../../server/config/config.js";
import { locateReel, referenceOf } from "../../server/posts/reelFiles.js";

describe("referenceOf", () => {
  it("reads the reference out of a reel's name", () => {
    expect(referenceOf("reel-112-003.mp4")).toBe("112:3");
    expect(referenceOf("reel-055-013-018-dark.mp4")).toBe("55:13-18");
    expect(referenceOf("cover-112-003.png")).toBeNull();
  });
});

describe("locateReel", () => {
  // locateReel resolves against the real output/, so the fixture lives there
  // under a sura number that does not exist, and is removed afterwards so it
  // never shows up in the dashboard's history.
  const folder = "999-vitest-fixture";
  const dir = join(config.paths.output, folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "reel-999-001.mp4"), "");
  writeFileSync(join(dir, "reel-999-002-dark.mp4"), "");
  writeFileSync(join(dir, "cover-999-002.png"), "");
  writeFileSync(join(dir, "caption-999-002.txt"), "  The batch's caption\n");
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("finds a reel, and no cover when none was made", async () => {
    expect(await locateReel(`${folder}/reel-999-001.mp4`)).toMatchObject({ reference: "999:1", cover: null, caption: null });
  });

  it("gives a dark reel the light reel's cover", async () => {
    expect((await locateReel(`${folder}//reel-999-002-dark.mp4`))!).toMatchObject({
      relative: `${folder}/reel-999-002-dark.mp4`,
      cover: `${folder}/cover-999-002.png`,
      caption: "The batch's caption",
    });
  });

  it("refuses anything outside the layout, or not on disk", async () => {
    expect(await locateReel("../etc/reel-001-001.mp4")).toBeNull();
    expect(await locateReel(`${folder}/reel-999-009.mp4`)).toBeNull();
    expect(await locateReel(`${folder}/cover-999-002.png`)).toBeNull();
  });
});
