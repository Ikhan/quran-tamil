/**
 * The cover still: which surah, in three scripts, over a photograph.
 *
 * It is the frame someone sees in the grid before they have heard anything, so
 * it answers one question — what is this — and answers it in Tamil as well as
 * English, because that is the audience.
 *
 * Set in the same off-white, ink and crimson as the verse card, so a cover and
 * the reel behind it read as one account. The obvious alternative was the
 * green-and-yellow this genre is full of; that combination is the most
 * recognisable thing several established Tamil accounts have, and borrowing it
 * would make this look like their output rather than its own.
 *
 * Rendered by Remotion rather than drawn with ffmpeg for one reason: Tamil and
 * Arabic both need a shaping engine. `drawtext` places glyphs by codepoint and
 * would set ஸூரத்துல் as a row of unjoined parts.
 */
import React, { useState } from "react";
import {
  AbsoluteFill,
  Img,
  continueRender,
  delayRender,
  staticFile,
} from "remotion";
import { AMIRI_QURAN_DATA_URL } from "./lib/amiriQuranFont";
import { FRAME_HEIGHT, FRAME_WIDTH } from "./lib/layout";
import type { CoverFile } from "./lib/coverTypes";

const ARABIC_FONT = "AmiriQuran";
const TAMIL_FONT = "'Tamil Sangam MN', 'Noto Sans Tamil', sans-serif";
const LATIN_FONT =
  "'SF Pro Display', -apple-system, BlinkMacSystemFont, Helvetica, sans-serif";

const GROUND = "#faf7f2";
const INK = "#17150f";
const ACCENT = "#a8322a";
const QUIET = "#17150f7a";

/** Tamil for "verse". The mark is a fixed label with the number after it. */
const VERSE_LABEL = "வசனம்";

/** How far down the wash has faded to nothing, as a fraction of the frame. */
const WASH = 0.52;

const useAssets = (src: string | null): void => {
  const [handle] = useState(() => delayRender("Loading the cover"));

  React.useEffect(() => {
    const font = new FontFace(
      ARABIC_FONT,
      `url(${AMIRI_QURAN_DATA_URL}) format("truetype")`
    );

    const image = src
      ? new Promise<void>((resolve) => {
          const element = new Image();
          // A cover with no photograph beats a render that never finishes.
          element.onload = () => resolve();
          element.onerror = () => resolve();
          element.src = src;
        })
      : Promise.resolve();

    Promise.all([
      font.load().then((loaded) => document.fonts.add(loaded)),
      image,
    ])
      .catch(() => undefined)
      .finally(() => continueRender(handle));
  }, [handle, src]);
};

/**
 * Long names have to come down in size or they wrap into the line below.
 * Measured against the widest of them — Al-Mumtahanah, Ash-Shu'ara — rather
 * than guessed.
 */
const fitLatin = (text: string): number => {
  const n = text.trim().length;
  if (n <= 9) return 138;
  if (n <= 12) return 116;
  if (n <= 16) return 94;
  return 78;
};

const fitTamil = (text: string): number => {
  const n = text.trim().length;
  if (n <= 14) return 84;
  if (n <= 20) return 70;
  if (n <= 28) return 58;
  return 48;
};

export const Cover: React.FC<{ file: CoverFile }> = ({ file }) => {
  const src = file.image ? staticFile(file.image) : null;
  useAssets(src);

  const rule = (
    <div style={{ flex: 1, height: 1, backgroundColor: `${ACCENT}55` }} />
  );

  return (
    <AbsoluteFill style={{ backgroundColor: GROUND }}>
      {src ? (
        <Img
          src={src}
          style={{
            position: "absolute",
            width: "100%",
            height: "100%",
            objectFit: "cover",
          }}
        />
      ) : null}

      {/* A wash rather than a hard band: the type needs a quiet ground and the
          photograph needs to come through it. */}
      <AbsoluteFill
        style={{
          background:
            `linear-gradient(to bottom, ${GROUND} 0%, ${GROUND}f7 ${
              WASH * 62
            }%, ${GROUND}00 ${WASH * 112}%)`,
        }}
      />

      <div
        style={{
          position: "absolute",
          top: FRAME_HEIGHT * 0.06,
          left: 0,
          width: FRAME_WIDTH,
          padding: "0 72px",
          textAlign: "center",
        }}
      >
        {/* The Arabic name says "sura" already, so the English word is not set
            again above it. */}
        <div
          style={{
            fontFamily: ARABIC_FONT,
            fontSize: 62,
            lineHeight: 1.7,
            color: QUIET,
            direction: "rtl",
          }}
        >
          {file.surahArabic}
        </div>

        <div
          style={{
            fontFamily: LATIN_FONT,
            fontSize: fitLatin(file.surahEnglish),
            fontWeight: 800,
            color: INK,
            lineHeight: 1.06,
            letterSpacing: "-0.025em",
            marginTop: 8,
          }}
        >
          {file.surahEnglish}
        </div>

        {/* The Tamil takes the accent: it is the line this audience reads, and
            the reason the account exists. */}
        <div
          style={{
            fontFamily: TAMIL_FONT,
            fontSize: fitTamil(file.surahTamil),
            fontWeight: 700,
            color: ACCENT,
            lineHeight: 1.35,
            marginTop: 14,
          }}
        >
          {file.surahTamil}
        </div>

        {/* Rules rather than a filled block: the same information, without
            borrowing another account's badge. */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 28,
            marginTop: 40,
          }}
        >
          {rule}
          <div
            style={{
              fontFamily: TAMIL_FONT,
              fontSize: 42,
              fontWeight: 600,
              color: INK,
              letterSpacing: "0.14em",
              whiteSpace: "nowrap",
            }}
          >
            {VERSE_LABEL} {file.from}
            {file.to > file.from ? `-${file.to}` : ""}
          </div>
          {rule}
        </div>
      </div>
    </AbsoluteFill>
  );
};
