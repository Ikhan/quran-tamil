import { Composition } from "remotion";
import { Cover } from "./Cover";
import { TamilCard, DARK, LIGHT, getDurationInFrames } from "./TamilCard";
import { FPS, FRAME_HEIGHT, FRAME_WIDTH } from "./lib/layout";
import type { CoverFile } from "./lib/coverTypes";
import type { TamilReelFile } from "./lib/tamilTypes";
import reelData from "./data/reelData.json";
import coverData from "./data/coverData.json";

const HANDLE = "@ilmul_quran_tamil";

export const RemotionRoot = () => {
  // Double cast: TypeScript infers the *current* contents of the job files,
  // which the build scripts rewrite every run.
  const file = reelData as unknown as TamilReelFile;
  const cover = coverData as unknown as CoverFile;

  const shared = {
    durationInFrames: file.verses?.length ? getDurationInFrames(file) : 1,
    fps: FPS,
    width: FRAME_WIDTH,
    height: FRAME_HEIGHT,
    component: TamilCard,
  } as const;

  return (
    <>
      {/* Registered whether or not a reel is staged, so the cover can be made
          without one — they are produced at different moments. */}
      <Composition
        id="Cover"
        component={Cover}
        durationInFrames={1}
        fps={FPS}
        width={FRAME_WIDTH}
        height={FRAME_HEIGHT}
        defaultProps={{ file: cover }}
      />

      {file.verses?.length ? (
        <>
          <Composition
            id="TamilCard"
            {...shared}
            defaultProps={{ file, palette: LIGHT, handle: HANDLE }}
          />
          <Composition
            id="TamilCardDark"
            {...shared}
            defaultProps={{ file, palette: DARK, handle: HANDLE }}
          />
        </>
      ) : null}
    </>
  );
};
