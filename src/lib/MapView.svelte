<script>
  import { onMount, onDestroy } from 'svelte';
  import maplibregl from 'maplibre-gl';
  import 'maplibre-gl/dist/maplibre-gl.css';
  import { allNodes, networkAreas } from '$lib/api.js';
  import { makeNodePredicate, TYPE_COLOR, DEFAULT_COLOR } from '$lib/filters.js';

  let {
    view, // initial { z, lat, lon }
    theme = 'dark',
    filters, // { types:number[], net, active, q }
    clustering = true,
    showAreas = false,
    selected = '',
    onselect = () => {},
    onmove = () => {},
    onstatus = () => {}
  } = $props();

  let container;
  let map;
  let ready = $state(false);

  // Loaded-once data, kept in component scope so theme restyles and clustering
  // toggles never refetch.
  let rawFeatures = []; // all node features (GeoJSON)
  let byPubkey = new Map(); // pubkey -> clean properties (arrays intact)
  let areasData = null; // network-area FeatureCollection (lazy)
  let lastQ = '';
  let focusSel = '';

  const EMPTY = { type: 'FeatureCollection', features: [] };
  const NODE_LAYERS = ['clusters', 'cluster-count', 'node-selected', 'nodes'];

  // --- basemap ---------------------------------------------------------------
  const CARTO = (variant) =>
    ['a', 'b', 'c', 'd'].map((s) => `https://${s}.basemaps.cartocdn.com/${variant}/{z}/{x}/{y}.png`);
  function basemapStyle(t) {
    return {
      version: 8,
      glyphs: 'https://fonts.openmaptiles.org/{fontstack}/{range}.pbf',
      sources: {
        carto: {
          type: 'raster',
          tiles: CARTO(t === 'light' ? 'light_all' : 'dark_all'),
          tileSize: 256,
          attribution: '© OpenStreetMap contributors © CARTO'
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
        paint: { 'fill-color': '#5aa9ff', 'fill-opacity': 0.08 }
      },
      beforeId
    );
    map.addLayer(
      {
        id: 'area-line',
        type: 'line',
        source: 'areas',
        paint: { 'line-color': '#5aa9ff', 'line-opacity': 0.5, 'line-width': 1 }
      },
      beforeId
    );
    updateAreas();
  }
  function updateAreas() {
    if (!map.getLayer('area-fill')) return;
    const vis = showAreas ? 'visible' : 'none';
    // When a single network is selected, show only its area.
    const filter = filters.net ? ['==', ['get', 'networkId'], filters.net] : null;
    for (const id of ['area-fill', 'area-line']) {
      map.setLayoutProperty(id, 'visibility', vis);
      map.setFilter(id, filter);
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
    map.addLayer({
      id: 'nodes',
      type: 'circle',
      source: 'nodes',
      filter: ['!', ['has', 'point_count']],
      paint: {
        'circle-color': typeColorExpr,
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 3.5, 12, 7],
        'circle-stroke-color': '#0d1117',
        'circle-stroke-width': 1
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

  // Filter the in-memory node set and push it to the source. No network I/O.
  function applyFilter(force = false) {
    (globalThis.__mlog ??= []).push('applyFilter');
    if (!ready || !map.getSource('nodes')) return;
    const keep = makeNodePredicate(filters);
    const features = rawFeatures.filter((f) => keep(f.properties));
    map.getSource('nodes').setData({ type: 'FeatureCollection', features });
    onstatus({ loading: false, total: rawFeatures.length, shown: features.length });

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
    if (f) {
      map.flyTo({ center: [f.lon, f.lat], zoom: Math.max(map.getZoom(), 12), duration: 600 });
      onselect(f); // populate the detail panel for the URL-restored node
      focusSel = '';
    }
  }

  // --- (re)build everything after style load -------------------------------
  function addAll() {
    ensureNodes();
    if (areasData) ensureAreas();
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
    map.on('click', (e) => {
      const hits = map.queryRenderedFeatures(e.point, { layers: ['nodes', 'clusters'] });
      if (!hits.length) onselect(null);
    });
  }

  onMount(async () => {
    map = new maplibregl.Map({
      container,
      style: basemapStyle(theme),
      center: [view.lon, view.lat],
      zoom: view.z,
      minZoom: 1,
      maxZoom: 18,
      attributionControl: false
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left');
    map.addControl(new maplibregl.GeolocateControl({ trackUserLocation: false }), 'bottom-right');

    if (typeof window !== 'undefined') window.__map = map;
    focusSel = selected || '';
    map.on('moveend', () => {
      const c = map.getCenter();
      onmove({ z: map.getZoom(), lat: c.lat, lon: c.lng });
    });

    // Fetch the full node set in parallel with the style load.
    const dataReady = allNodes()
      .then((fc) => {
        rawFeatures = fc.features ?? [];
        byPubkey = new Map(rawFeatures.map((f) => [f.properties.pubkey, f.properties]));
      })
      .catch(() => onstatus({ loading: false, error: true }));

    onstatus({ loading: true });
    map.on('load', async () => {
      addAll();
      wireInteractions();
      ready = true;
      await dataReady;
      applyFilter(true);
      flyToSelected();
    });
  });

  onDestroy(() => map?.remove());

  // --- reactive effects ------------------------------------------------------
  let filterKey = $derived(JSON.stringify([filters.types, filters.net, filters.active, filters.q]));
  $effect(() => {
    filterKey;
    if (ready) applyFilter();
  });

  $effect(() => {
    clustering;
    if (ready) rebuildNodes();
  });

  // Lazy-load and toggle the network-area overlay.
  $effect(() => {
    showAreas;
    filters.net;
    if (!ready) return;
    if (showAreas && !areasData) {
      networkAreas().then((d) => {
        areasData = d;
        ensureAreas();
      });
    } else {
      ensureAreas();
      updateAreas();
    }
  });

  // Basemap follows the theme toggle; data layers are re-added afterwards.
  $effect(() => {
    if (!ready || !map) return;
    const cur = map.getStyle()?.sources?.carto?.tiles?.[0] ?? '';
    if (cur.includes('light_all') !== (theme === 'light')) {
      (globalThis.__mlog ??= []).push('setStyle');
      map.setStyle(basemapStyle(theme));
      map.once('styledata', () => {
        if (!map.getSource('nodes')) {
          addAll();
          applyFilter(true);
        }
      });
    }
  });

  // Move the selection halo.
  $effect(() => {
    if (ready && map?.getLayer('node-selected')) {
      map.setFilter('node-selected', ['==', ['get', 'pubkey'], selected || ' ']);
    }
  });
</script>

<div bind:this={container} class="absolute inset-0 h-full w-full"></div>
