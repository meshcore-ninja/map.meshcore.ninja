// Node-type metadata. Types mirror the API (1=companion, 2=repeater, 3=room,
// 4=sensor); colors are reused for the map markers, the legend and the filter
// chips so a node's role reads the same everywhere. `icon` holds the inner
// markup of a Lucide icon (24×24, stroke), inlined so we avoid an icon-library
// dependency on this static site.
export const NODE_TYPES = [
  {
    id: 2,
    name: 'repeater',
    label: 'Repeaters',
    color: '#4dd0a7',
    // lucide: radio-tower
    icon: '<path d="M4.9 16.1C1 12.2 1 5.8 4.9 1.9"/><path d="M7.8 4.7a6.14 6.14 0 0 0-.8 7.5"/><circle cx="12" cy="9" r="2"/><path d="M16.2 4.8c2 2 2.26 5.11.8 7.47"/><path d="M19.1 1.9a9.96 9.96 0 0 1 0 14.1"/><path d="M9.5 18h5"/><path d="m8 22 4-11 4 11"/>'
  },
  {
    id: 1,
    name: 'companion',
    label: 'Companions',
    color: '#5aa9ff',
    // lucide: smartphone
    icon: '<rect width="14" height="20" x="5" y="2" rx="2" ry="2"/><path d="M12 18h.01"/>'
  },
  {
    id: 3,
    name: 'room',
    label: 'Rooms',
    color: '#d29922',
    // lucide: messages-square
    icon: '<path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z"/><path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1"/>'
  },
  {
    id: 4,
    name: 'sensor',
    label: 'Sensors',
    color: '#c678dd',
    // lucide: thermometer
    icon: '<path d="M14 4v10.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0Z"/>'
  }
];

export const TYPE_COLOR = Object.fromEntries(NODE_TYPES.map((t) => [t.id, t.color]));
export const TYPE_LABEL = Object.fromEntries(NODE_TYPES.map((t) => [t.id, t.name]));
export const TYPE_ICON = Object.fromEntries(NODE_TYPES.map((t) => [t.id, t.icon]));
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
 * @param {object} filters { types:number[], net, active, q, imported }
 */
export function makeNodePredicate({ types, net, active, q, imported = true }) {
  const typeSet = types?.length ? new Set(types) : null;
  const since = activitySince(active);
  const query = (q ?? '').toLowerCase();
  return (p) => {
    if (!imported && p.imported) return false;
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
