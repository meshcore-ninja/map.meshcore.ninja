// Map state <-> URL query string. Keeping position, zoom, filters and the
// selected node in the URL makes every view shareable and survives a reload.
//
// Shape: { z, lat, lon, types:number[], net, active, q, sel }
// Defaults are omitted from the URL so a pristine map has a clean address.

export const DEFAULT_STATE = {
  z: 4,
  lat: 50,
  lon: 12,
  types: [],
  net: '',
  active: 'all',
  q: '',
  sel: '',
  cluster: true,
  areas: false
};

const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

/** Parse the current URL into a state object, falling back to DEFAULT_STATE. */
export function readState() {
  const p = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);
  return {
    z: num(p.get('z'), DEFAULT_STATE.z),
    lat: num(p.get('lat'), DEFAULT_STATE.lat),
    lon: num(p.get('lon'), DEFAULT_STATE.lon),
    types: (p.get('types') ?? '')
      .split(',')
      .map((s) => Number(s))
      .filter((n) => Number.isFinite(n) && n > 0),
    net: p.get('net') ?? '',
    active: p.get('active') ?? DEFAULT_STATE.active,
    q: p.get('q') ?? '',
    sel: p.get('sel') ?? '',
    cluster: p.get('cluster') !== '0', // clustering on by default
    areas: p.get('areas') === '1'
  };
}

/** Serialize state to a query string, omitting defaults. */
export function toQuery(s) {
  const p = new URLSearchParams();
  p.set('z', s.z.toFixed(2).replace(/\.?0+$/, ''));
  p.set('lat', s.lat.toFixed(5));
  p.set('lon', s.lon.toFixed(5));
  if (s.types?.length) p.set('types', [...s.types].sort().join(','));
  if (s.net) p.set('net', s.net);
  if (s.active && s.active !== 'all') p.set('active', s.active);
  if (s.q) p.set('q', s.q);
  if (s.sel) p.set('sel', s.sel);
  if (s.cluster === false) p.set('cluster', '0');
  if (s.areas) p.set('areas', '1');
  return p.toString();
}

let writeTimer;
/** Debounced history.replaceState so rapid pans/zooms coalesce into one entry. */
export function writeState(s, delay = 250) {
  if (typeof history === 'undefined') return;
  clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    history.replaceState(history.state, '', `?${toQuery(s)}`);
  }, delay);
}
