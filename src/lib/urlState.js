// Map state <-> URL query string. Keeping position, zoom, filters and the
// selected node in the URL makes every view shareable and survives a reload.
//
// Shape: { z, lat, lon, types:number[], net, active, q, sel }
// Defaults are omitted from the URL so a pristine map has a clean address.

export const DEFAULT_STATE = {
  z: 3.8,
  lat: 49.4847,
  lon: 8.10428,
  types: [],
  net: '',
  active: 'all',
  q: '',
  sel: '',
  selnet: '',
  cluster: false,
  areas: false,
  imported: true,
  globe: true,
  basemap: 'carto-voyager',
  linkColor: '#c678dd',
  bandColors: false,
};

const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

/** Parse the current URL into a state object, falling back to DEFAULT_STATE. */
export function readState() {
  const p = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);
  // z < 1 is below the map's minZoom, so it can only be the uninitialized
  // sentinel (?z=0&lat=0&lon=0) written by a stray move during construction.
  // Treat that whole position as absent and fall back to the default view,
  // which self-heals a stuck address bar on the next write.
  const z = num(p.get('z'), DEFAULT_STATE.z);
  const validPos = Number.isFinite(z) && z >= 1;
  return {
    z: validPos ? z : DEFAULT_STATE.z,
    lat: validPos ? num(p.get('lat'), DEFAULT_STATE.lat) : DEFAULT_STATE.lat,
    lon: validPos ? num(p.get('lon'), DEFAULT_STATE.lon) : DEFAULT_STATE.lon,
    types: (p.get('types') ?? '')
      .split(',')
      .map((s) => Number(s))
      .filter((n) => Number.isFinite(n) && n > 0),
    net: p.get('net') ?? '',
    active: p.get('active') ?? DEFAULT_STATE.active,
    q: p.get('q') ?? '',
    sel: p.get('sel') ?? '',
    selnet: p.get('selnet') ?? '',
    cluster: p.get('cluster') === '1', // clustering off by default
    areas: p.get('areas') === '1',
    imported: p.get('imported') !== '0', // imported nodes shown by default
    globe: p.get('globe') !== '0', // 3D globe by default
    basemap: p.get('basemap') || DEFAULT_STATE.basemap,
    linkColor: p.get('linkColor') || DEFAULT_STATE.linkColor,
    bandColors: p.get('bandColors') === '1', // colour by band off by default
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
  if (s.selnet) p.set('selnet', s.selnet);
  if (s.cluster === true) p.set('cluster', '1');
  if (s.areas) p.set('areas', '1');
  if (s.imported === false) p.set('imported', '0');
  if (s.globe === false) p.set('globe', '0');
  if (s.basemap && s.basemap !== DEFAULT_STATE.basemap) p.set('basemap', s.basemap);
  if (s.linkColor && s.linkColor !== DEFAULT_STATE.linkColor) p.set('linkColor', s.linkColor);
  if (s.bandColors === true) p.set('bandColors', '1');
  return p.toString();
}

import { replaceState } from '$app/navigation';

let writeTimer;
/**
 * Debounced URL sync so rapid pans/zooms coalesce into one history entry. Uses
 * SvelteKit's replaceState (not the raw history API) so it doesn't fight the
 * router; guarded for SSR and for calls before the router is initialized.
 */
export function writeState(s, delay = 250) {
  if (typeof history === 'undefined') return;
  clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    try {
      replaceState(`?${toQuery(s)}`, history.state ?? {});
    } catch {
      // Router not ready yet (very early call); the next write will catch up.
    }
  }, delay);
}
