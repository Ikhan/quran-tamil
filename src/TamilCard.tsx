/**
 * One verse on screen: the Arabic above, the Tamil below, both there the whole
 * time. The recitation lights the Arabic word by word, then the translation
 * lights the Tamil line by line. When the verse is finished the next one takes
 * its place and does the same.
 *
 * Modelled on how Tamil Qur'an posts are already set — a form the audience
 * reads without being taught. It differs from `TamilReel` in that nothing
 * accumulates: each verse gets the whole frame, so both languages are large.
 *
 * Set on off-white rather than the dark ground used elsewhere, for one reason:
 * Tamil carries its meaning in fine strokes — ண against ன, ற against ர — and
 * light type on a dark ground blooms just enough at reading size to blur them.
 * The Tamil is the half being read, so it gets the legible polarity.
 *
 * The Tamil is lit by line, not by word. The verse index does now carry the
 * aligner's per-word spans, so a word-level highlight is possible — but the job
 * file does not yet carry them through, and a line is the right unit anyway on
 * a translation: Tamil words are long, and a highlight hopping through fifteen
 * of them reads as flicker rather than as reading.
 */
import React, { useState } from "react";
import {
  AbsoluteFill,
  Audio,
  Sequence,
  continueRender,
  delayRender,
  interpolate,
  staticFile,
  useCurrentFrame,
} from "remotion";
import { AMIRI_QURAN_DATA_URL } from "./lib/amiriQuranFont";
import {
  FRAME_HEIGHT,
  FRAME_WIDTH,
  SAFE_AREA,
  TAMIL_LINE_HEIGHT,
  layoutVerse,
} from "./lib/layout";
import type { TamilReelFile, TamilVerse } from "./lib/tamilTypes";

const ARABIC_FONT = "AmiriQuran";
/**
 * Shipped with macOS. Good enough to judge the design by; a reel built for
 * publication should embed Noto Sans Tamil as a data URL the way the Arabic is,
 * or it will render with a fallback face on any other machine.
 */
const TAMIL_FONT = "'Tamil Sangam MN', 'Noto Sans Tamil', sans-serif";
const LATIN_FONT =
  "'SF Pro Display', -apple-system, BlinkMacSystemFont, sans-serif";

export interface Palette {
  ground: string;
  ink: string;
  /** Text that is on screen but not currently being spoken. */
  resting: string;
  /** The word or line being spoken now. */
  accent: string;
  /** Reference lines and the handle. */
  quiet: string;
}

/**
 * Off-white rather than pure white: white at full brightness is uncomfortable
 * at night, which is when most of this is watched, and it makes the accent
 * look harsh against it.
 */
export const LIGHT: Palette = {
  ground: "#faf7f2",
  ink: "#17150f",
  resting: "#17150f59",
  accent: "#a8322a",
  quiet: "#17150f66",
};

export const DARK: Palette = {
  ground: "#0b1512",
  ink: "#f4efe4",
  resting: "#f4efe46b",
  accent: "#e8c07d",
  quiet: "#f4efe473",
};

const HIGHLIGHT_FRAMES = 4;
const ARRIVAL_FRAMES = 10;
/** Held after the last line, so the reel does not cut on the final word. */
export const TAIL_FRAMES = 50;

const CONTENT_WIDTH = FRAME_WIDTH * (1 - SAFE_AREA.left - SAFE_AREA.right);
/** Height the pinned bismillah occupies at the top of the card. */
const BISMILLAH_BAND = 96;

const useArabicFont = (): boolean => {
  const [ready, setReady] = useState(false);
  const [handle] = useState(() => delayRender("Loading AmiriQuran"));

  React.useEffect(() => {
    const font = new FontFace(
      ARABIC_FONT,
      `url(${AMIRI_QURAN_DATA_URL}) format("truetype")`
    );

    font
      .load()
      .then((loaded) => {
        document.fonts.add(loaded);
        setReady(true);
        continueRender(handle);
      })
      .catch(() => {
        setReady(true);
        continueRender(handle);
      });
  }, [handle]);

  return ready;
};

const highlightAt = (frame: number, from: number, to: number): number =>
  interpolate(
    frame,
    [
      from - HIGHLIGHT_FRAMES,
      from,
      Math.max(to, from + 1),
      Math.max(to, from + 1) + HIGHLIGHT_FRAMES,
    ],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

export const getDurationInFrames = (file: TamilReelFile): number =>
  file.durationInFrames + TAIL_FRAMES;

/**
 * One segment per verse, filling in time with the audio.
 *
 * A reel carrying several verses gives a viewer no way to know whether they are
 * a third of the way in or about to reach the end — and "how much is left" is
 * exactly what someone decides to keep watching on. The bar carries that on its
 * own, without a counter beside it: a number would say the same thing twice and
 * put a second thing to read next to the verse.
 *
 * Segments are proportional to each verse's real length rather than equal, so
 * the bar tracks the audio instead of merely counting.
 */
const Progress: React.FC<{
  file: TamilReelFile;
  frame: number;
  palette: Palette;
}> = ({ file, frame, palette }) => {
  const total = file.durationInFrames || 1;

  return (
    <div style={{ display: "flex", gap: 6, marginBottom: 22 }}>
      {file.verses.map((verse, index) => {
        const next = file.verses[index + 1];
        const start = verse.arabicStart;
        const end = next ? next.arabicStart : total;
        const filled = interpolate(frame, [start, end], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });

        return (
          <div
            key={verse.ayah}
            style={{
              flex: end - start,
              height: 3,
              borderRadius: 2,
              backgroundColor: palette.resting,
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: `${filled * 100}%`,
                height: "100%",
                backgroundColor: palette.accent,
              }}
            />
          </div>
        );
      })}
    </div>
  );
};

const Card: React.FC<{
  verse: TamilVerse;
  file: TamilReelFile;
  frame: number;
  palette: Palette;
  /**
   * Whether the translation is lit line by line. On by default for every reel,
   * single verse or whole surah: on a long verse the lit line is the only thing
   * telling a reader where in sixteen lines the voice currently is.
   */
  litLines: boolean;
  handle: string;
}> = ({ verse, file, frame, palette, litLines, handle }) => {
  const localArabic = frame - verse.arabicStart;
  const localTamil = frame - verse.tamilStart;
  const reciting = frame < verse.tamilStart;

  // Sized to fill the card rather than to a fixed scale: a four-word verse
  // should be enormous and a long one should still fit, and both should reach
  // the edges of the measure. `layoutVerse` is the same call the build script
  // made when it split the lines, so the two cannot disagree.
  const { arabicSize: aSize, tamilSize: tSize } = layoutVerse(
    verse.arabic,
    verse.tamil
  );

  return (
    <div
      style={{
        position: "absolute",
        top: FRAME_HEIGHT * SAFE_AREA.top,
        left: FRAME_WIDTH * SAFE_AREA.left,
        width: CONTENT_WIDTH,
        height: FRAME_HEIGHT * (1 - SAFE_AREA.top - SAFE_AREA.bottom),
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Fixed furniture, like the footer: pinned rather than carried along by
          the verse. Inside the centred group it rode up and down with the
          Arabic, so it landed somewhere different on every reel — and a mark
          that moves is not a mark anyone recognises. */}
      <div
        style={{
          fontFamily: ARABIC_FONT,
          fontSize: 44,
          textAlign: "center",
          color: palette.quiet,
          height: BISMILLAH_BAND,
        }}
      >
        ﷽
      </div>

      {/* The verse is centred in what is left between the mark and the footer,
          rather than in the whole box. Centring in the whole box and then
          pinning the two leaves the type sitting high with a hole beneath it. */}
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
        }}
      >
      <div
        style={{
          direction: "rtl",
          fontFamily: ARABIC_FONT,
          fontSize: aSize,
          lineHeight: 2,
          textAlign: "center",
          color: palette.ink,
        }}
      >
        {verse.words.map((word, index) => {
          const heat = reciting
            ? highlightAt(localArabic, word.fromFrame, word.toFrame)
            : 0;

          return (
            <span
              key={`${word.text}-${index}`}
              style={{
                color: heat > 0.5 ? palette.accent : palette.ink,
                opacity: reciting ? 0.55 + heat * 0.45 : 1,
                margin: "0 0.16em",
                display: "inline-block",
              }}
            >
              {word.text}
            </span>
          );
        })}
      </div>

      <div
        style={{
          fontFamily: ARABIC_FONT,
          fontSize: 30,
          textAlign: "center",
          color: palette.quiet,
          marginTop: 14,
        }}
      >
        ﴿{file.surah}:{verse.ayah}﴾
      </div>

      <div style={{ marginTop: 44 }}>
        {verse.lines.map((line, index) => {
          // A line is lit from the moment its share of the audio begins until
          // the next line takes over, and rests — not disappears — either side
          // of that. The whole translation stays readable throughout, which is
          // what makes the frame worth screenshotting at any point in it.
          // The ramp cannot be wider than the line it fades. A line's share
          // of the audio is proportional to its text, so a one-word line -
          // "நீர்" ending 89:10 - can come in under 7 frames, and a fixed +/-5
          // then asks interpolate for a range that stops increasing. Thirds,
          // not halves: halves would make the two middle points equal, and
          // the range has to be strictly increasing.
          const span = Math.max(line.toFrame - line.fromFrame, 1);
          const ramp = Math.min(5, span / 3);
          const lineEnd = line.fromFrame + span;
          const lit = litLines
            ? interpolate(
                localTamil,
                [
                  line.fromFrame - ramp,
                  line.fromFrame + ramp,
                  lineEnd - ramp,
                  lineEnd + ramp,
                ],
                [0, 1, 1, 0],
                { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
              )
            : 1;

          return (
            <div
              key={index}
              style={{
                fontFamily: TAMIL_FONT,
                fontSize: tSize,
                lineHeight: TAMIL_LINE_HEIGHT,
                // Ranged left, as Tamil Qur'an posts are set. Centring a block
                // this long gives every line a different left edge, and the eye
                // has to find the start of each one.
                textAlign: "left",
                color: lit > 0.5 ? palette.ink : palette.resting,
              }}
            >
              {line.text}
            </div>
          );
        })}
      </div>

      </div>

      {file.verses.length > 1 ? (
        <Progress file={file} frame={frame} palette={palette} />
      ) : null}

      <div
        style={{
          textAlign: "center",
          fontFamily: LATIN_FONT,
          fontSize: 26,
          letterSpacing: "0.16em",
          color: palette.quiet,
        }}
      >
        {file.surahName} · {file.surah}:{verse.ayah}
        <div style={{ marginTop: 34, letterSpacing: "0.28em", fontSize: 24 }}>
          {handle}
        </div>
      </div>
    </div>
  );
};

export const TamilCard: React.FC<{
  file: TamilReelFile;
  palette?: Palette;
  handle?: string;
  litLines?: boolean;
}> = ({ file, palette = LIGHT, handle = "@ilmul_quran_tamil", litLines = true }) => {
  const frame = useCurrentFrame();
  const ready = useArabicFont();

  let activeIndex = 0;
  file.verses.forEach((verse, index) => {
    if (frame >= verse.arabicStart) {
      activeIndex = index;
    }
  });

  const verse = file.verses[activeIndex];
  // Verses replace each other rather than stacking, so the change of verse is
  // the one moment the frame is not simply readable. A short fade is enough to
  // read it as a turn of the page rather than as a cut.
  const arrival = interpolate(
    frame,
    [verse.arabicStart - ARRIVAL_FRAMES, verse.arabicStart],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  return (
    <AbsoluteFill style={{ backgroundColor: palette.ground }}>
      {file.verses.map((item) => (
        <React.Fragment key={item.ayah}>
          <Sequence from={item.arabicStart} durationInFrames={item.arabicFrames}>
            <Audio src={staticFile(item.arabicAudio)} />
          </Sequence>
          {/* A verse whose narration was rejected still holds the frame for
              its reading time — the card and its line highlighting are
              unchanged, there is just no track under them. */}
          {item.tamilAudio ? (
            <Sequence from={item.tamilStart} durationInFrames={item.tamilFrames}>
              <Audio src={staticFile(item.tamilAudio)} />
            </Sequence>
          ) : null}
        </React.Fragment>
      ))}

      <AbsoluteFill style={{ opacity: ready ? arrival : 0 }}>
        <Card
          verse={verse}
          file={file}
          frame={frame}
          palette={palette}
          litLines={litLines}
          handle={handle}
        />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
