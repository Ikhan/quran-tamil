/**
 * The cover card: the still that fronts a reel in the grid.
 *
 * Written by the dashboard and read by `src/Cover.tsx`, the same way the reel's
 * job file is — the composition draws what it is told and works nothing out.
 */
export interface CoverFile {
  createdAt: string;
  surah: number;
  /** "Al-Baqara", from the vendored names. */
  surahEnglish: string;
  /** "سُورَةُ البَقَرَةِ", from the same source. */
  surahArabic: string;
  /** "ஸூரத்துல் பகரா" — typed by the operator; there is no vendored source. */
  surahTamil: string;
  /** The verses the reel is of. `to` equals `from` for a single verse. */
  from: number;
  to: number;
  /** Path under `public/`, as `staticFile()` wants it. Empty for no image. */
  image: string;
}
