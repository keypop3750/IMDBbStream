/**
 * lib/imdbTypeClassifier.mjs
 * Canonical mapping + helpers for IMDb titleType → Stremio buckets.
 * Phase 1: robust type-detection (movie vs series) + label mapping fallback.
 */

export const MOVIE_TYPES = new Set([
  'movie', 'tvmovie', 'short', 'tvshort', 'video', 'tvspecial', 'musicvideo'
]);

export const SERIES_TYPES = new Set([
  'tvseries', 'tvminiseries'
]);

export const EXCLUDE_TYPES = new Set([
  'tvepisode', 'videogame', 'podcastseries', 'podcastepisode'
]);

// Human label (as seen on IMDb list pages) → canonical imdb titleType
const LABEL_TO_TITLETYPE = new Map([
  ['movie', 'movie'],
  ['feature film', 'movie'],
  ['tv movie', 'tvmovie'],
  ['short', 'short'],
  ['tv short', 'tvshort'],
  ['video', 'video'],
  ['tv special', 'tvspecial'],
  ['music video', 'musicvideo'],

  ['tv series', 'tvseries'],
  ['tv mini series', 'tvminiseries'],
  ['mini-series', 'tvminiseries'],
  ['miniseries', 'tvminiseries'],

  ['tv episode', 'tvepisode'],
  ['video game', 'videogame'],
  ['podcast series', 'podcastseries'],
  ['podcast episode', 'podcastepisode'],
]);

/** Map an IMDb list label (e.g., "TV Series", "Movie") to canonical titleType. */
export function titleTypeFromLabel(label) {
  if (!label) return null;
  const key = String(label).trim().toLowerCase();
  return LABEL_TO_TITLETYPE.get(key) || null;
}

/**
 * Decide Stremio bucket ('movie' | 'series' | null) for a given canonical IMDb titleType.
 * Respects INCLUDE_MUSIC_VIDEO=false by default.
 */
export function bucketFor(titleTypeRaw) {
  if (!titleTypeRaw) return null;
  const tt = String(titleTypeRaw).trim().toLowerCase();
  const includeMusic = String(process.env.INCLUDE_MUSIC_VIDEO || 'false').toLowerCase() === 'true';
  if (tt === 'musicvideo' && !includeMusic) return null;
  if (MOVIE_TYPES.has(tt)) return 'movie';
  if (SERIES_TYPES.has(tt)) return 'series';
  if (EXCLUDE_TYPES.has(tt)) return null;
  return null;
}
