// Node-type metadata. Types mirror the API (1=chat, 2=repeater, 3=room,
// 4=sensor); colors are reused for the map markers, the legend and the filter
// chips so a node's role reads the same everywhere.
export const NODE_TYPES = [
  { id: 2, name: 'repeater', label: 'Repeaters', color: '#4dd0a7' },
  { id: 1, name: 'chat', label: 'Chats', color: '#5aa9ff' },
  { id: 3, name: 'room', label: 'Rooms', color: '#d29922' },
  { id: 4, name: 'sensor', label: 'Sensors', color: '#c678dd' }
];

export const TYPE_COLOR = Object.fromEntries(NODE_TYPES.map((t) => [t.id, t.color]));
export const TYPE_LABEL = Object.fromEntries(NODE_TYPES.map((t) => [t.id, t.name]));
export const DEFAULT_COLOR = '#9aa7b4';

// Recent-activity presets. `id` is what we put in the URL and send to the API as
// `active`; `all` drops the filter entirely.
export const ACTIVITY = [
  { id: 'all', label: 'All time' },
  { id: '24h', label: '24 hours' },
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' }
];

export function typeColor(type) {
  return TYPE_COLOR[type] ?? DEFAULT_COLOR;
}

const WINDOW_SECONDS = { '24h': 86400, '7d': 604800, '30d': 2592000 };

/** Lower bound (unix seconds) for an activity preset, or 0 for "all". */
export function activitySince(active) {
  const w = WINDOW_SECONDS[active];
  return w ? Math.floor(Date.now() / 1000) - w : 0;
}

/**
 * Client-side node filter. Applied to the full node set in the browser so
 * changing filters never re-hits the API. Properties come straight off the
 * GeoJSON feature.
 * @param {object} filters { types:number[], net, active, q }
 */
export function makeNodePredicate({ types, net, active, q }) {
  const typeSet = types?.length ? new Set(types) : null;
  const since = activitySince(active);
  const query = (q ?? '').toLowerCase();
  return (p) => {
    if (typeSet && !typeSet.has(p.type)) return false;
    if (since && (p.lastAdvertAt ?? 0) < since) return false;
    if (net) {
      const nets = Array.isArray(p.networks) ? p.networks : [];
      if (!nets.includes(net)) return false;
    }
    if (query) {
      const name = (p.name ?? '').toLowerCase();
      if (!name.includes(query) && !String(p.pubkey ?? '').startsWith(query)) return false;
    }
    return true;
  };
}
