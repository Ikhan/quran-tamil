/**
 * CLI over the same builder the dashboard uses.
 *
 *   npm run build:reel -- 110:3            one verse, staged only
 *   npm run build:reel -- 55:13-18         a passage
 *   npm run build:reel -- 112              a whole surah
 *   npm run reel -- 110:3                  stage, then render it
 *   npm run reel -- 113 --dark             the dark palette
 *   npm run reel -- 110:3 --reciter Husary_64kbps
 *
 * The reference is resolved the same way the dashboard resolves one, so pasted
 * Arabic works too — matched on its letter skeleton, so diacritics and verse
 * ornaments do not matter.
 *
 * Staging and rendering are separate by default because they cost differently
 * — seconds against minutes — and because `npm run studio` between the two is
 * how a reel gets looked at before a render is paid for. `--render` is for when
 * you already know what you are getting.
 */
// The config module reads the server's credentials at import time, so the CLI
// has to load the same .env the server does before touching it.
import "dotenv/config";
import { renderStaged, stageReel } from "../server/services/reelBuilder.js";
import { DEFAULT_RECITER, findReciter } from "../server/services/reciters.js";
import { resolveInput } from "../server/services/verseResolver.js";
import { FPS } from "../src/lib/layout.js";

const run = async (): Promise<void> => {
  const args = process.argv.slice(2);
  const reciterIndex = args.indexOf("--reciter");
  const reciterId =
    reciterIndex >= 0 ? args[reciterIndex + 1] : DEFAULT_RECITER;

  // With no --reciter flag `reciterIndex` is -1, so guard the comparison:
  // `index !== reciterIndex + 1` would otherwise reject argument zero, which is
  // the reference itself.
  const spec = args.find(
    (arg, index) =>
      !arg.startsWith("--") && !(reciterIndex >= 0 && index === reciterIndex + 1)
  );
  if (!spec) {
    throw new Error("Say what to build, e.g. `npm run reel -- 110:3`");
  }

  const { surah, from, to } = await resolveInput(spec);
  const file = await stageReel({ surah, from, to, reciterId });
  const reciter = findReciter(reciterId);

  console.log(
    `✅ ${file.reference} — ${file.verses.length} verse(s), ` +
      `${(file.durationInFrames / FPS).toFixed(1)}s · ${reciter?.name} + Tamil`
  );

  if (!args.includes("--render")) {
    return;
  }

  const dark = args.includes("--dark");
  console.log(`🎬 rendering ${dark ? "TamilCardDark" : "TamilCard"}…`);
  const name = await renderStaged(file, dark);
  console.log(`✅ output/${name}`);
};

run().catch((error: unknown) => {
  console.error(`❌ ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
