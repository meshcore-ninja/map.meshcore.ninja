// Client for the MeshCore Ninja map API. Every viewport request is keyed and
// briefly cached, and the caller threads an AbortSignal so a new request cancels
// the previous in-flight one (see MapView's moveend handler).

export const API_BASE = (import.meta.env?.VITE_API_BASE || 'https://api.meshcore.ninja').replace(
  /\/+$/,
  ''
);

const CACHE_TTL_MS = 30_000;
const cache = new Map(); // normalized query string -> { at, data }

/**
 * Build the /api/map query string from filter state. Only non-default params are
 * emitted so cache keys stay stable and URLs short.
 * @param {object} p
 * @param {[number,number,number,number]} [p.bbox] west,south,east,north
 * @param {number} p.zoom
 * @param {number[]} [p.types]
 * @param {string} [p.net]
 * @param {string} [p.active] one of 24h|7d|30d|all
 * @param {string} [p.q]
 */
export function mapQueryString({ bbox, zoom, types, net, active, q }) {
  const sp = new URLSearchParams();
  sp.set('zoom', String(zoom));
  // Search is global, so the bbox is irrelevant (and omitting it keeps the cache
  // key from churning as the user pans around a search result).
  if (bbox && !q) sp.set('bbox', bbox.map((n) => n.toFixed(4)).join(','));
  if (types?.length) sp.set('types', [...types].sort().join(','));
  if (net) sp.set('networks', net);
  if (active && active !== 'all') sp.set('active', active);
  if (q) sp.set('q', q);
  return sp.toString();
}

/**
 * Fetch one viewport as a GeoJSON FeatureCollection. Fresh cached responses are
 * returned without a network round-trip.
 * @param {object} params see mapQueryString
 * @param {AbortSignal} [signal]
 */
export async function mapQuery(params, signal) {
  const qs = mapQueryString(params);
  const hit = cache.get(qs);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;

  const res = await fetch(`${API_BASE}/api/map?${qs}`, { signal });
  if (!res.ok) throw new Error(`map api ${res.status}`);
  const data = await res.json();
  cache.set(qs, { at: Date.now(), data });
  return data;
}

let allNodesPromise;
/**
 * Every GPS node, once, as a GeoJSON FeatureCollection. Loaded a single time and
 * memoized — the map clusters and filters this set entirely client-side, so no
 * further node requests are made as the user pans, zooms or filters.
 * @returns {Promise<{type:string,features:any[]}>}
 */
export function allNodes() {
  if (!allNodesPromise) {
    allNodesPromise = fetch(`${API_BASE}/api/map?all=1`).then((r) => {
      if (!r.ok) throw new Error(`map api ${r.status}`);
      return r.json();
    });
  }
  return allNodesPromise;
}

/**
 * Individual nodes within a bounding box, as a GeoJSON FeatureCollection. Used
 * for the first paint: the current viewport loads fast, then {@link allNodes}
 * backfills the rest of the world. Not memoized (the bbox varies).
 * @param {[number,number,number,number]} bbox west,south,east,north
 * @param {AbortSignal} [signal]
 * @returns {Promise<{type:string,features:any[]}>}
 */
export function viewportNodes(bbox, signal) {
  const qs = `all=1&bbox=${bbox.map((n) => n.toFixed(4)).join(',')}`;
  return fetch(`${API_BASE}/api/map?${qs}`, { signal }).then((r) => {
    if (!r.ok) throw new Error(`map api ${r.status}`);
    return r.json();
  });
}

/**
 * Observed links for one node, as already-aggregated link records. Only links
 * with this node as an endpoint are returned — never the global topology. The
 * caller passes an AbortSignal so selecting another node cancels this request.
 * @param {string} pubkey selected node's public key (hex)
 * @param {object} [opts]
 * @param {string} [opts.net] restrict to links observed through this network
 * @param {string} [opts.active] one of 24h|7d|30d (omit/`all` = no recency filter)
 * @param {number} [opts.limit]
 * @param {AbortSignal} [signal]
 * @returns {Promise<{node:string,links:any[],returned:number,total:number,capped:boolean}>}
 */
export function nodeLinks(pubkey, { net, active, limit } = {}, signal) {
  const sp = new URLSearchParams();
  if (net) sp.set('networks', net);
  if (active && active !== 'all') sp.set('active', active);
  if (limit) sp.set('limit', String(limit));
  const qs = sp.toString();
  const url = `${API_BASE}/api/nodes/${encodeURIComponent(pubkey)}/links${qs ? `?${qs}` : ''}`;
  return fetch(url, { signal }).then((r) => {
    if (!r.ok) throw new Error(`links api ${r.status}`);
    return r.json();
  });
}

// Network coverage polygons come from the main catalog's prebuilt combined file
// (one request, tagged per network). Overridable for local testing.
const AREAS_ORIGIN = (import.meta.env?.VITE_AREAS_ORIGIN || 'https://meshcore.ninja').replace(
  /\/+$/,
  ''
);
let areasPromise;
/** The combined network-area FeatureCollection (memoized). */
export function networkAreas() {
  if (!areasPromise) {
    areasPromise = fetch(`${AREAS_ORIGIN}/network-area/all.geojson`)
      .then((r) => (r.ok ? r.json() : { type: 'FeatureCollection', features: [] }))
      .catch(() => ({ type: 'FeatureCollection', features: [] }));
  }
  return areasPromise;
}

let networksPromise;
/**
 * The network list (id + name), used to label the network filter. Fetched once
 * and memoized; failures resolve to an empty list so the filter just hides.
 * @returns {Promise<{id:string,name:string}[]>}
 */
export function networks() {
  if (!networksPromise) {
    networksPromise = fetch(`${API_BASE}/api/networks`)
      .then((r) => (r.ok ? r.json() : { networks: [] }))
      .then((d) => (d.networks ?? []).map((n) => ({ id: n.id, name: n.name })))
      .then((list) => list.sort((a, b) => a.name.localeCompare(b.name)))
      .catch(() => []);
  }
  return networksPromise;
}
