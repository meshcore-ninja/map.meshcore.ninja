// Client for the MeshCore Ninja API.

import { nodeBandId } from '$lib/nodeMeta.js';

export const API_BASE = (import.meta.env?.VITE_API_BASE || 'https://api.meshcore.ninja').replace(
  /\/+$/,
  ''
);

// --- snapshot-based full-node load -------------------------------------------
// The API publishes a versioned full-map snapshot every 5 minutes.  latest.json
// points to the current snapshot URL; the snapshot itself is served with a
// one-year immutable cache so browsers only download it once per publish cycle.
//
// Compact tuple layout (one per node):
//   [pubkey, name, nodeType, lat, lon, lastAdvertAt, advertCount, networks[]]
// advertCount === 0 marks imported (map.meshcore.io) directory nodes that carry
// no network membership; live nodes always have advertCount >= 1.

const NODE_TYPE_NAMES = { 1: 'chat', 2: 'repeater', 3: 'room', 4: 'sensor' };

function tupleToFeature([pubkey, name, type, lat, lon, lastAdvertAt, advertCount, networks, freq]) {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: {
      cluster: false,
      pubkey,
      name,
      type,
      typeName: NODE_TYPE_NAMES[type] ?? 'unknown',
      lastAdvertAt,
      advertCount,
      networks: Array.isArray(networks) ? networks : [],
      imported: advertCount === 0,
      // Imported (unsigned) nodes carry their own radio frequency (MHz) but no
      // network membership; live nodes get 0 and band via their networks.
      freq: Number.isFinite(freq) ? freq : 0,
      band: '' // filled in by loadSnapshot once the network/band catalogs load
    }
  };
}

// Memoised promise for the current snapshot's feature array. Invalidated when a
// newer snapshot URL is detected (latest.json poll interval is 30 s server-side).
let cachedSnapshotURL = '';
let snapshotPromise = null;

async function loadSnapshot() {
  const manifestRes = await fetch(`${API_BASE}/api/snapshots/latest.json`);
  if (!manifestRes.ok) throw new Error(`snapshot manifest ${manifestRes.status}`);
  const manifest = await manifestRes.json();
  // Resolve relative URLs (no origin configured on the server) against the API base.
  const url = manifest.url.startsWith('/')
    ? `${API_BASE}${manifest.url}`
    : manifest.url;

  // Re-use the in-flight/resolved promise as long as the snapshot URL hasn't
  // changed.  A new publish invalidates the cache so the map picks up fresh
  // nodes on the next allNodes() call (triggered by a page reload or a future
  // auto-refresh).
  if (url === cachedSnapshotURL && snapshotPromise) return snapshotPromise;

  cachedSnapshotURL = url;
  snapshotPromise = (async () => {
    // The browser automatically decompresses the zstd body (Chrome 123+,
    // Firefox 126+, Safari 17.4+) and applies the immutable cache entry. The
    // network catalog is fetched in parallel so we can assign each node a band
    // id (live: via its networks; imported: via its own radio frequency).
    const [res, netCatalog] = await Promise.all([fetch(url), meshNetworks().catch(() => ({}))]);
    if (!res.ok) throw new Error(`snapshot ${res.status}`);
    const payload = await res.json();
    const features = (payload.nodes ?? []).map(tupleToFeature);
    for (const f of features) {
      f.properties.band = nodeBandId(f.properties.networks, netCatalog, f.properties.freq);
    }
    return features;
  })();
  return snapshotPromise;
}

/**
 * Every GPS node as a GeoJSON FeatureCollection, loaded from the versioned
 * snapshot and memoised for the page lifetime.  Filters and clustering are
 * applied entirely client-side so no further node requests are made as the
 * user pans, zooms or changes filters.
 * @returns {Promise<{type:string,features:any[]}>}
 */
export async function allNodes() {
  const features = await loadSnapshot();
  return { type: 'FeatureCollection', features };
}

/**
 * GPS nodes within a bounding box, derived from the same snapshot as
 * {@link allNodes}.  Used for the first paint: the viewport subset is ready as
 * soon as the snapshot arrives; {@link allNodes} reuses the same promise so the
 * "replace viewport with world" step is a no-op after the first call.
 * @param {[number,number,number,number]} bbox west,south,east,north
 * @returns {Promise<{type:string,features:any[]}>}
 */
export async function viewportNodes(bbox) {
  const features = await loadSnapshot();
  const [west, south, east, north] = bbox;
  return {
    type: 'FeatureCollection',
    features: features.filter(({ geometry: { coordinates: [lon, lat] } }) =>
      lon >= west && lon <= east && lat >= south && lat <= north
    )
  };
}

// --- links, route, live feed, areas, networks --------------------------------

/**
 * Observed links for one node.
 * @param {string} pubkey
 * @param {object} [opts]
 * @param {string} [opts.net]
 * @param {string} [opts.active]
 * @param {number} [opts.limit]
 * @param {AbortSignal} [signal]
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

/**
 * Best-effort route between two nodes over the observed-link graph.
 * @param {string} from
 * @param {string} to
 * @param {object} [opts]
 * @param {string} [opts.net]
 * @param {string} [opts.active]
 * @param {AbortSignal} [signal]
 */
export function routeQuery(from, to, { net, active } = {}, signal) {
  const sp = new URLSearchParams({ from, to });
  if (net) sp.set('networks', net);
  if (active && active !== 'all') sp.set('active', active);
  const url = `${API_BASE}/api/route?${sp.toString()}`;
  return fetch(url, { signal }).then((r) => {
    if (!r.ok) throw new Error(`route api ${r.status}`);
    return r.json();
  });
}

/**
 * Subscribe to the live advert feed over a WebSocket.  Reconnects with capped
 * backoff.  Returns a disposer that closes the socket and stops reconnecting.
 * @param {(advert:object)=>void} onAdvert
 * @param {object} [opts]
 * @param {(open:boolean)=>void} [opts.onStatus]
 * @returns {()=>void}
 */
export function liveAdverts(onAdvert, { onStatus } = {}) {
  if (typeof WebSocket === 'undefined') return () => {};
  const url = `${API_BASE.replace(/^http/, 'ws')}/api/live`;
  let ws;
  let closed = false;
  let backoff = 1000;
  let retryTimer;

  const connect = () => {
    if (closed) return;
    ws = new WebSocket(url);
    ws.onopen = () => {
      backoff = 1000;
      onStatus?.(true);
    };
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg && msg.kind === 'advert') onAdvert(msg);
    };
    ws.onclose = () => {
      onStatus?.(false);
      if (closed) return;
      retryTimer = setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 15000);
    };
    ws.onerror = () => ws.close();
  };

  connect();
  return () => {
    closed = true;
    clearTimeout(retryTimer);
    ws?.close();
  };
}

const AREAS_ORIGIN = (import.meta.env?.VITE_AREAS_ORIGIN || 'https://meshcore.ninja').replace(
  /\/+$/,
  ''
);
let areasPromise;
/** The combined network-area FeatureCollection (memoised). */
export function networkAreas() {
  if (!areasPromise) {
    areasPromise = fetch(`${AREAS_ORIGIN}/network-area/all.geojson`)
      .then((r) => (r.ok ? r.json() : { type: 'FeatureCollection', features: [] }))
      .catch(() => ({ type: 'FeatureCollection', features: [] }));
  }
  return areasPromise;
}

// Origin of the MeshCore Ninja catalog that publishes networks.json + bands.json
// (network metadata and LoRa band definitions). Overridable for local testing.
const CATALOG_ORIGIN = (import.meta.env?.VITE_CATALOG_ORIGIN || 'https://meshcore.ninja').replace(
  /\/+$/,
  ''
);

let meshNetworksPromise;
/**
 * The full network catalog from the site's networks.json (a flat array), keyed
 * by network id, so each network chip can show its flag(s), name and derive the
 * node's band. Fetched once and memoised; failures resolve to an empty map.
 * @returns {Promise<Record<string, any>>}
 */
export function meshNetworks() {
  if (!meshNetworksPromise) {
    meshNetworksPromise = fetch(`${CATALOG_ORIGIN}/networks.json`)
      .then((r) => (r.ok ? r.json() : []))
      .then((list) => Object.fromEntries((Array.isArray(list) ? list : []).map((n) => [n.id, n])))
      .catch(() => ({}));
  }
  return meshNetworksPromise;
}

let bandsPromise;
/**
 * The LoRa band catalog from the site's bands.json, keyed by band id (e.g. "868",
 * "915"), each `{name, range, region, color}`. Used to render a node's band
 * badge. Fetched once and memoised; failures resolve to an empty map.
 * @returns {Promise<Record<string, {name:string,range:string,region:string,color:string}>>}
 */
export function bands() {
  if (!bandsPromise) {
    bandsPromise = fetch(`${CATALOG_ORIGIN}/bands.json`)
      .then((r) => (r.ok ? r.json() : {}))
      .then((d) => (d && typeof d === 'object' ? d : {}))
      .catch(() => ({}));
  }
  return bandsPromise;
}

let networksPromise;
/**
 * The network list (id + name), used to label the network filter.  Fetched
 * once and memoised; failures resolve to an empty list.
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
