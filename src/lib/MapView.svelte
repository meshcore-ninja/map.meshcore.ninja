<script>
  import { onMount, onDestroy, untrack } from 'svelte';
  import maplibregl from 'maplibre-gl';
  import 'maplibre-gl/dist/maplibre-gl.css';
  import { allNodes, viewportNodes, networkAreas, nodeLinks } from '$lib/api.js';
  import { makeNodePredicate, TYPE_COLOR, TYPE_ICON, DEFAULT_COLOR } from '$lib/filters.js';
  import { basemapTiles, basemapAttribution } from '$lib/basemaps.js';

  let {
    view, // initial { z, lat, lon }
    theme = 'dark',
    basemap = 'auto', // tile layer id (see $lib/basemaps.js)
    filters, // { types:number[], net, active, q }
    clustering = true,
    showImported = true,
    showAreas = false,
    colorByBand = false, // colour node dots by LoRa band instead of node type
    bandsCatalog = {}, // band id -> { region, color } (from bands.json)
    emphasizedNet = '', // network id to frame (from a search "open network")
    emphasizedAreaIds = [], // network ids whose coverage borders to emphasise (family)
    networkMemberIds = [], // network ids whose nodes to keep visible (family, or one on hover)
    globe = true, // 3D globe projection vs. flat mercator
    selected = '',
    links = [], // observed links for the selected node (from /api/nodes/{pk}/links)
    linksFor = '', // pubkey that the selected-node links belong to
    linksLoading = false, // selected-node link request is in flight
    linkColor = '#c678dd', // configurable colour for the drawn link lines
    networkNames = {}, // network id -> short display name
    areaPickIds = [], // network area ids that can be hovered/clicked
    areaRanks = {}, // network id -> comparable area size, used to pick smallest overlap
    hoveredNeighbor = '', // pubkey of a link the panel is hovering, to highlight on the map
    onselect = () => {},
    onselectnetwork = () => {},
    onhoverarea = () => {},
    onmove = () => {},
    onstatus = () => {},
    onready = () => {},
    onhoverlink = () => {} // hovering a link line on the map (pubkey of its neighbor, '' on leave)
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
  let hoverAreaId = $state('');

  const EMPTY = { type: 'FeatureCollection', features: [] };
  const NODE_LAYERS = ['clusters', 'cluster-count', 'node-hover', 'node-selected', 'nodes'];
  const LINK_LAYERS = ['node-links', 'node-links-hover'];
  const AREA_LAYERS = ['area-hit', 'area-hover-line', 'area-line', 'area-fill'];
  const LAYER_STACK = [
    'clusters',
    'cluster-count',
    'nodes',
    'node-hover',
    'node-selected',
    'node-links',
    'node-links-hover',
  ];

  // Re-assert the stack: moving each present layer to the top in order leaves the
  // last one on top. The network-area layers aren't listed, so they stay beneath.
  function restackLayers() {
    if (!map) return;
    for (const id of LAYER_STACK) if (map.getLayer(id)) map.moveLayer(id);
  }
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

  // Default node colouring: imported nodes grey, live nodes by type.
  const typeCircleColor = ['case', ['==', ['get', 'imported'], true], DEFAULT_COLOR, typeColorExpr];

  // Colouring by LoRa band: match the node's band id to its band colour, from
  // bands.json. Nodes with no resolved band fall back to grey.
  function bandCircleColor(catalog) {
    const expr = ['match', ['get', 'band']];
    for (const [id, band] of Object.entries(catalog ?? {})) {
      if (band?.color) expr.push(String(id), band.color);
    }
    if (expr.length === 2) return DEFAULT_COLOR; // no bands yet: solid grey
    expr.push(DEFAULT_COLOR);
    return expr;
  }

  // Repaint the node dots when the band toggle flips or the band catalog loads.
  $effect(() => {
    const color = colorByBand ? bandCircleColor(bandsCatalog) : typeCircleColor;
    if (ready && map?.getLayer('nodes')) map.setPaintProperty('nodes', 'circle-color', color);
  });

  // --- network-area overlay --------------------------------------------------
  function ensureAreas() {
    if (!areasData || map.getSource('areas')) return;
    const beforeId = map.getLayer('clusters') ? 'clusters' : map.getLayer('nodes') ? 'nodes' : undefined;
    map.addSource('areas', { type: 'geojson', data: areasData, promoteId: 'networkId' });
    // Always-on base outline: every network's coverage drawn as a faint, thin grey
    // stroke so the whole mesh landscape is visible by default. The colourful
    // per-network layers (emphasis / selection / hover) draw on top of this.
    map.addLayer(
      {
        id: 'area-base-line',
        type: 'line',
        source: 'areas',
        paint: {
          'line-color': '#8f9aa6',
          'line-opacity': 0.4,
          'line-width': 1.5,
          'line-blur': 0.4,
          'line-dasharray': [3, 2]
        }
      },
      beforeId
    );
    map.addLayer(
      {
        id: 'area-hit',
        type: 'fill',
        source: 'areas',
        paint: { 'fill-color': '#000000', 'fill-opacity': 0.001 }
      },
      beforeId
    );
    map.addLayer(
      {
        id: 'area-fill',
        type: 'fill',
        source: 'areas',
        paint: { 'fill-color': ['get', 'networkColor'], 'fill-opacity': 0 }
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
          'line-opacity': 0,
          'line-width': 4,
          'line-blur': 0.8
        }
      },
      beforeId
    );
    map.addLayer(
      {
        id: 'area-hover-line',
        type: 'line',
        source: 'areas',
        paint: {
          'line-color': '#8f9aa6',
          'line-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 0.62, 0],
          'line-width': 4,
          'line-blur': 0.8
        }
      },
      beforeId
    );
    updateAreas();
    if (hoverAreaId) setHoverArea(hoverAreaId, true);
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

    const idsOpacity = (ids, opacity) =>
      ids.length ? ['case', ['in', ['get', 'networkId'], ['literal', ids]], opacity, 0] : 0;

    // An explicitly opened network (from search) wins: frame only it, with a
    // bolder border and a faint fill so it reads as emphasised.
    if (emphasizedNet) {
      // Show the coverage borders of the whole family (the network plus its
      // subnetworks), so the subregion shapes are visible, not just the parent.
      const ids = emphasizedAreaIds.length ? emphasizedAreaIds : [emphasizedNet];
      for (const id of ['area-fill', 'area-line']) {
        map.setLayoutProperty(id, 'visibility', 'visible');
      }
      map.setPaintProperty('area-fill', 'fill-opacity', idsOpacity(ids, 0.12));
      map.setPaintProperty('area-line', 'line-width', 5);
      map.setPaintProperty('area-line', 'line-opacity', idsOpacity(ids, 1));
      map.setPaintProperty('area-line', 'line-blur', 0.4);
      return;
    }

    // Restore the default border styling (in case we were just emphasising one).
    map.setPaintProperty('area-line', 'line-width', 4);
    map.setPaintProperty('area-line', 'line-blur', 0.8);

    const selNets = selectedNetworks();
    const hoverNets = hoverAreaId ? [] : hoveredNetworks();
    const framedNets = selNets.length ? selNets : hoverNets;
    // While a node is selected, frame its network area(s) even if the toggle is
    // off. Hovering previews only the border for that node's network(s).
    for (const id of ['area-fill', 'area-line']) {
      map.setLayoutProperty(id, 'visibility', 'visible');
    }
    // Selection and hover use the same border-only treatment. The fill belongs
    // only to the explicit persistent coverage-area toggle.
    map.setPaintProperty('area-fill', 'fill-opacity', showAreas ? 0.08 : 0);
    if (framedNets.length) {
      map.setPaintProperty('area-line', 'line-opacity', idsOpacity(framedNets, 0.95));
    } else if (filters.net) {
      map.setPaintProperty('area-line', 'line-opacity', idsOpacity([filters.net], 0.95));
    } else {
      map.setPaintProperty('area-line', 'line-opacity', showAreas ? 0.95 : 0);
    }
  }

  function setHoverArea(id, force = false) {
    if (id === hoverAreaId && !force) {
      onhoverarea(id);
      return;
    }
    if (map?.getSource('areas') && hoverAreaId) {
      map.setFeatureState({ source: 'areas', id: hoverAreaId }, { hover: false });
    }
    hoverAreaId = id;
    if (map?.getSource('areas') && hoverAreaId) {
      map.setFeatureState({ source: 'areas', id: hoverAreaId }, { hover: true });
    }
    onhoverarea(id);
  }

  function pickedAreaId(point) {
    if (!map.getLayer('area-hit')) return '';
    const hits = map.queryRenderedFeatures(point, { layers: ['area-hit'] });
    let best = null;
    for (const hit of hits) {
      const id = hit.properties?.networkId ?? '';
      if (!id || !(id in areaRanks)) continue;
      const rank = areaRanks[id] ?? Number.POSITIVE_INFINITY;
      if (!best || rank < best.rank) best = { id, rank };
    }
    return best?.id ?? '';
  }

  let areaHoverFrame = 0;
  let lastAreaHoverPoint = null;
  let lastAreaHoverAt = 0;
  const AREA_HOVER_INTERVAL = 70;

  function scheduleAreaHover(point) {
    lastAreaHoverPoint = point;
    if (areaHoverFrame) return;
    areaHoverFrame = requestAnimationFrame(() => {
      areaHoverFrame = 0;
      if (!lastAreaHoverPoint || !map?.getLayer('area-hit')) return;
      const now = performance.now();
      if (now - lastAreaHoverAt < AREA_HOVER_INTERVAL) {
        scheduleAreaHover(lastAreaHoverPoint);
        return;
      }
      lastAreaHoverAt = now;
      const id = pickedAreaId(lastAreaHoverPoint);
      setHoverArea(id);
      if (!id) map.getCanvas().style.cursor = '';
      else map.getCanvas().style.cursor = 'pointer';
    });
  }

  // Fit the camera to a network's coverage polygon(s). Leaves room for the detail
  // panel (right on wide screens, bottom on narrow ones).
  let lastEmphFit = '';
  // Fit the camera to a network. `includeNodes` widens the bounds to also cover
  // every member node (some sit outside the drawn polygons); when false it frames
  // just the coverage shape(s). Exported below as focusNetwork().
  export function focusNetwork(netId, includeNodes = true) {
    if (!map || !areasData || !netId) return;
    const b = new maplibregl.LngLatBounds();
    const extend = (coords) => {
      if (typeof coords[0] === 'number') b.extend(coords);
      else for (const c of coords) extend(c);
    };
    let any = false;
    // The whole family's coverage polygon(s): a parent network (e.g. "australia")
    // may itself have no shape, so include its subnetworks' shapes too.
    const memberIds = new Set(
      networkMemberIds.length && (emphasizedNet === netId || !emphasizedNet)
        ? networkMemberIds
        : [netId]
    );
    for (const f of areasData.features ?? []) {
      if (!memberIds.has(f.properties?.networkId) || !f.geometry?.coordinates) continue;
      extend(f.geometry.coordinates);
      any = true;
    }
    // Also cover every member node, so the camera frames both the coverage area
    // and all the nodes living in it (some sit outside the drawn polygons).
    if (includeNodes) {
      for (const n of byPubkey.values()) {
        if (!Number.isFinite(n.lon) || !Number.isFinite(n.lat)) continue;
        if (!n.networks?.some((id) => memberIds.has(id))) continue;
        b.extend([n.lon, n.lat]);
        any = true;
      }
    }
    if (!any || b.isEmpty()) return;
    const wide = map.getContainer().clientWidth >= 640;
    const padding = wide
      ? { top: 90, right: 360, bottom: 90, left: 90 }
      : { top: 90, right: 60, bottom: 320, left: 60 };
    map.fitBounds(b, { padding, maxZoom: 12, duration: 800 });
  }

  // Local level: fly in tight on a single node's position.
  export function focusNodeLocal(pk) {
    const f = byPubkey.get(pk);
    if (map && f && Number.isFinite(f.lon) && Number.isFinite(f.lat)) {
      map.flyTo({ center: [f.lon, f.lat], zoom: 15, duration: 700 });
    }
  }

  // Neighbours level: frame the node together with all its drawable link
  // neighbours (relies on the selected node's links being loaded).
  export function focusNodeNeighbors(pk) {
    fitToLinks(pk);
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

  // Growth animation state for link lines: which origin is currently shown (so we
  // only re-animate when a fresh set appears) and the in-flight rAF handle.
  let linkAnim = 0;
  let shownLinkOrigin = '';
  let shownLinkCount = 0;
  const reduceMotion =
    typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Draw link LineStrings from one origin node to its neighbours. Only neighbours
  // with GPS are drawable; the rest still show in the panel list. When a fresh
  // set appears (new origin, or lines coming back after none) the segments grow
  // out from the origin node so they read as "flying" to their neighbours.
  function setLinkLines(originPk, linkList) {
    if (!ready || !map.getSource('node-links')) return;
    cancelAnimationFrame(linkAnim);
    const origin = originPk ? byPubkey.get(originPk) : null;
    if (!origin || !Number.isFinite(origin.lon) || !Number.isFinite(origin.lat)) {
      map.getSource('node-links').setData(EMPTY);
      shownLinkOrigin = originPk || '';
      shownLinkCount = 0;
      return;
    }
    const o = [origin.lon, origin.lat];
    const now = Date.now() / 1000;
    const targets = [];
    for (const l of linkList ?? []) {
      const nb = l.neighbor;
      if (!nb?.hasGps || !Number.isFinite(nb.lat) || !Number.isFinite(nb.lon)) continue;
      const ageDays = Math.max(0, (now - (l.lastSeen ?? 0)) / 86400);
      const recency = Math.exp(-ageDays / 7); // ~1 week falloff
      const width = Math.min(6, Math.max(1.2, Math.log1p(l.recentActivity ?? 0) * 1.6));
      targets.push({ end: [nb.lon, nb.lat], properties: { neighbor: nb.pubkey, width, recency } });
    }

    const src = map.getSource('node-links');
    const collect = (progress) => ({
      type: 'FeatureCollection',
      features: targets.map((t) => ({
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: [o, [o[0] + (t.end[0] - o[0]) * progress, o[1] + (t.end[1] - o[1]) * progress]]
        },
        properties: t.properties
      }))
    });

    // Animate only when a new set appears; a plain redraw (same origin, e.g. a
    // style reload) or reduced-motion just snaps to the final geometry.
    const appearing = targets.length > 0 && (originPk !== shownLinkOrigin || shownLinkCount === 0);
    shownLinkOrigin = originPk;
    shownLinkCount = targets.length;

    if (!appearing || reduceMotion) {
      src.setData(collect(1));
      return;
    }

    const duration = 460;
    const start = performance.now();
    const ease = (t) => 1 - Math.pow(1 - t, 3); // easeOutCubic
    const step = (nowMs) => {
      if (!map || !map.getSource('node-links')) return; // source gone mid-flight
      const t = Math.min(1, (nowMs - start) / duration);
      src.setData(collect(ease(t)));
      if (t < 1) linkAnim = requestAnimationFrame(step);
    };
    src.setData(collect(0));
    linkAnim = requestAnimationFrame(step);
  }

  // Selection draws the link set supplied by the parent; a hover (when nothing is
  // selected) previews the hovered node's links fetched on the fly.
  function buildLinkFeatures() {
    if (selected) {
      if (linksFor === selected && links.length) {
        setLinkLines(selected, links);
      } else if (shownLinkOrigin === selected && shownLinkCount > 0) {
        // Clicking a node whose links are already on screen (e.g. from the hover
        // preview) shouldn't blank them and re-fly them in while the selection's
        // own fetch runs — the visible lines already belong to this node, so keep
        // them until the fetched set snaps in.
        return;
      } else {
        setLinkLines(selected, []); // different node or still-loading link set: clear
      }
    } else {
      setLinkLines(hoverPk, hoverLinks);
    }
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
      nodeLinks(pk, { net: filters.net, active: filters.active, limit: 200 }, hoverCtl.signal)
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
    scheduleHoverPreview(pk);
  }

  function renderHoverTooltip(pk, node) {
    if (pk === renderedHoverPk) return;
    renderedHoverPk = pk;
    // First line: node-type icon (coloured by type, matching the map dots)
    // followed by the name.
    hoverLabelText.replaceChildren();
    const icon = TYPE_ICON[node.type];
    if (icon) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('fill', 'none');
      svg.setAttribute('stroke', 'currentColor');
      svg.setAttribute('stroke-width', '2');
      svg.setAttribute('stroke-linecap', 'round');
      svg.setAttribute('stroke-linejoin', 'round');
      svg.setAttribute('class', 'hover-label-icon');
      svg.style.color = TYPE_COLOR[node.type] ?? DEFAULT_COLOR;
      svg.innerHTML = icon; // trusted markup from filters.js
      hoverLabelText.append(svg);
    }
    const name = document.createElement('span');
    name.textContent = node.name || 'Unnamed node';
    hoverLabelText.append(name);
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
        // Externally-mirrored (map.meshcore.io) nodes render grey; live nodes by
        // type. Swapped for band colouring by the colorByBand $effect.
        'circle-color': colorByBand ? bandCircleColor(bandsCatalog) : typeCircleColor,
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
    restackLayers(); // re-adding nodes appends them on top; push them back under links/pulses
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
    featuresVersion++; // byPubkey isn't reactive; bump so effects tracking it re-run
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

  // Focus mode: when a network is opened, show only its member nodes; when a
  // node is opened, show only it and its link neighbours. Implemented as a
  // layer-level MapLibre filter (not a source rebuild) so it's instant over the
  // whole node set — filtered-out dots also stop being hoverable/clickable.
  function applyNodeFocus() {
    if (!ready || !map?.getLayer('nodes')) return;
    const base = ['!', ['has', 'point_count']];
    let focus = null;
    if (emphasizedNet) {
      // Include the network plus any subnetworks, since a parent network (e.g.
      // "australia") often has no directly-tagged nodes — they live in its
      // subregions ("australia-qld", …).
      const ids = networkMemberIds.length ? networkMemberIds : [emphasizedNet];
      focus = ['any', ...ids.map((id) => ['in', id, ['get', 'networks']])];
    } else if (selected && !linksLoading) {
      const linkSet = linksFor === selected ? links : [];
      const set = [selected, ...(linkSet ?? []).map((l) => l.neighbor?.pubkey).filter(Boolean)];
      focus = ['in', ['get', 'pubkey'], ['literal', set]];
    }
    map.setFilter('nodes', focus ? ['all', base, focus] : base);
  }

  // Zoom by a whole step (used by the +/- keyboard shortcuts on the page).
  export function zoomBy(delta) {
    if (map) map.easeTo({ zoom: map.getZoom() + delta, duration: 200 });
  }

  export function flyToLocation({ lon, lat, zoom = 12 } = {}) {
    if (!map || !Number.isFinite(lon) || !Number.isFinite(lat)) return;
    map.flyTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), zoom), duration: 700 });
  }

  function fitToFeatures(features) {
    const b = new maplibregl.LngLatBounds();
    for (const f of features) b.extend(f.geometry.coordinates);
    if (!b.isEmpty()) map.fitBounds(b, { padding: 120, maxZoom: 12, duration: 600 });
  }

  // A node the caller opened (from search or a restored URL) that should be
  // framed together with all of its observed links once they finish loading.
  let openTarget = $state('');
  // Bumped whenever the node set (byPubkey) is replaced, so effects that read
  // the non-reactive byPubkey map re-run once the full world set has loaded.
  let featuresVersion = $state(0);

  // Open a node and, once its links have loaded, zoom so the node and every
  // drawable link neighbour are in view (see the openTarget effect below). Pan
  // to the node right away (keeping the current zoom) for immediate feedback;
  // the link fit then adjusts the zoom, avoiding a zoom-in-then-out jump.
  export function openWithLinks(pk) {
    openTarget = pk;
    const f = byPubkey.get(pk);
    if (map && f && Number.isFinite(f.lon) && Number.isFinite(f.lat)) {
      map.flyTo({ center: [f.lon, f.lat], zoom: Math.max(map.getZoom(), 12), duration: 600 });
    }
  }

  // Fit the camera to a node plus its link neighbours. Falls back to a plain
  // centre when only the node itself is placeable (no drawable links).
  function fitToLinks(pk) {
    if (!map) return;
    const origin = byPubkey.get(pk);
    const b = new maplibregl.LngLatBounds();
    let placed = 0;
    if (origin && Number.isFinite(origin.lon) && Number.isFinite(origin.lat)) {
      b.extend([origin.lon, origin.lat]);
      placed++;
    }
    for (const l of links ?? []) {
      const nb = l.neighbor;
      if (nb?.hasGps && Number.isFinite(nb.lon) && Number.isFinite(nb.lat)) {
        b.extend([nb.lon, nb.lat]);
        placed++;
      }
    }
    if (b.isEmpty()) return;
    if (placed === 1) {
      map.flyTo({ center: b.getCenter(), zoom: Math.max(map.getZoom(), 12), duration: 700 });
      return;
    }
    // Leave room for the detail panel: on the right on wide screens, along the
    // bottom on narrow ones (where it docks to the bottom sheet).
    const wide = map.getContainer().clientWidth >= 640;
    const padding = wide
      ? { top: 90, right: 360, bottom: 90, left: 90 }
      : { top: 90, right: 60, bottom: 320, left: 60 };
    map.fitBounds(b, { padding, maxZoom: 14, duration: 800 });
  }

  // Once the opened node exists on the map and its links have finished loading,
  // frame them all, then clear the target so later selections aren't reframed.
  $effect(() => {
    const target = openTarget;
    const loading = linksLoading;
    const linkOrigin = linksFor;
    links; // track so a fresh link set re-runs this
    featuresVersion; // track so a late full-node load re-runs this
    if (!ready || !target || loading || selected !== target || linkOrigin !== target) return;
    if (!byPubkey.get(target)) return; // node not on the map yet — wait
    openTarget = '';
    fitToLinks(target);
  });

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
    ensureLinks();
    ensureNodes();
    if (areasData) ensureAreas();
    restackLayers();
    buildLinkFeatures();
    applyNodeFocus();
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
      openWithLinks(pk);
      onselect(byPubkey.get(pk) ?? e.features[0].properties);
    });
    // Hover preview: highlight + name label + link lines for the node under the
    // cursor. mousemove tracks moving between overlapping dots.
    map.on('mousemove', 'nodes', (e) => {
      const pk = e.features[0]?.properties.pubkey ?? '';
      onHoverNode(pk);
      // While a node is selected, hovering one of its neighbour dots highlights
      // that link line and its row in the detail panel (same as hovering the row).
      if (selected) onhoverlink(pk);
    });
    map.on('mouseleave', 'nodes', () => {
      onHoverNode('');
      if (selected) onhoverlink('');
    });
    // Hovering a link line highlights it just like hovering its row in the
    // detail panel (both drive `hoveredNeighbor` → the node-links-hover layer).
    map.on('mouseenter', 'node-links', pointer(true));
    map.on('mousemove', 'node-links', (e) => onhoverlink(e.features[0]?.properties?.neighbor ?? ''));
    map.on('mouseleave', 'node-links', () => {
      pointer(false)();
      onhoverlink('');
    });
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
      if (pk) openWithLinks(pk);
      onselect(byPubkey.get(pk) ?? null);
    });
    map.on('mousemove', (e) => {
      if (!map.getLayer('area-hit')) return;
      scheduleAreaHover(e.point);
    });
    // Cursor left the map entirely (moved off the canvas / out of the page):
    // drop every kind of hover so nothing stays stuck highlighted. The
    // layer-specific mouseleave handlers don't always fire when the pointer
    // exits the window quickly, so clear node, link and area hover here too.
    map.on('mouseout', () => {
      onHoverNode('');
      onhoverlink('');
      if (hoverAreaId) setHoverArea('');
    });
    map.on('click', (e) => {
      // A click that hits neither a node, a cluster, a link line, nor a pickable
      // parent territory deselects.
      const hits = map.queryRenderedFeatures(e.point, { layers: ['nodes', 'clusters', 'node-links'] });
      if (hits.length) return;
      const areaId = pickedAreaId(e.point);
      if (areaId) {
        onselectnetwork(areaId);
        return;
      }
      onselect(null);
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
      attributionControl: false,
      projection: { type: globe ? 'globe' : 'mercator' }
    });
    // Bottom-right stack, top → bottom: compass, geolocate, zoom +/−. In a
    // bottom corner, controls added later render above earlier ones, so the
    // compass is added last to sit at the top. The compass doubles as the
    // rotation/pitch reset — click it to snap back to north-up.
    map.addControl(new maplibregl.NavigationControl({ showZoom: true, showCompass: false }), 'bottom-right');
    map.addControl(new maplibregl.GeolocateControl({ trackUserLocation: false }), 'bottom-right');
    map.addControl(new maplibregl.NavigationControl({ showZoom: false, showCompass: true, visualizePitch: true }), 'bottom-right');
    // Distance scale, sitting just above the layer switch in the bottom-left.
    map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: 'metric' }), 'bottom-left');
    // Attribution is rendered by the page (next to the layer switch) so it can be
    // styled to match the UI; see the bottom-left controls in +page.svelte.

    if (typeof window !== 'undefined') window.__map = map;
    focusSel = selected || '';
    // A URL-restored selection should also frame its links once they load.
    openTarget = selected || '';
    map.on('moveend', () => {
      // Ignore stray move events fired during construction (before the style is
      // ready the center can read as 0,0), which would otherwise clobber the
      // seeded default position in the URL with z=0&lat=0&lon=0.
      if (!ready) return;
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
    cancelAnimationFrame(areaHoverFrame);
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
    emphasizedNet;
    emphasizedAreaIds;
    areaPickIds;
    areaRanks;
    if (!ready) return;
    // Territory hover/click needs the transparent area-hit layer even when the
    // persistent coverage toggle is off, so load the area data once the map is ready.
    const want =
      areaPickIds.length > 0 ||
      showAreas ||
      selectedNetworks().length > 0 ||
      hoveredNetworks().length > 0 ||
      !!emphasizedNet;
    const done = () => {
      ensureAreas();
      updateAreas();
      // Zoom to an opened network once, when it becomes emphasised.
      if (emphasizedNet && emphasizedNet !== lastEmphFit && areasData) {
        lastEmphFit = emphasizedNet;
        focusNetwork(emphasizedNet);
      } else if (!emphasizedNet) {
        lastEmphFit = '';
      }
    };
    if (want && !areasData) {
      networkAreas().then((d) => {
        areasData = colorizeAreas(d);
        done();
      });
    } else {
      done();
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
    linksFor;
    selected;
    if (ready) buildLinkFeatures();
  });

  // Re-apply focus (which nodes are visible) when the opened node/network or the
  // selected node's links change.
  $effect(() => {
    selected;
    links;
    linksFor;
    linksLoading;
    emphasizedNet;
    networkMemberIds;
    if (ready) applyNodeFocus();
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
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
  }
  :global(.hover-label-icon) {
    width: 13px;
    height: 13px;
    flex: none;
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
