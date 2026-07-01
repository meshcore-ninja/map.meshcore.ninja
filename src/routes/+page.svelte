<script>
  import { onMount } from 'svelte';
  import { fade, fly, slide } from 'svelte/transition';
  import MapView from '$lib/MapView.svelte';
  import CommandPalette from '$lib/CommandPalette.svelte';
  import Flag from '$lib/Flag.svelte';
  import { networks as fetchNetworks, nodeLinks, allNodes, meshNetworks, bands } from '$lib/api.js';
  import { NODE_TYPES, ACTIVITY, typeColor, TYPE_LABEL, TYPE_ICON } from '$lib/filters.js';
  import { readState, writeState } from '$lib/urlState.js';
  import { bandBadge } from '$lib/nodeMeta.js';
  import { LAYER_OPTIONS, basemapTheme, basemapAttribution } from '$lib/basemaps.js';

  // --- theme (mirrors the pre-paint bootstrap in app.html) ---
  let theme = $state('dark');
  onMount(() => {
    const saved = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    setTheme(basemap === 'auto' ? saved : basemapTheme(basemap, saved));
  });
  function setTheme(t) {
    theme = t;
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem('theme', theme);
    } catch (e) {
      /* ignore */
    }
  }
  function toggleTheme() {
    basemap = 'auto';
    setTheme(theme === 'dark' ? 'light' : 'dark');
  }

  // --- state, seeded from the URL so views are shareable & reload-safe ---
  const initial = readState();
  let view = $state({ z: initial.z, lat: initial.lat, lon: initial.lon });
  let filters = $state({ types: initial.types, net: initial.net, active: initial.active, q: initial.q });
  let selected = $state(initial.sel);
  let selectedNode = $state(null);
  let selectedNetwork = $state(null); // network opened from search (detail + border)
  let clustering = $state(initial.cluster);
  let showAreas = $state(initial.areas);
  let showImported = $state(initial.imported);
  let globe = $state(initial.globe);
  let basemap = $state(initial.basemap);
  let linkColor = $state(initial.linkColor);
  let colorByBand = $state(initial.bandColors);
  let layerMenuOpen = $state(false);
  let controlPanelOpen = $state(false);
  let attribVisible = $state(true);
  let attribManual = $state(false);

  function toggleAttrib() {
    attribManual = true;
    attribVisible = !attribVisible;
    layerMenuOpen = false;
  }

  // Preset swatches for the observed-link line colour (plus a custom picker).
  const LINK_COLORS = ['#5aa9ff', '#4dd0a7', '#d29922', '#c678dd', '#e2504a', '#f6f7f9'];
  let attribution = $derived(basemapAttribution(basemap));
  let status = $state({ loading: true });
  let networkList = $state([]);
  let networkNames = $derived(Object.fromEntries(networkList.map((n) => [n.id, n.name])));
  const netName = (id) => networkNames[id] ?? id;
  const netUrl = (id) => `https://meshcore.ninja/network/${id}`;
  let appReady = $state(false);

  // --- command palette (⌘K / Ctrl+K node search) ---
  let paletteOpen = $state(false);
  let paletteNodes = $state([]);
  let networksCatalog = $state({});
  let bandsCatalog = $state({});
  let mapView; // component ref, for openWithLinks
  const isMac =
    typeof navigator !== 'undefined' &&
    /mac|iphone|ipad|ipod/i.test(navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || '');

  onMount(() => {
    // The node array + catalogs power the palette. allNodes() reuses the same
    // memoised snapshot promise the map loads, so this adds no extra download.
    allNodes()
      .then((fc) =>
        (paletteNodes = (fc.features ?? []).map((f) => ({
          pubkey: f.properties.pubkey,
          name: f.properties.name,
          type: f.properties.type,
          lastAdvertAt: f.properties.lastAdvertAt,
          advertCount: f.properties.advertCount,
          networks: f.properties.networks ?? [],
          imported: f.properties.imported,
          band: f.properties.band,
          freq: f.properties.freq,
          lon: f.geometry.coordinates[0],
          lat: f.geometry.coordinates[1],
          hasGps: Number.isFinite(f.geometry.coordinates[1]) && Number.isFinite(f.geometry.coordinates[0])
        })))
      )
      .catch(() => {});
    meshNetworks()
      .then((c) => {
        networksCatalog = c;
        // Restore an opened-network detail from the URL (?selnet=…) once we have
        // the catalog to populate it, unless a node was already selected.
        if (initial.selnet && !selected && c[initial.selnet]) selectedNetwork = c[initial.selnet];
      })
      .catch(() => {});
    bands().then((b) => (bandsCatalog = b)).catch(() => {});

    const isTyping = (el) =>
      el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);

    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        paletteOpen = !paletteOpen;
        return;
      }
      if (paletteOpen || isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;

      // Escape closes an opened node/network detail.
      if (e.key === 'Escape') {
        if (selectedNetwork) {
          selectedNetwork = null;
          e.preventDefault();
        } else if (selected) {
          onSelect(null);
          e.preventDefault();
        }
        return;
      }
      // +/- zoom the map (like the on-screen zoom control).
      if (e.key === '+' || e.key === '=') {
        mapView?.zoomBy(1);
        e.preventDefault();
      } else if (e.key === '-' || e.key === '_') {
        mapView?.zoomBy(-1);
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Opening a search result behaves like clicking the node: select it (detail
  // panel) and pan the map there — it does not filter the map. Pan immediately
  // for feedback, then, once the links load, zoom to frame the node together
  // with all of its observed links.
  function openNode(node) {
    onSelect(node);
    mapView?.openWithLinks(node.pubkey);
  }

  // --- observed links for the selected node ---
  let links = $state([]);
  let linksMeta = $state({ total: 0, capped: false });
  let linksLoading = $state(false);
  let linksError = $state(false);
  let hoveredNeighbor = $state('');
  let linkCtl;

  $effect(() => {
    const pk = selected;
    const net = filters.net;
    const active = filters.active;
    const imported = selectedNode?.imported;
    linkCtl?.abort();
    if (!pk || imported) {
      links = [];
      linksMeta = { total: 0, capped: false };
      linksLoading = false;
      linksError = false;
      return;
    }
    linkCtl = new AbortController();
    // Drop the previous node's links immediately so the map doesn't briefly
    // redraw stale lines fanning from the new origin to the old neighbours
    // while the new set loads.
    links = [];
    linksMeta = { total: 0, capped: false };
    linksLoading = true;
    linksError = false;
    nodeLinks(pk, { net, active, limit: 200 }, linkCtl.signal)
      .then((d) => {
        links = d.links ?? [];
        linksMeta = { total: d.total ?? links.length, capped: !!d.capped };
        linksLoading = false;
      })
      .catch((e) => {
        if (e?.name === 'AbortError') return;
        links = [];
        linksMeta = { total: 0, capped: false };
        linksError = true;
        linksLoading = false;
      });
  });

  function selectNeighbor(l) {
    const n = l.neighbor;
    hoveredNeighbor = '';
    onSelect({
      pubkey: n.pubkey,
      name: n.name,
      type: n.type,
      hasGps: n.hasGps,
      lat: n.lat,
      lon: n.lon,
      lastAdvertAt: l.lastSeen,
      networks: l.networks ?? []
    });
  }

  onMount(async () => {
    networkList = await fetchNetworks();
  });

  function onSelect(props) {
    if (!props) {
      selected = '';
      selectedNode = null;
      return;
    }
    selectedNetwork = null; // selecting a node closes any open network detail
    selectedNode = { ...props, networks: Array.isArray(props.networks) ? props.networks : [] };
    selected = selectedNode.pubkey;
  }

  function toggleType(id) {
    filters.types = filters.types.includes(id)
      ? filters.types.filter((t) => t !== id)
      : [...filters.types, id];
  }

  // --- keep the URL in sync with every meaningful change (debounced) ---
  $effect(() => {
    writeState({
      z: view.z,
      lat: view.lat,
      lon: view.lon,
      types: filters.types,
      net: filters.net,
      active: filters.active,
      q: filters.q,
      sel: selected,
      selnet: selectedNetwork?.id ?? '',
      cluster: clustering,
      areas: showAreas,
      imported: showImported,
      globe,
      basemap,
      linkColor,
      bandColors: colorByBand,
    });
  });

  function agoLabel(unixSeconds) {
    if (!unixSeconds) return null;
    const s = Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  }

  const isLayerActive = (o) =>
    o.basemap === 'auto' ? basemap === 'auto' && theme === o.theme : basemap === o.basemap;
  function chooseLayer(o) {
    basemap = o.basemap;
    setTheme(o.theme);
    layerMenuOpen = false;
  }
  let currentLayer = $derived(LAYER_OPTIONS.find(isLayerActive) ?? LAYER_OPTIONS[0]);

  let activeFilterCount = $derived(
    filters.types.length + (filters.net ? 1 : 0) + (filters.active !== 'all' ? 1 : 0)
  );

  // Band badge for the detail panel (resolved region + colour), or null.
  let selectedBand = $derived(bandBadge(selectedNode?.band, bandsCatalog));

  // --- opened-network detail (from search) ---
  let networksForPalette = $derived(Object.values(networksCatalog));
  let networkBand = $derived(
    selectedNetwork ? bandBadge(String(selectedNetwork.radio?.frequency ?? ''), bandsCatalog) : null
  );
  // Which networks' nodes count as belonging to the opened network. Always the
  // network itself plus any id-prefixed subnetworks. A "general"-scope network is
  // a country-wide radio preset (e.g. "australia") that usually has no directly-
  // tagged nodes — its nodes live in the regional community networks covering the
  // same country (eastmesh, victoria-mesh, …) — so we widen it to every network
  // sharing one of its countries.
  let emphasizedFamily = $derived.by(() => {
    if (!selectedNetwork) return [];
    const id = selectedNetwork.id;
    const ids = new Set([id]);
    for (const n of networksForPalette) {
      if (n.id !== id && n.id.startsWith(`${id}-`)) ids.add(n.id);
    }
    if (selectedNetwork.scope === 'general') {
      const countries = new Set(selectedNetwork.coverage?.countries ?? []);
      if (countries.size) {
        for (const n of networksForPalette) {
          if ((n.coverage?.countries ?? []).some((c) => countries.has(c))) ids.add(n.id);
        }
      }
    }
    return [...ids];
  });

  // Member node count broken down by type (across the whole snapshot), for the
  // network detail panel's stat row.
  let networkStats = $derived.by(() => {
    if (!selectedNetwork) return null;
    const fam = new Set(emphasizedFamily);
    const counts = {};
    let total = 0;
    for (const n of paletteNodes) {
      if (!n.networks?.some((id) => fam.has(id))) continue;
      counts[n.type] = (counts[n.type] ?? 0) + 1;
      total++;
    }
    return { counts, total };
  });

  // A subnetwork row the user is hovering in the network detail; while set, the
  // map focuses just that subnetwork's nodes (a preview) instead of the family.
  let previewNet = $state('');

  // The member networks (excluding the opened one) that actually have nodes,
  // listed in the detail panel and hoverable to preview just their nodes.
  let subnetworkList = $derived.by(() => {
    if (!selectedNetwork) return [];
    const fam = new Set(emphasizedFamily.filter((id) => id !== selectedNetwork.id));
    if (!fam.size) return [];
    const counts = {};
    for (const n of paletteNodes) {
      for (const id of n.networks ?? []) if (fam.has(id)) counts[id] = (counts[id] ?? 0) + 1;
    }
    return Object.keys(counts)
      .map((id) => ({ id, net: networksCatalog[id], count: counts[id] }))
      .filter((x) => x.net)
      .sort((a, b) => b.count - a.count);
  });

  function openNetwork(net) {
    onSelect(null); // networks and nodes are mutually exclusive in the panel
    previewNet = '';
    selectedNetwork = net;
  }
</script>

<MapView
  bind:this={mapView}
  {view}
  {theme}
  {filters}
  {basemap}
  {linkColor}
  {clustering}
  {showImported}
  {showAreas}
  {colorByBand}
  {bandsCatalog}
  emphasizedNet={selectedNetwork?.id ?? ''}
  emphasizedAreaIds={emphasizedFamily}
  networkMemberIds={previewNet ? [previewNet] : emphasizedFamily}
  {globe}
  {selected}
  {links}
  {linksLoading}
  {networkNames}
  {hoveredNeighbor}
  onselect={onSelect}
  onmove={(v) => { view = v; if (!attribManual) attribVisible = false; }}
  onstatus={(s) => (status = s)}
  onready={() => (appReady = true)}
  onhoverlink={(pk) => (hoveredNeighbor = pk)}
/>

<!-- Fullscreen preloader -->
{#if !appReady}
  <div class="preloader" out:fade={{ duration: 600 }}>
    <div class="pl-stack">
      <div class="sonar">
        <span class="ring"></span>
        <span class="ring"></span>
        <span class="ring"></span>
        <img src="logo.png" alt="" class="pl-logo" width="56" height="56" />
      </div>
      <div class="pl-title">MeshCore Map</div>
      <div class="pl-sub">
        {#if status.error}
          Couldn't reach the API
        {:else if (status.total ?? 0) > 0}
          Mapping <span class="pl-count">{status.total.toLocaleString()}</span> nodes…
        {:else}
          Loading nodes…
        {/if}
      </div>
      <div class="pl-bar"><span></span></div>
    </div>
  </div>
{/if}

<!-- Layer menu backdrop -->
{#if layerMenuOpen}
  <button
    class="fixed inset-0 z-10 cursor-default"
    onclick={() => { layerMenuOpen = false; }}
    aria-label="Close"
    tabindex="-1"
  ></button>
{/if}

<!-- Top bar -->
<header
  class="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start justify-between gap-3 p-3"
>
  <!-- Left: header card with integrated filter panel -->
  <div
    class="map-float pointer-events-auto flex w-[23rem] max-w-[calc(100vw-4.5rem)] flex-col overflow-hidden rounded-xl border border-edge bg-elev/90 backdrop-blur"
  >
    <!-- Always-visible header row — the whole row toggles the control panel -->
    <button
      type="button"
      onclick={() => (controlPanelOpen = !controlPanelOpen)}
      class="flex w-full items-center gap-2.5 px-3 py-2 text-left transition hover:bg-elev2"
      aria-expanded={controlPanelOpen}
      aria-label={controlPanelOpen ? 'Close controls' : 'Open controls'}
    >
      <div class="min-w-0 flex-1 leading-tight">
        <div class="flex items-center gap-2 text-[0.95rem] font-bold text-ink">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="rgb(77, 208, 167)"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            class="h-5 w-5 shrink-0"
            aria-hidden="true"
          >
            <path d="M14.106 5.553a2 2 0 0 0 1.788 0l3.659-1.83A1 1 0 0 1 21 4.619v12.764a1 1 0 0 1-.553.894l-4.553 2.277a2 2 0 0 1-1.788 0l-4.212-2.106a2 2 0 0 0-1.788 0l-3.659 1.83A1 1 0 0 1 3 19.381V6.618a1 1 0 0 1 .553-.894l4.553-2.277a2 2 0 0 1 1.788 0z"/>
            <path d="M15 5.764v15"/>
            <path d="M9 3.236v15"/>
          </svg>
          MeshCore Map
          <span
            class="rounded-full border border-accent2/40 bg-accent2/10 px-1.5 py-0.5 text-[0.58rem] font-semibold uppercase leading-none tracking-wider text-accent2"
            >Alpha</span
          >
        </div>
        <div class="text-[0.72rem] text-dim">
          {#if status.loading}
            Loading nodes…
          {:else if status.error}
            API unavailable
          {:else if status.shown != null}
            <span class="flex flex-col items-start gap-0.5">
              <span class="flex items-center gap-1">
                Total:
                <span class="tabular-nums text-ink">{(status.total ?? 0).toLocaleString()}</span>
                <span class="text-dim"
                  >(<span class="tabular-nums">{(status.ours ?? 0).toLocaleString()}</span> +
                  <span class="tabular-nums">{(status.imported ?? 0).toLocaleString()}</span> meshcore.io)</span
                >
              </span>
              <span class="flex items-center gap-2.5">
                {#each NODE_TYPES as t}
                  <span class="flex items-center gap-1" title={t.label} style="color:{t.color}">
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      class="h-3.5 w-3.5"
                      aria-hidden="true">{@html t.icon}</svg
                    >
                    <span class="tabular-nums text-ink">{(status.byType?.[t.id] ?? 0).toLocaleString()}</span>
                  </span>
                {/each}
              </span>
            </span>
          {:else}
            Node map
          {/if}
        </div>
      </div>
      <!-- Panel toggle indicator (the whole row is the button) -->
      <span
        class="relative shrink-0 grid h-7 w-7 place-items-center rounded-lg text-dim transition
          {controlPanelOpen ? 'bg-elev2 text-ink' : ''}"
      >
        <svg
          class="h-4 w-4 transition-transform {controlPanelOpen ? 'rotate-180' : ''}"
          viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"
        >
          <path d="m6 9 6 6 6-6" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        {#if activeFilterCount && !controlPanelOpen}
          <span class="absolute -right-1 -top-1 grid h-3.5 w-3.5 place-items-center rounded-full bg-accent text-[0.55rem] font-bold text-bg"
            >{activeFilterCount}</span
          >
        {/if}
      </span>
    </button>

    <!-- Slide-down filter panel. The border lives on an inner wrapper so the
         slide-animated element itself is border-free — otherwise the height
         rounding at the end of the transition produces a 1px snap. -->
    {#if controlPanelOpen}
      <div transition:slide={{ duration: 200 }} class="overflow-hidden">
        <div class="flex flex-col gap-4 overflow-y-auto border-t border-edge px-3 py-3" style="max-height: calc(100vh - 6rem)">
          <!-- Node types -->
          <div>
            <div class="mb-2 text-[0.7rem] font-semibold uppercase tracking-wide text-dim">Node type</div>
            <div class="flex flex-wrap gap-1.5">
              {#each NODE_TYPES as t}
                {@const on = filters.types.length === 0 || filters.types.includes(t.id)}
                <button
                  onclick={() => toggleType(t.id)}
                  class="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[0.8rem] transition
                    {filters.types.includes(t.id) ? 'border-accent bg-accent/15 text-ink' : 'border-edge text-dim hover:text-ink'}"
                >
                  <span class="h-2.5 w-2.5 rounded-full" style="background:{t.color};opacity:{on ? 1 : 0.4}"></span>
                  {t.label}
                </button>
              {/each}
            </div>
            {#if filters.types.length}
              <button onclick={() => (filters.types = [])} class="mt-1.5 text-[0.72rem] text-accent2 hover:underline"
                >Reset to all types</button
              >
            {/if}
          </div>

          <!-- Network -->
          {#if networkList.length}
            <div>
              <div class="mb-1.5 text-[0.7rem] font-semibold uppercase tracking-wide text-dim">Network</div>
              <select
                bind:value={filters.net}
                class="w-full rounded-lg border border-edge bg-bg px-2.5 py-2 text-[0.85rem] text-ink outline-none"
              >
                <option value="">All networks</option>
                {#each networkList as n}
                  <option value={n.id}>{n.name}</option>
                {/each}
              </select>
            </div>
          {/if}

          <!-- Activity -->
          <div>
            <div class="mb-1.5 text-[0.7rem] font-semibold uppercase tracking-wide text-dim">Last seen</div>
            <div class="grid grid-cols-4 gap-1.5">
              {#each ACTIVITY as a}
                <button
                  onclick={() => (filters.active = a.id)}
                  class="rounded-lg border px-1 py-1.5 text-[0.75rem] transition
                    {filters.active === a.id ? 'border-accent bg-accent/15 text-ink' : 'border-edge text-dim hover:text-ink'}"
                  >{a.label}</button
                >
              {/each}
            </div>
          </div>

          <!-- Display toggles -->
          <div>
            <div class="mb-1.5 text-[0.7rem] font-semibold uppercase tracking-wide text-dim">Display</div>
            <div class="flex flex-col gap-1">
              {#each [
                { label: '3D globe view', get: () => globe, set: (v) => (globe = v) },
                { label: 'Cluster nearby nodes', get: () => clustering, set: (v) => (clustering = v) },
                { label: 'Imported nodes (meshcore.io)', get: () => showImported, set: (v) => (showImported = v) },
                { label: 'Network coverage areas', get: () => showAreas, set: (v) => (showAreas = v) }
              ] as row}
                <button
                  onclick={() => row.set(!row.get())}
                  class="flex items-center justify-between rounded-lg px-1 py-1.5 text-[0.85rem] text-ink hover:bg-elev2"
                >
                  {row.label}
                  <span
                    class="relative h-5 w-9 rounded-full transition-colors {row.get() ? 'bg-accent' : 'bg-edge'}"
                  >
                    <span
                      class="absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all {row.get() ? 'left-[1.125rem]' : 'left-0.5'}"
                    ></span>
                  </span>
                </button>
              {/each}
            </div>
          </div>

          <!-- Link colour -->
          <div>
            <div class="mb-1.5 text-[0.7rem] font-semibold uppercase tracking-wide text-dim">Link colour</div>
            <div class="flex flex-wrap items-center gap-2">
              {#each LINK_COLORS as c}
                <button
                  onclick={() => (linkColor = c)}
                  class="h-6 w-6 rounded-full border-2 transition {linkColor === c ? 'border-ink' : 'border-edge hover:border-dim'}"
                  style="background:{c}"
                  aria-label="Use link colour {c}"
                  aria-pressed={linkColor === c}
                ></button>
              {/each}
              <label
                class="relative h-6 w-6 overflow-hidden rounded-full border-2 {LINK_COLORS.includes(linkColor) ? 'border-edge hover:border-dim' : 'border-ink'}"
                style="background:{LINK_COLORS.includes(linkColor) ? 'conic-gradient(red,orange,yellow,lime,cyan,blue,magenta,red)' : linkColor}"
                title="Custom colour"
              >
                <input
                  type="color"
                  bind:value={linkColor}
                  class="absolute -inset-2 h-10 w-10 cursor-pointer border-0 bg-transparent p-0 opacity-0"
                  aria-label="Custom link colour"
                />
              </label>
            </div>
          </div>
        </div>
      </div>
    {/if}
  </div>

  <!-- Right: node search + nav link + theme toggle -->
  <div class="pointer-events-auto flex items-center gap-2">
    <button
      onclick={() => (paletteOpen = true)}
      aria-label="Search nodes"
      class="map-float flex h-[38px] items-center gap-2 rounded-xl border border-edge bg-elev/90 px-3 text-[0.85rem] text-dim backdrop-blur transition hover:bg-elev2 hover:text-ink"
    >
      <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" stroke-linecap="round" />
      </svg>
      <span class="hidden sm:inline">Search</span>
      <kbd class="hidden items-center rounded border border-edge bg-bg px-1.5 py-0.5 text-[0.68rem] font-medium sm:inline-flex">
        {isMac ? '⌘' : 'Ctrl'} K
      </kbd>
    </button>
    <a
      href="https://meshcore.ninja"
      target="_blank"
      rel="noreferrer"
      class="map-float hidden rounded-xl border border-accent2/40 bg-accent2/10 px-3 py-2 text-[0.85rem] font-medium text-accent2 backdrop-blur transition hover:bg-accent2/20 sm:block"
      >meshcore.ninja ↗</a
    >
    <button
      onclick={toggleTheme}
      aria-label="Toggle theme"
      class="map-float grid h-[38px] w-[38px] place-items-center rounded-xl border border-edge bg-elev/90 text-dim backdrop-blur transition hover:bg-elev2 hover:text-ink"
    >
      {#if theme === 'dark'}
        <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <circle cx="12" cy="12" r="4.2" />
          <path d="M12 2v2.5M12 19.5V22M4.2 4.2l1.8 1.8M18 18l1.8 1.8M2 12h2.5M19.5 12H22M4.2 19.8 6 18M18 6l1.8-1.8" stroke-linecap="round" />
        </svg>
      {:else}
        <svg class="h-4 w-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
        </svg>
      {/if}
    </button>
  </div>
</header>

<!-- ⌘K / Ctrl+K node search -->
<CommandPalette
  bind:open={paletteOpen}
  nodes={paletteNodes}
  networks={networksForPalette}
  {networksCatalog}
  {bandsCatalog}
  {isMac}
  onselect={openNode}
  onselectNetwork={openNetwork}
/>

<!-- Basemap / layer chooser + attribution (bottom-left) -->
<div class="absolute bottom-3 left-3 z-20 flex items-center gap-2">
  <!-- Layer switch -->
  <div class="relative">
    {#if layerMenuOpen}
      <div
        class="map-float absolute bottom-full left-0 mb-2 max-w-[calc(100vw-2rem)] overflow-x-auto rounded-xl border border-edge bg-elev/95 p-2.5 backdrop-blur"
        transition:fade={{ duration: 120 }}
      >
        <div class="mb-2 px-0.5 text-[0.7rem] font-semibold uppercase tracking-wide text-dim">Map layer</div>
        <div class="grid w-max grid-cols-5 gap-2 pb-0.5">
          {#each LAYER_OPTIONS as o (o.key)}
            {@const active = isLayerActive(o)}
            <button
              onclick={() => chooseLayer(o)}
              class="group flex w-28 flex-col gap-1.5 rounded-lg border p-1.5 text-left transition
                {active ? 'border-accent bg-accent/10' : 'border-edge hover:border-accent2/60'}"
              aria-pressed={active}
            >
              <span class="relative block">
                <img
                  src={o.thumb}
                  alt=""
                  class="h-16 w-full rounded-md border border-edge object-cover"
                  width="100"
                  height="64"
                  loading="lazy"
                />
                {#if active}
                  <span class="absolute right-1 top-1 grid h-4 w-4 place-items-center rounded-full bg-accent text-bg">
                    <svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" aria-hidden="true">
                      <path d="M5 12l5 5 9-11" stroke-linecap="round" stroke-linejoin="round" />
                    </svg>
                  </span>
                {/if}
              </span>
              <span class="truncate text-[0.78rem] {active ? 'text-ink' : 'text-dim group-hover:text-ink'}">{o.label}</span>
            </button>
          {/each}
        </div>
      </div>
    {/if}
    <button
      onclick={() => { layerMenuOpen = !layerMenuOpen; }}
      class="map-float flex h-[38px] items-center gap-2 rounded-xl border border-edge bg-elev/90 px-3 text-[0.85rem] font-medium text-ink backdrop-blur transition hover:bg-elev2"
      aria-label="Choose map layer"
      aria-expanded={layerMenuOpen}
    >
      <svg class="h-4 w-4 text-dim" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <path d="m12 2 9 5-9 5-9-5 9-5Z" stroke-linejoin="round" />
        <path d="m3 12 9 5 9-5" stroke-linecap="round" stroke-linejoin="round" />
        <path d="m3 17 9 5 9-5" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      <span class="hidden sm:inline">{currentLayer.label}</span>
    </button>
  </div>

  <!-- Colour nodes by LoRa band -->
  <button
    onclick={() => (colorByBand = !colorByBand)}
    class="map-float flex h-[38px] items-center gap-2 rounded-xl border px-3 text-[0.85rem] font-medium backdrop-blur transition
      {colorByBand ? 'border-accent bg-accent/15 text-ink' : 'border-edge bg-elev/90 text-dim hover:bg-elev2 hover:text-ink'}"
    aria-label="Colour nodes by band"
    aria-pressed={colorByBand}
    title="Colour node dots by their LoRa band"
  >
    <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
      <circle cx="13.5" cy="6.5" r="2.5" /><circle cx="17.5" cy="10.5" r="2.5" />
      <circle cx="8.5" cy="7.5" r="2.5" /><circle cx="6.5" cy="12.5" r="2.5" />
      <path d="M12 2a10 10 0 1 0 0 20 2.5 2.5 0 0 0 2-4 2.5 2.5 0 0 1 2-4h2a4 4 0 0 0 4-4 10 10 0 0 0-10-8Z" stroke-linejoin="round" />
    </svg>
    <span class="hidden sm:inline">Band colours</span>
  </button>

  <!-- Attribution: (i) button + inline text -->
  <button
    onclick={toggleAttrib}
    class="map-float grid h-[38px] w-[38px] place-items-center rounded-xl border border-edge bg-elev/90 text-dim backdrop-blur transition hover:bg-elev2 hover:text-ink"
    aria-label="Map data attribution"
    aria-expanded={attribVisible}
  >
    <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
      <circle cx="12" cy="12" r="9.5" />
      <path d="M12 11v5" stroke-linecap="round" />
      <circle cx="12" cy="7.6" r="0.6" fill="currentColor" stroke="none" />
    </svg>
  </button>

  {#if attribVisible}
    <div
      transition:fade={{ duration: 120 }}
      class="map-float hidden rounded-lg border border-edge bg-elev/95 px-2.5 py-1.5 text-[0.72rem] text-dim backdrop-blur sm:block"
      style="max-width: min(50vw, 28rem)"
    >
      {attribution}
    </div>
  {/if}
</div>

<!-- Selected node detail -->
{#if selectedNode}
  <aside
    id="node-detail"
    transition:fly={{ x: 340, duration: 260 }}
    class="map-float absolute bottom-0 inset-x-0 z-30 rounded-t-2xl border-t border-[#5aa9ff] bg-elev/95 p-4 backdrop-blur
      sm:inset-x-auto sm:bottom-auto sm:top-[3.75rem] sm:right-3 sm:w-80 sm:max-h-[calc(100vh-4.75rem)] sm:overflow-y-auto sm:rounded-xl sm:border"
  >
    <div class="flex items-start justify-between gap-3">
      <div class="flex items-center gap-2">
        <span class="h-3 w-3 rounded-full" style="background:{typeColor(selectedNode.type)}"></span>
        <h2 class="text-[1rem] font-semibold text-ink">{selectedNode.name || 'Unnamed node'}</h2>
      </div>
      <button onclick={() => onSelect(null)} aria-label="Close" class="text-dim hover:text-ink">
        <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
          ><path d="M6 6l12 12M18 6 6 18" stroke-linecap="round" /></svg
        >
      </button>
    </div>
    <dl class="mt-3 grid grid-cols-2 gap-x-3 gap-y-2.5 text-[0.82rem]">
      <div>
        <dt class="text-dim">Type</dt>
        <dd class="flex items-center gap-1.5 text-ink">
          {#if TYPE_ICON[selectedNode.type]}
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="h-4 w-4 shrink-0" style="color:{typeColor(selectedNode.type)}" aria-hidden="true">{@html TYPE_ICON[selectedNode.type]}</svg>
          {/if}
          <span class="capitalize">{TYPE_LABEL[selectedNode.type] ?? 'unknown'}</span>
        </dd>
      </div>
      <div><dt class="text-dim">Last advert</dt><dd class="text-ink">{agoLabel(selectedNode.lastAdvertAt) ?? '—'}</dd></div>
      <div><dt class="text-dim">Adverts</dt><dd class="text-ink">{selectedNode.advertCount ?? '—'}</dd></div>
      {#if selectedBand}
        <div class="col-span-2">
          <dt class="text-dim">Band</dt>
          <dd class="mt-0.5 flex items-center gap-1.5">
            <span
              class="rounded-full border px-1.5 py-0.5 text-[0.68rem] font-semibold leading-none"
              style="color:{selectedBand.color};border-color:color-mix(in srgb,{selectedBand.color} 45%,transparent)"
              >{selectedBand.region}</span
            >
            {#if selectedNode.freq}
              <span class="font-mono text-[0.72rem] text-dim">{selectedNode.freq} MHz</span>
            {/if}
          </dd>
        </div>
      {/if}
      <div class="col-span-2">
        <dt class="text-dim">Networks</dt>
        <dd class="mt-1 flex flex-wrap gap-1">
          {#each selectedNode.networks ?? [] as net}
            <a href={netUrl(net)} target="_blank" rel="noreferrer" class="rounded-md border border-edge bg-bg px-1.5 py-0.5 text-[0.72rem] text-dim transition hover:border-accent2/60 hover:text-ink">{netName(net)}</a>
          {/each}
        </dd>
      </div>
      <div class="col-span-2">
        <dt class="text-dim">Public key</dt>
        <dd class="mt-0.5 break-all font-mono text-[0.72rem] text-dim">{selectedNode.pubkey}</dd>
      </div>
    </dl>

    <!-- Observed links to neighboring nodes -->
    <div class="mt-4 border-t border-edge pt-3">
      <div class="mb-2 flex items-center justify-between">
        <span class="text-[0.7rem] font-semibold uppercase tracking-wide text-dim">Links</span>
        {#if !linksLoading && !linksError && linksMeta.total > 0}
          <span class="text-[0.72rem] text-dim">
            {links.length}{#if linksMeta.capped} of {linksMeta.total}{/if}
          </span>
        {/if}
      </div>

      {#if linksLoading}
        <div class="flex items-center gap-2 py-2 text-[0.8rem] text-dim">
          <span class="h-3.5 w-3.5 animate-spin rounded-full border-2 border-edge border-t-accent"></span>
          Loading links…
        </div>
      {:else if linksError}
        <div class="py-2 text-[0.8rem] text-dim">Couldn't load links.</div>
      {:else if links.length === 0}
        <div class="py-2 text-[0.8rem] text-dim">No observed links yet.</div>
      {:else}
        <ul class="flex flex-col gap-1">
          {#each links as l (l.neighbor.pubkey)}
            <li>
              <button
                onclick={() => selectNeighbor(l)}
                onmouseenter={() => (hoveredNeighbor = l.neighbor.pubkey)}
                onmouseleave={() => (hoveredNeighbor = '')}
                class="flex w-full flex-col gap-1 rounded-lg border bg-bg/60 px-2.5 py-2 text-left transition hover:border-accent hover:bg-elev2
                  {hoveredNeighbor === l.neighbor.pubkey ? 'border-accent bg-elev2' : 'border-edge'}"
              >
                <div class="flex items-center justify-between gap-2">
                  <span class="flex min-w-0 items-center gap-1.5">
                    <span class="h-2.5 w-2.5 shrink-0 rounded-full" style="background:{typeColor(l.neighbor.type)}"></span>
                    <span class="truncate text-[0.85rem] text-ink">{l.neighbor.name || 'Unnamed'}</span>
                    {#if !l.neighbor.hasGps}
                      <span class="shrink-0 rounded border border-edge px-1 text-[0.6rem] uppercase text-dim" title="No GPS — not drawn on the map">no gps</span>
                    {/if}
                  </span>
                  <span class="shrink-0 text-[0.72rem] text-dim">{agoLabel(l.lastSeen) ?? '—'}</span>
                </div>
                <div class="flex items-center gap-3 text-[0.72rem] text-dim">
                  <span class="capitalize">{TYPE_LABEL[l.neighbor.type] ?? 'unknown'}</span>
                  <span title="Recent activity score">⚡ {(l.recentActivity ?? 0).toFixed(1)}</span>
                  <span title="Deduplicated packet count">{(l.packetCount ?? 0).toLocaleString()} pkts</span>
                </div>
                {#if l.networks?.length}
                  <div class="flex flex-wrap gap-1">
                    {#each l.networks as net}
                      <span class="rounded border border-edge bg-bg px-1 py-0.5 text-[0.62rem] text-dim">{netName(net)}</span>
                    {/each}
                  </div>
                {/if}
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  </aside>
{/if}

<!-- Opened-network detail (from search) -->
{#if selectedNetwork}
  <aside
    id="network-detail"
    transition:fly={{ x: 340, duration: 260 }}
    class="map-float absolute bottom-0 inset-x-0 z-30 rounded-t-2xl border-t border-accent2 bg-elev/95 p-4 backdrop-blur
      sm:inset-x-auto sm:bottom-auto sm:top-[3.75rem] sm:right-3 sm:w-80 sm:max-h-[calc(100vh-4.75rem)] sm:overflow-y-auto sm:rounded-xl sm:border"
  >
    <div class="flex items-start justify-between gap-3">
      <div class="flex min-w-0 items-center gap-2">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="h-4 w-4 shrink-0 text-accent2" aria-hidden="true">
          <circle cx="12" cy="12" r="9" /><path d="M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18M3 12h18" stroke-linecap="round" />
        </svg>
        <h2 class="truncate text-[1rem] font-semibold text-ink">{selectedNetwork.name || selectedNetwork.id}</h2>
      </div>
      <button onclick={() => (selectedNetwork = null)} aria-label="Close" class="text-dim hover:text-ink">
        <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
          ><path d="M6 6l12 12M18 6 6 18" stroke-linecap="round" /></svg
        >
      </button>
    </div>

    {#if selectedNetwork.short_name && selectedNetwork.short_name !== selectedNetwork.name}
      <div class="mt-0.5 text-[0.8rem] text-dim">{selectedNetwork.short_name}</div>
    {/if}
    {#if selectedNetwork.description}
      <p class="mt-2 text-[0.82rem] leading-snug text-dim">{selectedNetwork.description}</p>
    {/if}

    <dl class="mt-3 grid grid-cols-2 gap-x-3 gap-y-2.5 text-[0.82rem]">
      {#if networkBand}
        <div>
          <dt class="text-dim">Band</dt>
          <dd class="mt-0.5 flex items-center gap-1.5">
            <span
              class="rounded-full border px-1.5 py-0.5 text-[0.68rem] font-semibold leading-none"
              style="color:{networkBand.color};border-color:color-mix(in srgb,{networkBand.color} 45%,transparent)"
              >{networkBand.region}</span
            >
            {#if selectedNetwork.radio?.frequency_mhz}
              <span class="font-mono text-[0.72rem] text-dim">{selectedNetwork.radio.frequency_mhz} MHz</span>
            {/if}
          </dd>
        </div>
      {/if}
      {#if networkStats}
        <div class="col-span-2">
          <dt class="text-dim">Nodes on map</dt>
          <dd class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
            <span class="tabular-nums font-medium text-ink">{networkStats.total.toLocaleString()}</span>
            {#each NODE_TYPES as t}
              <span class="flex items-center gap-1" title={t.label} style="color:{t.color}">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="h-3.5 w-3.5" aria-hidden="true">{@html t.icon}</svg>
                <span class="tabular-nums text-ink">{(networkStats.counts[t.id] ?? 0).toLocaleString()}</span>
              </span>
            {/each}
          </dd>
        </div>
      {/if}
      {#if selectedNetwork.areaKm2}
        <div><dt class="text-dim">Coverage area</dt><dd class="tabular-nums text-ink">{selectedNetwork.areaKm2.toLocaleString()} km²</dd></div>
      {/if}
      {#if selectedNetwork.radio?.spreading_factor || selectedNetwork.radio?.bandwidth_khz}
        <div>
          <dt class="text-dim">Radio</dt>
          <dd class="text-ink">
            {#if selectedNetwork.radio.spreading_factor}SF{selectedNetwork.radio.spreading_factor}{/if}{#if selectedNetwork.radio.bandwidth_khz} · {selectedNetwork.radio.bandwidth_khz} kHz{/if}{#if selectedNetwork.radio.coding_rate} · CR {selectedNetwork.radio.coding_rate}{/if}
          </dd>
        </div>
      {/if}
      {#if (selectedNetwork.coverage?.countries ?? []).length}
        <div class="col-span-2">
          <dt class="text-dim">Countries</dt>
          <dd class="mt-1 flex flex-wrap items-center gap-1.5">
            {#each selectedNetwork.coverage.countries as cc}
              <Flag code={cc} class="h-3 w-4 rounded-sm opacity-80" />
            {/each}
          </dd>
        </div>
      {/if}
    </dl>

    <!-- Member sub-networks (hover to preview just that region's nodes) -->
    {#if subnetworkList.length}
      <div class="mt-4 border-t border-edge pt-3">
        <div class="mb-2 text-[0.7rem] font-semibold uppercase tracking-wide text-dim">Sub-networks</div>
        <ul class="flex flex-col gap-1">
          {#each subnetworkList as s (s.id)}
            <li>
              <button
                onmouseenter={() => (previewNet = s.id)}
                onmouseleave={() => { if (previewNet === s.id) previewNet = ''; }}
                onclick={() => openNetwork(s.net)}
                class="flex w-full items-center justify-between gap-2 rounded-lg border border-edge bg-bg/60 px-2.5 py-1.5 text-left transition hover:border-accent hover:bg-elev2"
              >
                <span class="flex min-w-0 items-center gap-1.5">
                  {#if s.net.coverage?.countries?.[0]}
                    <Flag code={s.net.coverage.countries[0]} class="h-2.5 w-3.5 shrink-0 opacity-70" />
                  {/if}
                  <span class="truncate text-[0.82rem] text-ink">{s.net.short_name || s.net.name || s.id}</span>
                </span>
                <span class="shrink-0 tabular-nums text-[0.72rem] text-dim">{s.count.toLocaleString()}</span>
              </button>
            </li>
          {/each}
        </ul>
      </div>
    {/if}

    <div class="mt-4 flex flex-wrap gap-2 border-t border-edge pt-3">
      <a
        href={netUrl(selectedNetwork.id)}
        target="_blank"
        rel="noreferrer"
        class="rounded-lg border border-accent2/40 bg-accent2/10 px-2.5 py-1.5 text-[0.78rem] font-medium text-accent2 transition hover:bg-accent2/20"
        >View on meshcore.ninja ↗</a
      >
      {#if selectedNetwork.community?.website}
        <a href={selectedNetwork.community.website} target="_blank" rel="noreferrer" class="rounded-lg border border-edge px-2.5 py-1.5 text-[0.78rem] text-dim transition hover:text-ink">Website ↗</a>
      {/if}
      {#each selectedNetwork.analyzers ?? [] as a}
        {#if a.url}
          <a href={a.url} target="_blank" rel="noreferrer" class="rounded-lg border border-edge px-2.5 py-1.5 text-[0.78rem] text-dim transition hover:text-ink">{a.name || 'Analyzer'} ↗</a>
        {/if}
      {/each}
    </div>
  </aside>
{/if}

<style>
  .preloader {
    position: fixed;
    inset: 0;
    z-index: 50;
    display: grid;
    place-items: center;
    background:
      radial-gradient(
        120% 120% at 50% 38%,
        color-mix(in srgb, var(--color-accent) 8%, transparent),
        transparent 62%
      ),
      var(--color-bg);
  }
  .pl-stack {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.85rem;
    animation: pl-rise 0.5s ease-out both;
  }
  .sonar {
    position: relative;
    display: grid;
    place-items: center;
    width: 120px;
    height: 120px;
  }
  .ring {
    position: absolute;
    width: 100%;
    height: 100%;
    border-radius: 9999px;
    border: 1.5px solid var(--color-accent);
    opacity: 0;
    animation: sonar 2.4s ease-out infinite;
  }
  .ring:nth-child(2) {
    animation-delay: 0.8s;
  }
  .ring:nth-child(3) {
    animation-delay: 1.6s;
  }
  .pl-logo {
    width: 56px;
    height: 56px;
    animation: pl-pulse 2s ease-in-out infinite;
    filter: drop-shadow(0 0 14px color-mix(in srgb, var(--color-accent) 45%, transparent));
  }
  .pl-title {
    font-weight: 700;
    font-size: 1.1rem;
    color: var(--color-ink);
  }
  .pl-sub {
    font-size: 0.8rem;
    color: var(--color-dim);
  }
  .pl-count {
    color: var(--color-accent);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .pl-bar {
    margin-top: 0.3rem;
    width: 180px;
    height: 3px;
    border-radius: 9999px;
    background: var(--color-edge);
    overflow: hidden;
  }
  .pl-bar span {
    display: block;
    width: 38%;
    height: 100%;
    border-radius: inherit;
    background: linear-gradient(90deg, transparent, var(--color-accent), transparent);
    animation: pl-slide 1.3s ease-in-out infinite;
  }
  @keyframes sonar {
    0% {
      transform: scale(0.35);
      opacity: 0.65;
    }
    100% {
      transform: scale(2.3);
      opacity: 0;
    }
  }
  @keyframes pl-pulse {
    0%,
    100% {
      transform: scale(1);
    }
    50% {
      transform: scale(1.08);
    }
  }
  @keyframes pl-slide {
    0% {
      transform: translateX(-130%);
    }
    100% {
      transform: translateX(390%);
    }
  }
  @keyframes pl-rise {
    from {
      opacity: 0;
      transform: translateY(8px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .ring,
    .pl-logo,
    .pl-bar span,
    .pl-stack {
      animation: none;
    }
    .ring:first-child {
      opacity: 0.3;
    }
  }
</style>
