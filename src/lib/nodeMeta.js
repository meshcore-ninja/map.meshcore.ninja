// Derive display metadata for a node from the network + band catalogs
// (networks.json / bands.json), plus a few small formatting helpers. Kept
// framework-free so it can be unit-reasoned and reused by the command palette
// and the detail panel.

/** Shorten a pubkey for display: "f6c957…15d0a0". */
export function shortKey(pubkey) {
  if (!pubkey || pubkey.length <= 14) return pubkey || '';
  return `${pubkey.slice(0, 6)}…${pubkey.slice(-6)}`;
}

/** Compact relative age, e.g. "now", "3m ago", "5h ago", "2d ago". */
export function agoLabel(unix, now = Date.now() / 1000) {
  if (!unix) return null;
  const s = Math.max(0, Math.floor(now - unix));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Coordinates as a short "lat, lon" string, or "" when absent. */
export function fmtCoords(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return '';
  return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
}

// A node counts as "stale" once we haven't heard a live advert from it in this
// long. Imported (unsigned) nodes never get the stale badge — they carry no
// advert history, only a map-publish timestamp.
export const STALE_SECONDS = 7 * 86400;

/**
 * Node status badges for list rows.
 *  - `unsigned`: an imported (map.meshcore.io) node with no live adverts; its
 *    timestamp is a self-reported map-publish time, not an observed advert.
 *  - `stale`: a live node we haven't heard from in over {@link STALE_SECONDS}.
 * @returns {{unsigned:boolean,stale:boolean}}
 */
export function nodeStatus(node, now = Date.now() / 1000) {
  const unsigned = !!node?.imported;
  const stale =
    !unsigned && !!node?.lastAdvertAt && now - node.lastAdvertAt > STALE_SECONDS;
  return { unsigned, stale };
}

// The band ids used as keys in bands.json, as numbers, for nearest-match
// classification of a precise radio frequency.
const BAND_IDS = [433, 470, 780, 865, 868, 915, 920, 923, 2400];

/**
 * Classify a precise radio frequency (MHz, e.g. 869.618) to a band id — the
 * string keys used in bands.json ("868", "915", …). Imported map.meshcore.io
 * nodes carry a `params.freq` but no network membership, so this is the only
 * way to band them. Returns '' when the frequency is missing or implausible.
 */
export function bandForFreq(mhz) {
  if (!Number.isFinite(mhz) || mhz <= 0) return '';
  let best = '';
  let bestDiff = Infinity;
  for (const id of BAND_IDS) {
    const diff = Math.abs(mhz - id);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = String(id);
    }
  }
  // Guard against wildly off frequencies landing on the nearest band anyway.
  return bestDiff <= 15 ? best : '';
}

/**
 * The single band id for a node: derived from its first network with a known
 * radio frequency (live nodes) or, failing that, from its own radio frequency
 * (imported/unsigned nodes). '' when unknown.
 */
export function nodeBandId(networkIds, networksCatalog, freqMHz) {
  for (const id of networkIds ?? []) {
    const freq = networksCatalog?.[id]?.radio?.frequency;
    if (freq != null) return String(freq);
  }
  return bandForFreq(freqMHz);
}

/** Resolve a band id to its display badge, or null when unknown. */
export function bandBadge(bandId, bandsCatalog) {
  const band = bandId ? bandsCatalog?.[String(bandId)] : null;
  return band?.region ? { region: band.region, color: band.color || '#9aa7b4' } : null;
}

/**
 * The band badge(s) for a node: unique LoRa regions across the networks it
 * belongs to, resolved via each network's radio frequency → bands.json. Falls
 * back to the node's own band id (from `params.freq`) when it has no networks,
 * so imported/unsigned nodes still show a band.
 * @returns {{region:string,color:string}[]}
 */
export function nodeBands(networkIds, networksCatalog, bandsCatalog, bandId = '') {
  const seen = new Map();
  for (const id of networkIds ?? []) {
    const freq = networksCatalog?.[id]?.radio?.frequency;
    const band = freq != null ? bandsCatalog?.[String(freq)] : null;
    if (band?.region && !seen.has(band.region)) {
      seen.set(band.region, { region: band.region, color: band.color || '#9aa7b4' });
    }
  }
  if (!seen.size) {
    const b = bandBadge(bandId, bandsCatalog);
    if (b) seen.set(b.region, b);
  }
  return [...seen.values()];
}

/**
 * The network chips for a node: resolved name + primary country flag per
 * network id, falling back to the raw id when the catalog lacks the entry.
 * @returns {{id:string,name:string,code:string}[]}
 */
export function nodeNetworkTags(networkIds, networksCatalog) {
  return (networkIds ?? []).map((id) => {
    const net = networksCatalog?.[id];
    return {
      id,
      name: net?.short_name || net?.name || id,
      code: net?.coverage?.countries?.[0] || ''
    };
  });
}
