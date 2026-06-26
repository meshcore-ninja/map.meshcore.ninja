<script>
  import { onMount, onDestroy, untrack } from 'svelte';
  import maplibregl from 'maplibre-gl';
  import 'maplibre-gl/dist/maplibre-gl.css';
  import { allNodes, viewportNodes, networkAreas, nodeLinks } from '$lib/api.js';
  import { makeNodePredicate, TYPE_COLOR, DEFAULT_COLOR } from '$lib/filters.js';
  import { basemapTiles, basemapAttribution } from '$lib/basemaps.js';

  let {
    view, // initial { z, lat, lon }
    theme = 'dark',
    basemap = 'auto', // tile layer id (see $lib/basemaps.js)
    filters, // { types:number[], net, active, q }
    clustering = true,
    showImported = true,
    showAreas = false,
    globe = false, // 3D globe projection vs. flat mercator
    selected = '',
    links = [], // observed links for the selected node (from /api/nodes/{pk}/links)
    linksLoading = false, // selected-node link request is in flight
    linkColor = '#c678dd', // configurable colour for the drawn link lines
    networkNames = {}, // network id -> short display name
    hoveredNeighbor = '', // pubkey of a link the panel is hovering, to highlight on the map
    route = null, // computed route to draw: { found, nodes:[{lat,lon,...}], hops:[] }
    onselect = () => {},
    onhover = () => {}, // pubkey under the cursor changed (drives route fetching)
    onmove = () => {},
    onstatus = () => {},
    onready = () => {}
  } = $props();

  let container;
  let map;
  let ready = $state(false);

  // Leader-line overlay (DOM-manipulated each frame, not via reactivity).
  let leaderSvg, leaderLine, leaderDot, leaderAnchor;

  // Hover state: highlighted node + its name label, plus a delayed link preview.
  let hoverPk = $state(''); // pubkey of the node under the cursor
  let hoverLinks = []; // links fetched for the hovered node (preview only)
  let hoverCtl; // AbortController for the in-flight hover link request
  let hoverTimer; // dwell timer for hover link fetches
  let hoverLabel, hoverLabelText, hoverLabelNetworks; // DOM nodes for the name tooltip
  let renderedHoverPk = '';
  let hoverProgress; // DOM node for the two-second circular dwell indicator

  const HOVER_LINK_DELAY = 250;

  // Loaded-once data, kept in component scope so theme restyles and clustering
  // toggles never refetch.
  let rawFeatures = []; // all node features (GeoJSON)
  let byPubkey = new Map(); // pubkey -> clean properties (arrays intact)
  let fullLoaded = false; // true once the whole-world set has replaced the viewport subset
  let areasData = null; // network-area FeatureCollection (lazy)
  let lastQ = '';
  let focusSel = '';

  const EMPTY = { type: 'FeatureCollection', features: [] };
  const NODE_LAYERS = ['clusters', 'cluster-count', 'node-hover', 'node-selected', 'nodes'];
  const LINK_LAYERS = ['node-links', 'node-links-hover'];
  const ROUTE_LAYERS = ['route-line-casing', 'route-line', 'route-nodes'];
  const NODE_CLICK_GUARD_PX = 8;
  const NETWORK_COLORS = [
    '#5aa9ff',
    '#ff6b6b',
    '#ffd43b',
    '#69db7c',
    '#da77f2',
    '#ff922b',
    '#22b8cf',
    '#f06595',
    '#94d82d',
    '#748ffc',
    '#e599f7',
    '#63e6be'
  ];

  function networkColor(id) {
    let hash = 0;
    for (const ch of String(id ?? '')) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    return NETWORK_COLORS[hash % NETWORK_COLORS.length];
  }

  function colorizeAreas(fc) {
    return {
      ...fc,
      features: (fc?.features ?? []).map((f) => ({
        ...f,
        properties: {
          ...f.properties,
          networkColor: networkColor(f.properties?.networkId)
        }
      }))
    };
  }

  // --- basemap ---------------------------------------------------------------
  // Tile templates and attribution come from $lib/basemaps.js. On high-DPI
  // screens those request double-resolution ("@2x") tiles; declared with
  // tileSize:256 here, MapLibre packs the larger image into a 256 CSS-px slot so
  // the basemap stays sharp instead of upscaling a 256px tile.
  function basemapStyle(id, t) {
    return {
      version: 8,
      glyphs: 'https://fonts.openmaptiles.org/{fontstack}/{range}.pbf',
      sources: {
        carto: {
          type: 'raster',
          tiles: basemapTiles(id, t),
          tileSize: 256,
          attribution: basemapAttribution(id)
        }
      },
      layers: [{ id: 'basemap', type: 'raster', source: 'carto' }]
    };
  }

  const typeColorExpr = ['match', ['get', 'type']];
  for (const [t, c] of Object.entries(TYPE_COLOR)) typeColorExpr.push(Number(t), c);
  typeColorExpr.push(DEFAULT_COLOR);

  // --- network-area overlay --------------------------------------------------
  function ensureAreas() {
    if (!areasData || map.getSource('areas')) return;
    const beforeId = map.getLayer('clusters') ? 'clusters' : map.getLayer('nodes') ? 'nodes' : undefined;
    map.addSource('areas', { type: 'geojson', data: areasData });
    map.addLayer(
      {
        id: 'area-fill',
        type: 'fill',
        source: 'areas',
        paint: { 'fill-color': ['get', 'networkColor'], 'fill-opacity': 0.08 }
      },
      beforeId
    );
    map.addLayer(
      {
        id: 'area-line',
        type: 'line',
        source: 'areas',
        paint: {
          'line-color': ['get', 'networkColor'],
          'line-opacity': 0.95,
          'line-width': 6,
          'line-blur': 0.8
        }
      },
      beforeId
    );
    updateAreas();
  }
  // Networks associated with the selected or hovered node, used to frame their
  // coverage without changing the visibility of any other map nodes.
  function selectedNetworks() {
    if (!selected) return [];
    const n = byPubkey.get(selected);
    return n?.networks ?? [];
  }

  function hoveredNetworks() {
    if (!hoverPk) return [];
    const n = byPubkey.get(hoverPk);
    return n?.networks ?? [];
  }

  function updateAreas() {
    if (!map.getLayer('area-fill')) return;
    const selNets = selectedNetworks();
    const hoverNets = hoveredNetworks();
    const framedNets = selNets.length ? selNets : hoverNets;
    // While a node is selected, frame its network area(s) even if the toggle is
    // off. Hovering previews only the border for that node's network(s).
    const vis = showAreas || framedNets.length ? 'visible' : 'none';
    let filter = null;
    if (framedNets.length) filter = ['in', ['get', 'networkId'], ['literal', framedNets]];
    else if (filters.net) filter = ['==', ['get', 'networkId'], filters.net];
    for (const id of ['area-fill', 'area-line']) {
      map.setLayoutProperty(id, 'visibility', vis);
      map.setFilter(id, filter);
    }
    // Selection and hover use the same border-only treatment. The fill belongs
    // only to the explicit persistent coverage-area toggle.
    map.setPaintProperty('area-fill', 'fill-opacity', showAreas ? 0.08 : 0);
  }

  // --- observed-link source + layers -----------------------------------------
  // One reusable GeoJSON source holds the selected node's drawable links as
  // straight LineStrings. Added before the node layers so the dots draw on top.
  function ensureLinks() {
    if (map.getSource('node-links')) return;
    map.addSource('node-links', { type: 'geojson', data: EMPTY });
    map.addLayer({
      id: 'node-links',
      type: 'line',
      source: 'node-links',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': linkColor,
        // Width scales with log1p(recentActivity) (precomputed per feature),
        // opacity with recency — recent, busy links read strongest.
        'line-width': ['get', 'width'],
        'line-opacity': ['interpolate', ['linear'], ['get', 'recency'], 0, 0.18, 1, 0.85]
      }
    });
    // Hover highlight: a single layer filtered to the hovered neighbor, drawn
    // thicker/opaque. No per-frame animation, so it costs nothing at rest.
    map.addLayer({
      id: 'node-links-hover',
      type: 'line',
      source: 'node-links',
      filter: ['==', ['get', 'neighbor'], hoveredNeighbor || ' '],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        // Fixed blue to match the detail box's border, so a hovered link reads as
        // "the one tied to this panel row" regardless of the chosen link colour.
        'line-color': '#5aa9ff',
        'line-width': ['+', ['get', 'width'], 2.5],
        'line-opacity': 1
      }
    });
  }

  function teardownLinks() {
    for (const id of LINK_LAYERS) if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource('node-links')) map.removeSource('node-links');
  }

  // Draw link LineStrings from one origin node to its neighbours. Only neighbours
  // with GPS are drawable; the rest still show in the panel list.
  function setLinkLines(originPk, linkList) {
    if (!ready || !map.getSource('node-links')) return;
    const origin = originPk ? byPubkey.get(originPk) : null;
    if (!origin || !Number.isFinite(origin.lon) || !Number.isFinite(origin.lat)) {
      map.getSource('node-links').setData(EMPTY);
      return;
    }
    const now = Date.now() / 1000;
    const features = [];
    for (const l of linkList ?? []) {
      const nb = l.neighbor;
      if (!nb?.hasGps || !Number.isFinite(nb.lat) || !Number.isFinite(nb.lon)) continue;
      const ageDays = Math.max(0, (now - (l.lastSeen ?? 0)) / 86400);
      const recency = Math.exp(-ageDays / 7); // ~1 week falloff
      const width = Math.min(6, Math.max(1.2, Math.log1p(l.recentActivity ?? 0) * 1.6));
      features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [[origin.lon, origin.lat], [nb.lon, nb.lat]] },
        properties: { neighbor: nb.pubkey, width, recency }
      });
    }
    map.getSource('node-links').setData({ type: 'FeatureCollection', features });
  }

  // Selection draws the link set supplied by the parent; a hover (when nothing is
  // selected) previews the hovered node's links fetched on the fly.
  function buildLinkFeatures() {
    if (selected) setLinkLines(selected, links);
    else setLinkLines(hoverPk, hoverLinks);
  }

  // --- computed-route source + layers ----------------------------------------
  // The route the parent computed (selected node → hovered node) is drawn as a
  // distinct amber path on top of the observed links: a dark casing for contrast
  // against any basemap, the amber line itself, then dots on the intermediate
  // relay nodes. Added after the links so it always reads as "the highlighted
  // path", and before the node dots so endpoints stay clickable.
  function ensureRoute() {
    if (map.getSource('route')) return;
    map.addSource('route', { type: 'geojson', data: EMPTY });
    map.addLayer({
      id: 'route-line-casing',
      type: 'line',
      source: 'route',
      filter: ['==', ['geometry-type'], 'LineString'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#11161f', 'line-width': 7, 'line-opacity': 0.85 }
    });
    map.addLayer({
      id: 'route-line',
      type: 'line',
      source: 'route',
      filter: ['==', ['geometry-type'], 'LineString'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#ffb454', 'line-width': 3.5, 'line-opacity': 0.95 }
    });
    map.addLayer({
      id: 'route-nodes',
      type: 'circle',
      source: 'route',
      filter: ['==', ['geometry-type'], 'Point'],
      paint: {
        'circle-radius': 4,
        'circle-color': '#ffb454',
        'circle-stroke-color': '#11161f',
        'circle-stroke-width': 1.5
      }
    });
  }

  function teardownRoute() {
    for (const id of ROUTE_LAYERS) if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource('route')) map.removeSource('route');
  }

  // Draw the route as per-hop segments plus relay dots. Drawing segment by segment
  // (rather than one polyline through every node) means a hop whose endpoint has no
  // GPS simply breaks the line there instead of drawing a misleading straight chord
  // across it. Relay dots mark the intermediate nodes only — the endpoints already
  // carry the selection halo and the hover ring.
  function setRouteLine(r) {
    if (!ready || !map.getSource('route')) return;
    const nodes = r?.found ? r.nodes ?? [] : [];
    const features = [];
    for (let i = 0; i < nodes.length - 1; i++) {
      const a = nodes[i];
      const b = nodes[i + 1];
      if (
        Number.isFinite(a?.lon) && Number.isFinite(a?.lat) &&
        Number.isFinite(b?.lon) && Number.isFinite(b?.lat)
      ) {
        features.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: [[a.lon, a.lat], [b.lon, b.lat]] },
          properties: {}
        });
      }
    }
    for (let i = 1; i < nodes.length - 1; i++) {
      const n = nodes[i];
      if (Number.isFinite(n?.lon) && Number.isFinite(n?.lat)) {
        features.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [n.lon, n.lat] },
          properties: {}
        });
      }
    }
    map.getSource('route').setData({ type: 'FeatureCollection', features });
  }

  function stopHoverPreview(clearLines = false) {
    clearTimeout(hoverTimer);
    hoverCtl?.abort();
    hoverCtl = undefined;
    hoverLinks = [];
    if (hoverProgress) {
      hoverProgress.style.display = 'none';
      hoverProgress.classList.remove('is-running', 'is-loading', 'is-loaded');
    }
    if (clearLines) setLinkLines('', []);
  }

  function startHoverProgress() {
    if (!hoverProgress) return;
    hoverProgress.style.display = '';
    hoverProgress.classList.remove('is-running', 'is-loading', 'is-loaded');
    // Flush the class removal so re-entering a node restarts the CSS animation.
    void hoverProgress.offsetWidth;
    hoverProgress.classList.add('is-running');
  }

  function scheduleHoverPreview(pk) {
    // Never touch the selected node's lines while hover previews are disabled.
    stopHoverPreview(!selected);
    if (!pk || selected) return;

    // Imported directory nodes have no observed-link data. Show the completed
    // hover circle immediately and skip the API request entirely.
    if (byPubkey.get(pk)?.imported) {
      hoverProgress.style.display = '';
      hoverProgress.classList.add('is-loaded');
      return;
    }

    setLinkLines('', []); // clear stale preview until the new one arrives
    startHoverProgress();
    hoverTimer = setTimeout(() => {
      if (hoverProgress) {
        hoverProgress.classList.remove('is-running');
        hoverProgress.classList.add('is-loading');
      }
      hoverCtl = new AbortController();
      nodeLinks(pk, { net: filters.net, active: filters.active }, hoverCtl.signal)
        .then((d) => {
          if (hoverPk === pk && !selected) {
            hoverLinks = d.links ?? [];
            setLinkLines(pk, hoverLinks);
            if (hoverProgress) {
              hoverProgress.classList.remove('is-loading');
              hoverProgress.classList.add('is-loaded');
            }
          }
        })
        .catch((e) => {
          if (e?.name !== 'AbortError' && hoverPk === pk && !selected && hoverProgress) {
            hoverProgress.style.display = 'none';
            hoverProgress.classList.remove('is-running', 'is-loading', 'is-loaded');
          }
        });
    }, HOVER_LINK_DELAY);
  }

  // Hover over a node: highlight it and show its name immediately. Link previews
  // require a short dwell, and are disabled while a node is selected.
  function onHoverNode(pk) {
    if (pk === hoverPk) return;
    hoverPk = pk;
    onhover(pk); // let the parent compute a route from the selected node to here
    scheduleHoverPreview(pk);
  }

  function renderHoverTooltip(pk, node) {
    if (pk === renderedHoverPk) return;
    renderedHoverPk = pk;
    hoverLabelText.textContent = node.name || 'Unnamed node';
    hoverLabelNetworks.replaceChildren();
    for (const net of node.networks ?? []) {
      const item = document.createElement('span');
      item.className = 'hover-network';
      item.title = networkNames[net] ?? net;
      const dot = document.createElement('i');
      dot.style.background = networkColor(net);
      const label = document.createElement('span');
      label.textContent = networkNames[net] ?? net;
      item.append(dot, label);
      hoverLabelNetworks.append(item);
    }
    hoverLabelNetworks.style.display = node.networks?.length ? '' : 'none';
  }

  // Position the hover name and progress indicator above their nodes each frame.
  function updateHoverUi() {
    if (!hoverLabel || !hoverProgress) return;
    const n = hoverPk ? byPubkey.get(hoverPk) : null;
    if (!ready || !n || !Number.isFinite(n.lon) || !Number.isFinite(n.lat)) {
      hoverLabel.style.display = 'none';
    } else {
      const p = map.project([n.lon, n.lat]);
      renderHoverTooltip(hoverPk, n);
      hoverLabel.style.left = `${p.x}px`;
      hoverLabel.style.top = `${p.y}px`;
      hoverLabel.style.display = '';
    }

    const progressPk = selected && linksLoading ? selected : hoverPk;
    const progressNode = progressPk ? byPubkey.get(progressPk) : null;
    if (progressNode && Number.isFinite(progressNode.lon) && Number.isFinite(progressNode.lat)) {
      const p = map.project([progressNode.lon, progressNode.lat]);
      hoverProgress.style.left = `${p.x}px`;
      hoverProgress.style.top = `${p.y}px`;
    }
  }

  // --- node source + layers --------------------------------------------------
  function ensureNodes() {
    map.addSource('nodes', {
      type: 'geojson',
      data: EMPTY,
      cluster: clustering,
      clusterRadius: 55,
      clusterMaxZoom: 14
    });

    map.addLayer({
      id: 'clusters',
      type: 'circle',
      source: 'nodes',
      filter: ['has', 'point_count'],
      paint: {
        'circle-color': '#4dd0a7',
        'circle-opacity': 0.85,
        'circle-stroke-color': '#0d1117',
        'circle-stroke-width': 1.5,
        'circle-radius': ['step', ['get', 'point_count'], 15, 25, 19, 100, 24, 1000, 32]
      }
    });
    map.addLayer({
      id: 'cluster-count',
      type: 'symbol',
      source: 'nodes',
      filter: ['has', 'point_count'],
      layout: {
        'text-field': ['get', 'point_count_abbreviated'],
        'text-font': ['Noto Sans Bold'],
        'text-size': 12,
        'text-allow-overlap': true
      },
      paint: { 'text-color': '#0d1117' }
    });
    map.addLayer({
      id: 'nodes',
      type: 'circle',
      source: 'nodes',
      filter: ['!', ['has', 'point_count']],
      layout: {
        // Draw our (live) nodes above the imported ones (higher sort key = on top).
        'circle-sort-key': ['case', ['==', ['get', 'imported'], true], 0, 1]
      },
      paint: {
        // Externally-mirrored (map.meshcore.io) nodes render grey; live nodes by type.
        'circle-color': ['case', ['==', ['get', 'imported'], true], DEFAULT_COLOR, typeColorExpr],
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 3.5, 12, 7],
        'circle-stroke-color': '#0d1117',
        'circle-stroke-width': 1
      }
    });
    // Hover halo: the animated SVG overlay supplies the visible progress ring.
    // Keep only a faint fill here; a solid MapLibre stroke underneath would make
    // the timer arc look like a permanently complete circle.
    map.addLayer({
      id: 'node-hover',
      type: 'circle',
      source: 'nodes',
      filter: ['==', ['get', 'pubkey'], hoverPk || ' '],
      paint: {
        'circle-radius': 10,
        'circle-color': '#5aa9ff',
        'circle-opacity': 0.12,
        'circle-stroke-color': '#5aa9ff',
        'circle-stroke-width': 0
      }
    });
    // Selection halo added last so it draws on top of every node, never hidden
    // beneath the dot it highlights.
    map.addLayer({
      id: 'node-selected',
      type: 'circle',
      source: 'nodes',
      filter: ['==', ['get', 'pubkey'], selected || ' '],
      paint: {
        'circle-radius': 13,
        'circle-color': '#5aa9ff',
        'circle-opacity': 0.35,
        'circle-stroke-color': '#5aa9ff',
        'circle-stroke-width': 2
      }
    });
  }

  function teardownNodes() {
    for (const id of NODE_LAYERS) if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource('nodes')) map.removeSource('nodes');
  }

  // Recreate the node source when clustering toggles (MapLibre can't flip the
  // cluster flag on a live source).
  function rebuildNodes() {
    (globalThis.__mlog ??= []).push('rebuildNodes');
    if (!ready) return;
    teardownNodes();
    ensureNodes();
    applyFilter(true);
  }

  // Swap in a node set (viewport subset first, then the whole world) and render
  // it if the map is ready.
  function setFeatures(features) {
    rawFeatures = features;
    // Keep the coordinates alongside the properties — features carry them in
    // `geometry`, but the detail panel and flyToSelected look them up by pubkey.
    byPubkey = new Map(
      features.map((f) => [
        f.properties.pubkey,
        { ...f.properties, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] }
      ])
    );
    if (ready) applyFilter(true);
  }

  // Filter the in-memory node set and push it to the source. No network I/O.
  function applyFilter(force = false) {
    (globalThis.__mlog ??= []).push('applyFilter');
    if (!ready || !map.getSource('nodes')) return;
    const keep = makeNodePredicate({ ...filters, imported: showImported });
    const features = rawFeatures.filter((f) => keep(f.properties));
    const byType = {};
    for (const f of features) {
      const t = f.properties.type;
      byType[t] = (byType[t] ?? 0) + 1;
    }
    // Whole-DB split (independent of filters): our live-observed nodes vs the
    // mirrored map.meshcore.io directory.
    let ours = 0;
    let imported = 0;
    for (const f of rawFeatures) {
      if (f.properties.imported) imported++;
      else ours++;
    }
    map.getSource('nodes').setData({ type: 'FeatureCollection', features });
    onstatus({ loading: false, total: rawFeatures.length, shown: features.length, byType, ours, imported });
    if (filters.q && (filters.q !== lastQ || force) && features.length) fitToFeatures(features);
    lastQ = filters.q;
  }

  function fitToFeatures(features) {
    const b = new maplibregl.LngLatBounds();
    for (const f of features) b.extend(f.geometry.coordinates);
    if (!b.isEmpty()) map.fitBounds(b, { padding: 120, maxZoom: 12, duration: 600 });
  }

  function flyToSelected() {
    if (!focusSel) return;
    const f = byPubkey.get(focusSel);
    if (f && Number.isFinite(f.lon) && Number.isFinite(f.lat)) {
      map.flyTo({ center: [f.lon, f.lat], zoom: Math.max(map.getZoom(), 12), duration: 600 });
      onselect(f); // populate the detail panel for the URL-restored node
      focusSel = '';
    }
  }

  // --- leader line: detail box → selected node -------------------------------
  // Builds a technical-drawing dog-leg: a short stub leaving the box edge
  // perpendicular (so it never runs along the border), then a 45° diagonal to
  // the node. The edge is whichever one most directly faces the node, anchored
  // at the middle of its on-screen portion. vw/vh are the map container size.
  function leaderPath(box, vw, vh, px, py) {
    const { left, right, top, bottom } = box;
    const midX = (Math.max(left, 0) + Math.min(right, vw)) / 2; // visible middle
    const midY = (Math.max(top, 0) + Math.min(bottom, vh)) / 2;
    const edges = [
      { ax: left, ay: midY, hor: true, out: -1 }, // left edge, stub leaves left
      { ax: right, ay: midY, hor: true, out: 1 }, // right edge, stub right
      { ax: midX, ay: top, hor: false, out: -1 }, // top edge, stub up
      { ax: midX, ay: bottom, hor: false, out: 1 } // bottom edge, stub down
    ];
    // Pick the edge whose outward normal best aligns with the node direction.
    let best = edges[0];
    let bestScore = -Infinity;
    for (const e of edges) {
      const dx = px - e.ax;
      const dy = py - e.ay;
      const len = Math.hypot(dx, dy) || 1;
      const score = e.hor ? (dx / len) * e.out : (dy / len) * e.out;
      if (score > bestScore) {
        bestScore = score;
        best = e;
      }
    }
    const { ax, ay, hor, out } = best;
    const MIN_STUB = 12;
    let kx, ky;
    if (hor) {
      kx = ax + out * Math.max(MIN_STUB, Math.abs(px - ax) - Math.abs(py - ay));
      ky = ay;
    } else {
      kx = ax;
      ky = ay + out * Math.max(MIN_STUB, Math.abs(py - ay) - Math.abs(px - ax));
    }
    return { points: `${ax},${ay} ${kx},${ky} ${px},${py}`, ax, ay };
  }

  function updateLeader() {
    if (!leaderSvg) return;
    if (!ready || !selected) {
      leaderSvg.style.display = 'none';
      return;
    }
    const node = byPubkey.get(selected);
    const detail = document.getElementById('node-detail');
    if (!node || !detail || !Number.isFinite(node.lon) || !Number.isFinite(node.lat)) {
      leaderSvg.style.display = 'none';
      return;
    }
    const crect = container.getBoundingClientRect();
    const drect = detail.getBoundingClientRect();
    const p = map.project([node.lon, node.lat]);
    const left = drect.left - crect.left;
    const right = drect.right - crect.left;
    const top = drect.top - crect.top;
    const bottom = drect.bottom - crect.top;
    // Hide when the node sits behind the box — nothing to point at.
    if (p.x > left - 4 && p.x < right + 4 && p.y > top - 4 && p.y < bottom + 4) {
      leaderSvg.style.display = 'none';
      return;
    }
    const { points, ax, ay } = leaderPath(
      { left, right, top, bottom },
      crect.width,
      crect.height,
      p.x,
      p.y
    );
    leaderLine.setAttribute('points', points);
    leaderAnchor.setAttribute('cx', ax);
    leaderAnchor.setAttribute('cy', ay);
    leaderDot.setAttribute('cx', p.x);
    leaderDot.setAttribute('cy', p.y);
    leaderSvg.style.display = '';
  }

  // --- (re)build everything after style load -------------------------------
  function addAll() {
    ensureLinks(); // before nodes so link lines render beneath the node dots
    ensureRoute(); // above the links, below the node dots
    ensureNodes();
    if (areasData) ensureAreas();
    buildLinkFeatures();
    setRouteLine(route);
  }

  // Switch between the 3D globe and flat mercator projections. Projection is part
  // of the style, so it must be re-applied after every setStyle (basemap/theme
  // change) as well as on the reactive toggle.
  function applyProjection() {
    if (!map) return;
    map.setProjection({ type: globe ? 'globe' : 'mercator' });
  }

  function wireInteractions() {
    const pointer = (on) => () => (map.getCanvas().style.cursor = on ? 'pointer' : '');
    for (const id of ['clusters', 'nodes']) {
      map.on('mouseenter', id, pointer(true));
      map.on('mouseleave', id, pointer(false));
    }
    map.on('click', 'clusters', async (e) => {
      const f = e.features[0];
      try {
        const zoom = await map.getSource('nodes').getClusterExpansionZoom(f.properties.cluster_id);
        map.easeTo({ center: f.geometry.coordinates, zoom, duration: 500 });
      } catch (err) {
        /* ignore */
      }
    });
    map.on('click', 'nodes', (e) => {
      const pk = e.features[0].properties.pubkey;
      onselect(byPubkey.get(pk) ?? e.features[0].properties);
    });
    // Hover preview: highlight + name label + link lines for the node under the
    // cursor. mousemove tracks moving between overlapping dots.
    map.on('mousemove', 'nodes', (e) => onHoverNode(e.features[0]?.properties.pubkey ?? ''));
    map.on('mouseleave', 'nodes', () => onHoverNode(''));
    // Clicking a link line focuses the neighbor at its far end.
    map.on('mouseenter', 'node-links', pointer(true));
    map.on('mouseleave', 'node-links', pointer(false));
    map.on('click', 'node-links', (e) => {
      // Lines terminate beneath node dots and can have a generous rendered
      // hitbox. Give the node (plus a small safety margin) priority so a click
      // near an endpoint never unexpectedly jumps along the link.
      const p = e.point;
      const nearbyNodes = map.queryRenderedFeatures(
        [
          [p.x - NODE_CLICK_GUARD_PX, p.y - NODE_CLICK_GUARD_PX],
          [p.x + NODE_CLICK_GUARD_PX, p.y + NODE_CLICK_GUARD_PX]
        ],
        { layers: ['nodes', 'clusters'] }
      );
      if (nearbyNodes.length) return;

      const pk = e.features[0].properties.neighbor;
      onselect(byPubkey.get(pk) ?? null);
    });
    map.on('click', (e) => {
      // A click that hits neither a node, a cluster, nor a link line deselects.
      const hits = map.queryRenderedFeatures(e.point, { layers: ['nodes', 'clusters', 'node-links'] });
      if (!hits.length) onselect(null);
    });
  }

  onMount(async () => {
    map = new maplibregl.Map({
      container,
      style: basemapStyle(basemap, theme),
      center: [view.lon, view.lat],
      zoom: view.z,
      minZoom: 1,
      maxZoom: 18,
      attributionControl: false
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
    map.addControl(new maplibregl.GeolocateControl({ trackUserLocation: false }), 'bottom-right');
    // Attribution is rendered by the page (next to the layer switch) so it can be
    // styled to match the UI; see the bottom-left controls in +page.svelte.

    if (typeof window !== 'undefined') window.__map = map;
    focusSel = selected || '';
    map.on('moveend', () => {
      const c = map.getCenter();
      onmove({ z: map.getZoom(), lat: c.lat, lon: c.lng });
    });
    // Keep the leader line and hover UI glued to their nodes as the map moves.
    map.on('render', updateLeader);
    map.on('render', updateHoverUi);

    onstatus({ loading: true });

    // Progressive load: paint the current viewport first (fast), then replace it
    // with the whole-world set as soon as it arrives. A late viewport response
    // never clobbers the full set (fullLoaded guard).
    const b = map.getBounds();
    viewportNodes([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()])
      .then((fc) => {
        if (!fullLoaded) setFeatures(fc.features ?? []);
      })
      .catch(() => {});

    const dataReady = allNodes()
      .then((fc) => {
        fullLoaded = true;
        setFeatures(fc.features ?? []);
      })
      .catch(() => onstatus({ loading: false, error: true }));

    // Safety net: never trap the user behind the preloader if the map never
    // reaches an idle frame (e.g. a perpetual basemap retry).
    const readyFallback = setTimeout(() => onready(), 10000);

    map.on('load', async () => {
      addAll();
      wireInteractions();
      applyProjection();
      ready = true;
      applyFilter(true); // render whatever (viewport) data has arrived so far
      await dataReady;
      applyFilter(true); // ensure the full set is what gets rendered
      flyToSelected();
      // Reveal the app only once the map has finished rendering the full set.
      map.once('idle', () => {
        clearTimeout(readyFallback);
        onready();
      });
    });
  });

  onDestroy(() => {
    stopHoverPreview();
    map?.remove();
  });

  // --- reactive effects ------------------------------------------------------
  let filterKey = $derived(JSON.stringify([filters.types, filters.net, filters.active, filters.q, showImported]));
  $effect(() => {
    filterKey;
    if (ready) applyFilter();
  });

  // Rebuild the node source only when clustering toggles. rebuildNodes →
  // ensureNodes reads `selected` (for the halo layer filter), so without untrack
  // this effect would re-run on every selection and tear the whole source down —
  // making all nodes flash on each click.
  $effect(() => {
    clustering;
    if (!ready) return;
    untrack(() => rebuildNodes());
  });

  // Lazy-load and toggle the network-area overlay.
  $effect(() => {
    showAreas;
    filters.net;
    selected;
    hoverPk;
    if (!ready) return;
    // Selection and hover both frame coverage, so load area data on demand even
    // when the persistent coverage toggle is off.
    const want = showAreas || selectedNetworks().length > 0 || hoveredNetworks().length > 0;
    if (want && !areasData) {
      networkAreas().then((d) => {
        areasData = colorizeAreas(d);
        ensureAreas();
        updateAreas();
      });
    } else {
      ensureAreas();
      updateAreas();
    }
  });

  // Restyle when the chosen basemap or (for theme-following basemaps) the theme
  // changes. Comparing the resolved tile URL means a theme toggle on a
  // theme-independent basemap (Mapy) doesn't pointlessly rebuild the style. Data
  // layers are re-added once the new style loads.
  $effect(() => {
    basemap;
    theme;
    if (!ready || !map) return;
    const cur = map.getStyle()?.sources?.carto?.tiles?.[0] ?? '';
    const next = basemapTiles(basemap, theme)[0] ?? '';
    if (cur === next) return;
    (globalThis.__mlog ??= []).push('setStyle');
    map.setStyle(basemapStyle(basemap, theme));
    map.once('styledata', () => {
      if (!map.getSource('nodes')) {
        addAll();
        applyFilter(true);
      }
      applyProjection(); // setStyle resets projection to the style default
    });
  });

  // Toggle the globe/mercator projection live.
  $effect(() => {
    globe;
    if (ready) applyProjection();
  });

  // Move the selection halo and (re)draw the leader line on selection change.
  $effect(() => {
    selected;
    linksLoading;
    if (ready && map?.getLayer('node-selected')) {
      map.setFilter('node-selected', ['==', ['get', 'pubkey'], selected || ' ']);
    }
    if (ready) {
      // A selection owns the link layer. Other nodes still get their name
      // tooltip, but never a dwell animation or hover-link request.
      if (selected) {
        stopHoverPreview(false);
        if (linksLoading && hoverProgress) {
          hoverProgress.style.display = '';
          hoverProgress.classList.add('is-loading');
          requestAnimationFrame(updateHoverUi);
        }
      }
      else if (hoverPk) scheduleHoverPreview(hoverPk);
    }
    // The detail box may have just mounted/unmounted; redraw next frame.
    if (ready) requestAnimationFrame(updateLeader);
  });

  // Redraw link lines when the selection or its link set changes (the parent
  // clears `links` on deselect, so this also clears the source).
  $effect(() => {
    links;
    selected;
    if (ready) buildLinkFeatures();
  });

  // Redraw the computed route whenever the parent supplies a new one (or clears it
  // to null on deselect / when the cursor leaves a target node).
  $effect(() => {
    const r = route;
    if (ready) setRouteLine(r);
  });

  // Highlight the link line the panel is hovering. Read the reactive value first
  // so it is always tracked, even on runs where the layer isn't ready yet.
  $effect(() => {
    const hov = hoveredNeighbor;
    if (ready && map?.getLayer('node-links-hover')) {
      map.setFilter('node-links-hover', ['==', ['get', 'neighbor'], hov || ' ']);
    }
  });

  // Recolor link lines live when the chosen colour changes. Read linkColor first
  // so the effect tracks it regardless of whether the layer exists this run.
  $effect(() => {
    const col = linkColor;
    if (ready && map?.getLayer('node-links')) {
      map.setPaintProperty('node-links', 'line-color', col);
      // node-links-hover keeps its fixed blue.
    }
  });

  // Move the hover ring to the node under the cursor and refresh its label.
  $effect(() => {
    const pk = hoverPk;
    if (ready && map?.getLayer('node-hover')) {
      map.setFilter('node-hover', ['==', ['get', 'pubkey'], pk || ' ']);
    }
    if (ready) requestAnimationFrame(updateHoverUi);
  });
</script>

<div bind:this={container} class="absolute inset-0 h-full w-full"></div>
<!-- Leader line from the detail box to the selected node (above the map, below
     the detail box at z-30). Updated imperatively each frame. -->
<svg
  bind:this={leaderSvg}
  class="pointer-events-none absolute inset-0 h-full w-full"
  style="z-index:25;display:none"
  aria-hidden="true"
>
  <polyline
    bind:this={leaderLine}
    fill="none"
    stroke="#5aa9ff"
    stroke-width="1.5"
    stroke-dasharray="5 4"
    stroke-linecap="round"
    stroke-linejoin="round"
  />
  <circle bind:this={leaderAnchor} r="2.5" fill="#5aa9ff" />
  <circle bind:this={leaderDot} r="4" fill="none" stroke="#5aa9ff" stroke-width="1.5" />
</svg>

<!-- Hover name label: simple text with a small background and a downward arrow
     pointing at the node. Positioned imperatively each frame. -->
<div bind:this={hoverLabel} class="hover-label" style="display:none" aria-hidden="true">
  <span class="hover-label-name" bind:this={hoverLabelText}></span>
  <span class="hover-networks" bind:this={hoverLabelNetworks}></span>
</div>

<!-- Circular dwell progress. It only runs when no node is selected. -->
<svg
  bind:this={hoverProgress}
  class="hover-progress"
  style="display:none"
  viewBox="0 0 28 28"
  aria-hidden="true"
>
  <circle class="hover-progress-track" cx="14" cy="14" r="11"></circle>
  <circle class="hover-progress-value" cx="14" cy="14" r="11"></circle>
</svg>

<style>
  .hover-label {
    position: absolute;
    z-index: 26;
    transform: translate(-50%, calc(-100% - 14px));
    pointer-events: none;
    white-space: nowrap;
    padding: 2px 8px;
    border-radius: 6px;
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--color-ink);
    background: var(--color-elev);
    border: 1px solid var(--color-edge);
  }
  .hover-label-name {
    display: block;
  }
  .hover-networks {
    display: flex;
    justify-content: center;
    gap: 5px;
    margin-top: 2px;
    color: var(--color-dim);
    font-size: 0.62rem;
    font-weight: 500;
  }
  :global(.hover-network) {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    max-width: 90px;
  }
  :global(.hover-network i) {
    width: 6px;
    height: 6px;
    flex: none;
    border-radius: 50%;
  }
  :global(.hover-network span) {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* Downward arrow pointing at the node. */
  .hover-label::after {
    content: '';
    position: absolute;
    left: 50%;
    top: 100%;
    transform: translateX(-50%);
    border: 5px solid transparent;
    border-top-color: var(--color-elev);
  }
  .hover-progress {
    position: absolute;
    z-index: 26;
    width: 32px;
    height: 32px;
    transform: translate(-50%, -50%) rotate(-90deg);
    pointer-events: none;
    overflow: visible;
  }
  .hover-progress-track,
  .hover-progress-value {
    fill: none;
    stroke-width: 3;
  }
  .hover-progress-track {
    stroke: color-mix(in srgb, #5aa9ff 18%, transparent);
  }
  .hover-progress-value {
    stroke: #5aa9ff;
    stroke-linecap: round;
    stroke-dasharray: 69.12;
    stroke-dashoffset: 69.12;
  }
  :global(.hover-progress.is-running) .hover-progress-value {
    animation: hover-dwell 0.25s linear forwards;
  }
  :global(.hover-progress.is-loaded) .hover-progress-value {
    stroke-dashoffset: 0;
  }
  :global(.hover-progress.is-loading) .hover-progress-track {
    opacity: 0;
  }
  :global(.hover-progress.is-loading) .hover-progress-value {
    stroke-linecap: butt;
    stroke-dasharray: 8 5;
    stroke-dashoffset: 0;
    animation: hover-loading 0.7s linear infinite;
    transform-origin: 14px 14px;
  }
  @keyframes hover-dwell {
    to {
      stroke-dashoffset: 0;
    }
  }
  @keyframes hover-loading {
    to {
      transform: rotate(360deg);
    }
  }
</style>
