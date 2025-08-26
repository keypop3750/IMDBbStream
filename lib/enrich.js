import fetch from 'node-fetch';

const BASE = 'https://v3-cinemeta.strem.io/meta';

function isHttpUrl(s){ return typeof s === 'string' && /^https?:\/\//i.test(s); }

// Local placeholders to avoid broken tiles
const POSTER_PLACEHOLDER = {
  movie: '/assets/poster-movie.svg',
  series: '/assets/poster-series.svg'
};
const BACKDROP_PLACEHOLDER = {
  movie: '/assets/background-movie.svg',
  series: '/assets/background-series.svg'
};

async function fetchCinemeta(type, imdbId) {
  const url = `${BASE}/${type}/${imdbId}.json`;
  const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!r.ok) return null;
  const j = await r.json();
  return j && j.meta ? j.meta : null;
}

export async function enrichFull(imdbId) {
  // Cinemeta-first: try movie, then series
  let meta = await fetchCinemeta('movie', imdbId);
  if (!meta) meta = await fetchCinemeta('series', imdbId);
  if (!meta) return null;

  // Normalize type names
  let t = (meta.type || '').toLowerCase();
  if (t === 'tv' || t === 'show') t = 'series';
  if (t !== 'movie' && t !== 'series') t = 'movie';

  // Choose poster with fallbacks:
  // 1) Cinemeta poster if valid http
  // 2) Use background as poster (landscape) if valid http
  // 3) Type-specific local placeholder
  let posterShape;
  let poster = isHttpUrl(meta.poster) ? meta.poster : undefined;
  if (poster) {
    posterShape = meta.posterShape || 'poster';
  } else if (isHttpUrl(meta.background)) {
    poster = meta.background;
    posterShape = 'landscape';
  } else {
    poster = POSTER_PLACEHOLDER[t];
    posterShape = 'poster';
  }

  // Background with placeholder fallback
  let background = isHttpUrl(meta.background) ? meta.background : BACKDROP_PLACEHOLDER[t];

  const logo = isHttpUrl(meta.logo) ? meta.logo : undefined;

  return {
    id: meta.id,
    type: t,
    name: meta.name,
    poster,
    posterShape,
    background,
    logo,
    releaseInfo: meta.releaseInfo,
    year: meta.year,
    genres: meta.genres,
    imdbRating: meta.imdbRating,
    runtime: meta.runtime,
    description: meta.description || meta.overview,
    cast: Array.isArray(meta.cast) ? meta.cast.slice(0, 8) : undefined,
    director: Array.isArray(meta.director) ? meta.director : (meta.directors || undefined),
    videos: meta.videos,
  };
}
