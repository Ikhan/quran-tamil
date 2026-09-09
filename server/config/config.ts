import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Repository root — everything the pipeline touches is resolved from here. */
export const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

/**
 * Reads a required value from the environment.
 *
 * The dashboard can be exposed publicly through a tunnel, so credentials must
 * never fall back to a committed default.
 */
function requireEnv(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. ` +
        `Copy .env.example to .env and set it before starting the server.`
    );
  }

  return value;
}

export const config = {
  // 3004 is quran-reels, 3003 is the hadith dashboard.
  port: Number(process.env.PORT) || 3005,
  host: "0.0.0.0",
  nodeEnv: process.env.NODE_ENV || "development",
  sessionSecret: requireEnv("SESSION_SECRET"),

  paths: {
    data: path.join(PROJECT_ROOT, "data"),
    timings: path.join(PROJECT_ROOT, "data", "timings-parts"),
    output: path.join(PROJECT_ROOT, "output"),
    /** Arabic recitations, mirroring everyayah's one-folder-per-reciter layout. */
    recitations: path.join(PROJECT_ROOT, "data", "recitations"),
  },

  /**
   * Padding around a cut. The aligner marks where speech starts, not where the
   * breath before it does, so a cut exactly on the boundary clips the first
   * consonant. The tail is longer because a sentence trails off more slowly
   * than it begins.
   */
  clip: { leadIn: 0.18, tailOut: 0.35 },

  /** Fetching the Arabic from everyayah.com, the first time a verse is used. */
  recitation: { timeoutMs: 20000, concurrency: 4 },

  /**
   * Silences in an Arabic-then-Tamil clip.
   *
   * `afterArabic` is short: the translation answers the recitation, and a long
   * hole between them reads as a mistake. `betweenVerses` is longer, because it
   * is the only thing telling a listener that one verse has ended and the next
   * has begun — the two languages alternating is otherwise a continuous stream.
   */
  mix: { afterArabic: 0.45, betweenVerses: 0.9 },
};

/** Single operator account. */
export const appUser = {
  username: requireEnv("APP_USERNAME"),
  password: requireEnv("APP_PASSWORD"),
};

export default config;
