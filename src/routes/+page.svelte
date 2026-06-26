<script>
  import { onMount } from 'svelte';
  import { fade, fly } from 'svelte/transition';
  import MapView from '$lib/MapView.svelte';
  import { networks as fetchNetworks, nodeLinks, routeQuery } from '$lib/api.js';
  import { NODE_TYPES, ACTIVITY, typeColor, TYPE_LABEL, TYPE_ICON } from '$lib/filters.js';
  import { readState, writeState } from '$lib/urlState.js';
  import { LAYER_OPTIONS, basemapTheme, basemapAttribution } from '$lib/basemaps.js';

  // --- theme (mirrors the pre-paint bootstrap in app.html) ---
  let theme = $state('dark');
  onMount(() => {
    // Keep the chrome theme matched to the basemap. A fixed basemap (Mapy/OSM)
    // forces its theme; the theme-following CARTO basemap uses the saved theme.
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
    // Toggling the theme switches to the matching CARTO basemap so the map and
    // chrome stay in sync (a fixed light-only basemap would otherwise clash).
    basemap = 'auto';
    setTheme(theme === 'dark' ? 'light' : 'dark');
  }

  // --- state, seeded from the URL so views are shareable & reload-safe ---
  const initial = readState();
  let view = $state({ z: initial.z, lat: initial.lat, lon: initial.lon });
  let filters = $state({ types: initial.types, net: initial.net, active: initial.active, q: initial.q });
  let selected = $state(initial.sel);
  let selectedNode = $state(null);
  let clustering = $state(initial.cluster);
  let showAreas = $state(initial.areas);
  let showImported = $state(initial.imported);
  let globe = $state(initial.globe);
  let basemap = $state(initial.basemap);
  let linkColor = $state(initial.linkColor);
  let liveEnabled = $state(initial.live); // realtime advert pulses
  let liveConnected = $state(false); // live feed socket is currently open
  let routeEnabled = $state(initial.route); // best-effort route resolving (Advanced)
  let layerMenuOpen = $state(false);
  let attribOpen = $state(false);

  // Preset swatches for the observed-link line colour (plus a custom picker).
  const LINK_COLORS = ['#5aa9ff', '#4dd0a7', '#d29922', '#c678dd', '#e2504a', '#f6f7f9'];
  let attribution = $derived(basemapAttribution(basemap));
  let status = $state({ loading: true });
  let networkList = $state([]);
  // Resolve a network id to its display name and catalog URL for the panel chips.
  let networkNames = $derived(Object.fromEntries(networkList.map((n) => [n.id, n.name])));
  const netName = (id) => networkNames[id] ?? id;
  const netUrl = (id) => `https://meshcore.ninja/network/${id}`;
  let panelOpen = $state(false);
  let appReady = $state(false); // false until the map has rendered every node

  // --- observed links for the selected node ---
  let links = $state([]);
  let linksMeta = $state({ total: 0, capped: false });
  let linksLoading = $state(false);
  let linksError = $state(false);
  let hoveredNeighbor = $state('');
  let linkCtl; // AbortController for the in-flight request

  // Fetch links whenever the selection (or the network/activity filter that
  // scopes them) changes. The previous request is aborted so a fast reselect
  // never lands stale data. Respects the active map network filter.
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
    linksLoading = true;
    linksError = false;
    nodeLinks(pk, { net, active }, linkCtl.signal)
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

  // --- best-effort route from the selected node to a hovered node ---
  // When a node is selected and the cursor dwells on a *different* node, ask the
  // API for a reliability-weighted path between them. The route is drawn on the
  // map and explained in a panel beside the node detail. The fetch is debounced
  // (so panning across nodes doesn't fire a request each one) and aborted on
  // change so a fast move never lands a stale path.
  let hoveredPk = $state('');
  let hoveredNode = $state(null); // hovered node's metadata (for the panel header)
  let route = $state(null);
  let routeLoading = $state(false);
  let routeError = $state(false);
  let routeCtl; // AbortController for the in-flight request
  let routeTimer;
  const ROUTE_DWELL_MS = 280;

  // Tracks only the inputs (selection, hover target, filters) — never `route` or
  // the loading flags it sets — so resolving a route can't re-trigger the effect.
  $effect(() => {
    const from = selected;
    const to = hoveredPk;
    const net = filters.net;
    const active = filters.active;
    const enabled = routeEnabled;
    clearTimeout(routeTimer);
    routeCtl?.abort();
    // Route resolving is opt-in (Advanced), and only makes sense from one node to
    // a different one.
    if (!enabled || !from || !to || from === to) {
      route = null;
      routeLoading = false;
      routeError = false;
      return;
    }
    routeLoading = true;
    routeError = false;
    routeTimer = setTimeout(() => {
      routeCtl = new AbortController();
      routeQuery(from, to, { net, active }, routeCtl.signal)
        .then((d) => {
          route = d;
          routeLoading = false;
        })
        .catch((e) => {
          if (e?.name === 'AbortError') return;
          route = null;
          routeError = true;
          routeLoading = false;
        });
    }, ROUTE_DWELL_MS);
  });

  // Focus a neighbor from the link list: select it (which refetches its links).
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

  // Debounced search box so typing doesn't fire a request per keystroke.
  let searchInput = $state(initial.q);
  let searchTimer;
  function onSearchInput() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => (filters.q = searchInput.trim()), 300);
  }

  onMount(async () => {
    networkList = await fetchNetworks();
  });

  // The detail panel for a URL-restored node is populated by MapView once the
  // full node set has loaded (it calls onselect with the node's properties).
  function onSelect(props) {
    if (!props) {
      selected = '';
      selectedNode = null;
      return;
    }
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
      cluster: clustering,
      areas: showAreas,
      imported: showImported,
      globe,
      basemap,
      linkColor,
      live: liveEnabled,
      route: routeEnabled
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

  // A chooser option is active when its basemap matches. The two CARTO entries
  // share basemap 'auto', so they're told apart by the current theme.
  const isLayerActive = (o) =>
    o.basemap === 'auto' ? basemap === 'auto' && theme === o.theme : basemap === o.basemap;
  function chooseLayer(o) {
    basemap = o.basemap;
    setTheme(o.theme); // keep chrome matched to the tile style
    layerMenuOpen = false;
  }
  let currentLayer = $derived(LAYER_OPTIONS.find(isLayerActive) ?? LAYER_OPTIONS[0]);

  let activeFilterCount = $derived(
    filters.types.length + (filters.net ? 1 : 0) + (filters.active !== 'all' ? 1 : 0) + (filters.q ? 1 : 0)
  );

  // Summarize a found route for the panel header: hop count plus the weakest
  // (least-active) and oldest links, which is what makes a path look shaky.
  let routeSummary = $derived.by(() => {
    const hops = route?.found ? route.hops ?? [] : [];
    if (!hops.length) return null;
    let weakest = Infinity;
    let oldest = Infinity;
    for (const h of hops) {
      weakest = Math.min(weakest, h.recentActivity ?? 0);
      oldest = Math.min(oldest, h.lastSeen ?? 0);
    }
    return { hops: hops.length, weakest, oldest };
  });
  // The destination's display name: the hovered node's own name while routing,
  // falling back to the route payload's endpoint once it resolves.
  let routeToName = $derived(
    hoveredNode?.name ||
      (route?.found && route.nodes?.length ? route.nodes[route.nodes.length - 1]?.name : '') ||
      'this node'
  );
</script>

<MapView
  {view}
  {theme}
  {filters}
  {basemap}
  {linkColor}
  {clustering}
  {showImported}
  {showAreas}
  {globe}
  {selected}
  {links}
  {linksLoading}
  {networkNames}
  {hoveredNeighbor}
  {route}
  live={liveEnabled}
  onlive={(open) => (liveConnected = open)}
  onselect={onSelect}
  onhover={(pk, node) => {
    hoveredPk = pk;
    hoveredNode = node;
  }}
  onmove={(v) => (view = v)}
  onstatus={(s) => (status = s)}
  onready={() => (appReady = true)}
/>

<!-- Fullscreen preloader: covers the map until every node has rendered, then
     fades away. A sonar pulse behind the logo nods to the radio mesh. -->
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
          Couldn’t reach the API
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

<!-- Top bar -->
<header
  class="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-center justify-between gap-3 p-3"
>
  <div
    class="map-float pointer-events-auto flex items-center gap-2.5 rounded-xl border border-edge bg-elev/90 px-3 py-2 backdrop-blur"
  >
    <img src="logo.png" alt="" class="h-7 w-7" width="28" height="28" />
    <div class="leading-tight">
      <div class="flex items-center gap-2 text-[0.95rem] font-bold text-ink">
        MeshCore Map
        <span
          class="rounded-full border border-accent2/40 bg-accent2/10 px-1.5 py-0.5 text-[0.58rem] font-semibold uppercase leading-none tracking-wider text-accent2"
          >Alpha</span
        >
        {#if liveEnabled}
          <span
            class="flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[0.58rem] font-semibold uppercase leading-none tracking-wider transition-colors {liveConnected ? 'border-accent/40 bg-accent/10 text-accent' : 'border-edge text-dim'}"
            title={liveConnected ? 'Receiving live adverts' : 'Connecting to live feed…'}
          >
            <span class="live-dot {liveConnected ? 'is-on' : ''}"></span>
            Live
          </span>
        {/if}
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
  </div>

  <div class="pointer-events-auto flex items-center gap-2">
    <a
      href="https://meshcore.ninja"
      class="map-float hidden rounded-xl border border-edge bg-elev/90 px-3 py-2 text-[0.85rem] text-dim backdrop-blur hover:text-ink sm:block"
      >meshcore.ninja ↗</a
    >
    <button
      onclick={toggleTheme}
      aria-label="Toggle theme"
      class="map-float grid h-[38px] w-[38px] place-items-center rounded-xl border border-edge bg-elev/90 text-dim backdrop-blur hover:text-ink"
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

<!-- Filter panel: sidebar on desktop, bottom sheet on mobile -->
<button
  onclick={() => (panelOpen = !panelOpen)}
  class="map-float absolute bottom-4 left-4 z-20 flex items-center gap-2 rounded-xl border border-edge bg-elev/90 px-3.5 py-2.5 text-[0.85rem] font-medium text-ink backdrop-blur sm:hidden"
>
  <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
    <path d="M3 6h18M6 12h12M10 18h4" stroke-linecap="round" />
  </svg>
  Filters{#if activeFilterCount}<span class="rounded-full bg-accent px-1.5 text-[0.7rem] text-bg">{activeFilterCount}</span>{/if}
</button>

<aside
  class="map-float absolute z-20 flex flex-col gap-4 border-edge bg-elev/95 backdrop-blur
    {panelOpen ? 'translate-y-0' : 'translate-y-full'} bottom-0 inset-x-0 max-h-[75vh] overflow-y-auto rounded-t-2xl border-t p-4 transition-transform
    sm:inset-x-auto sm:bottom-auto sm:left-3 sm:top-28 sm:max-h-[calc(100vh-9rem)] sm:w-72 sm:translate-y-0 sm:rounded-xl sm:border"
>
  <div class="flex items-center justify-between sm:hidden">
    <span class="font-semibold text-ink">Filters</span>
    <button onclick={() => (panelOpen = false)} aria-label="Close" class="text-dim hover:text-ink">
      <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6 6 18" stroke-linecap="round" /></svg>
    </button>
  </div>

  <!-- Search -->
  <label class="flex items-center gap-2 rounded-lg border border-edge bg-bg px-2.5 py-2">
    <svg class="h-4 w-4 shrink-0 text-dim" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
      <circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" stroke-linecap="round" />
    </svg>
    <input
      bind:value={searchInput}
      oninput={onSearchInput}
      placeholder="Name or public-key prefix"
      class="w-full bg-transparent text-[0.85rem] text-ink outline-none placeholder:text-dim"
    />
    {#if searchInput}
      <button onclick={() => { searchInput = ''; filters.q = ''; }} aria-label="Clear search" class="text-dim hover:text-ink">
        <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6 6 18" stroke-linecap="round" /></svg>
      </button>
    {/if}
  </label>

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
      <button onclick={() => (filters.types = [])} class="mt-1.5 text-[0.72rem] text-accent2 hover:underline">Reset to all types</button>
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
        >{a.label}</button>
      {/each}
    </div>
  </div>

  <!-- Display -->
  <div>
    <div class="mb-1.5 text-[0.7rem] font-semibold uppercase tracking-wide text-dim">Display</div>
    <div class="flex flex-col gap-1">
      {#each [{ label: 'Live advert pulses', get: () => liveEnabled, set: (v) => (liveEnabled = v) }, { label: '3D globe view', get: () => globe, set: (v) => (globe = v) }, { label: 'Cluster nearby nodes', get: () => clustering, set: (v) => (clustering = v) }, { label: 'Imported nodes (meshcore.io)', get: () => showImported, set: (v) => (showImported = v) }, { label: 'Network coverage areas', get: () => showAreas, set: (v) => (showAreas = v) }] as row}
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

  <!-- Advanced -->
  <details class="group">
    <summary
      class="flex cursor-pointer list-none items-center justify-between text-[0.7rem] font-semibold uppercase tracking-wide text-dim [&::-webkit-details-marker]:hidden"
    >
      Advanced
      <svg class="h-3.5 w-3.5 transition-transform group-open:rotate-180" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <path d="m6 9 6 6 6-6" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </summary>
    <div class="mt-2.5">
      <button
        onclick={() => (routeEnabled = !routeEnabled)}
        class="flex w-full items-center justify-between rounded-lg px-1 py-1.5 text-[0.85rem] text-ink hover:bg-elev2"
      >
        <span class="flex flex-col items-start">
          Resolve routes on hover
          <span class="text-[0.68rem] text-dim">Draw a best-effort path to the hovered node</span>
        </span>
        <span class="relative h-5 w-9 shrink-0 rounded-full transition-colors {routeEnabled ? 'bg-accent' : 'bg-edge'}">
          <span class="absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all {routeEnabled ? 'left-[1.125rem]' : 'left-0.5'}"></span>
        </span>
      </button>

      <div class="mb-1.5 mt-3 text-[0.72rem] text-dim">Link colour</div>
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
  </details>
</aside>

<!-- Basemap / layer chooser + attribution (bottom-left) -->
{#if layerMenuOpen || attribOpen}
  <button
    class="fixed inset-0 z-10 cursor-default"
    onclick={() => { layerMenuOpen = false; attribOpen = false; }}
    aria-label="Close"
    tabindex="-1"
  ></button>
{/if}
<div class="absolute left-4 bottom-20 z-20 flex items-end gap-2 sm:bottom-6">
  <!-- Layer switch -->
  <div class="relative">
    {#if layerMenuOpen}
      <div class="map-float absolute bottom-full left-0 mb-2 max-w-[calc(100vw-2rem)] overflow-x-auto rounded-xl border border-edge bg-elev/95 p-2.5 backdrop-blur" transition:fade={{ duration: 120 }}>
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
      onclick={() => { layerMenuOpen = !layerMenuOpen; attribOpen = false; }}
      class="map-float flex h-[38px] items-center gap-2 rounded-xl border border-edge bg-elev/90 px-3 text-[0.85rem] font-medium text-ink backdrop-blur hover:border-accent2/60"
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

  <!-- Attribution -->
  <div class="relative">
    {#if attribOpen}
      <div class="map-float absolute bottom-full left-0 mb-2 w-max max-w-[calc(100vw-2rem)] rounded-lg border border-edge bg-elev/95 px-2.5 py-1.5 text-[0.72rem] text-dim backdrop-blur" transition:fade={{ duration: 120 }}>
        {attribution}
      </div>
    {/if}
    <button
      onclick={() => { attribOpen = !attribOpen; layerMenuOpen = false; }}
      class="map-float grid h-[38px] w-[38px] place-items-center rounded-xl border border-edge bg-elev/90 text-dim backdrop-blur hover:text-ink"
      aria-label="Map data attribution"
      aria-expanded={attribOpen}
    >
      <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <circle cx="12" cy="12" r="9.5" />
        <path d="M12 11v5" stroke-linecap="round" />
        <circle cx="12" cy="7.6" r="0.6" fill="currentColor" stroke="none" />
      </svg>
    </button>
  </div>
</div>

<!-- Best-effort route panel, sat just left of the node detail. Hover-driven, so
     it is desktop-only (sm+). Shown whenever a route is being computed, found, or
     known-absent for the currently hovered target. -->
{#if selectedNode && (routeLoading || routeError || route)}
  <aside
    id="route-panel"
    transition:fly={{ x: 340, duration: 220 }}
    class="map-float absolute top-20 right-[21rem] z-30 hidden w-72 max-h-[calc(100vh-6rem)] overflow-y-auto rounded-xl border border-[#ffb454]/70 bg-elev/95 p-4 backdrop-blur sm:block"
  >
    <div class="flex items-center gap-2">
      <svg class="h-4 w-4 shrink-0" style="color:#ffb454" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="5" cy="19" r="2"/><circle cx="19" cy="5" r="2"/><path d="M7 18c4-1 9-6 10-11"/></svg>
      <h3 class="truncate text-[0.92rem] font-semibold text-ink">Route to {routeToName}</h3>
    </div>

    {#if routeLoading}
      <div class="flex items-center gap-2 py-3 text-[0.8rem] text-dim">
        <span class="h-3.5 w-3.5 animate-spin rounded-full border-2 border-edge border-t-[#ffb454]"></span>
        Finding a path…
      </div>
    {:else if routeError}
      <div class="py-3 text-[0.8rem] text-dim">Couldn’t compute a route.</div>
    {:else if route && !route.found}
      <div class="py-3 text-[0.8rem] text-dim">No known path through observed links.</div>
    {:else if route?.found}
      {#if routeSummary}
        <p class="mt-1 text-[0.74rem] text-dim">
          <span class="text-ink">{routeSummary.hops}</span>
          {routeSummary.hops === 1 ? 'hop' : 'hops'} · weakest link
          <span title="Recent activity score">⚡ {routeSummary.weakest.toFixed(1)}</span>,
          seen {agoLabel(routeSummary.oldest) ?? '—'}
        </p>
      {/if}
      <ol class="mt-3 flex flex-col">
        {#each route.nodes as n, i (n.pubkey + i)}
          <li class="flex items-center gap-2">
            <span class="h-2.5 w-2.5 shrink-0 rounded-full" style="background:{typeColor(n.type)}"></span>
            <span class="truncate text-[0.84rem] text-ink">{n.name || 'Unnamed'}</span>
            {#if i === 0}
              <span class="shrink-0 rounded border border-edge px-1 text-[0.58rem] uppercase text-dim">from</span>
            {:else if i === route.nodes.length - 1}
              <span class="shrink-0 rounded border border-[#ffb454]/60 px-1 text-[0.58rem] uppercase text-[#ffb454]">to</span>
            {/if}
            {#if !n.hasGps}
              <span class="shrink-0 rounded border border-edge px-1 text-[0.58rem] uppercase text-dim" title="No GPS — this hop isn’t drawn on the map">no gps</span>
            {/if}
          </li>
          {#if i < (route.hops?.length ?? 0)}
            {@const h = route.hops[i]}
            <li class="my-0.5 ml-[0.3rem] flex items-center gap-2 border-l border-dashed border-[#ffb454]/50 pl-3 text-[0.68rem] text-dim">
              <span title="Recent activity score">⚡ {(h.recentActivity ?? 0).toFixed(1)}</span>
              <span>{agoLabel(h.lastSeen) ?? '—'}</span>
              <span>{(h.packetCount ?? 0).toLocaleString()} pkts</span>
            </li>
          {/if}
        {/each}
      </ol>
    {/if}
  </aside>
{/if}

<!-- Selected node detail -->
{#if selectedNode}
  <aside
    id="node-detail"
    transition:fly={{ x: 340, duration: 260 }}
    class="map-float absolute bottom-0 inset-x-0 z-30 rounded-t-2xl border-t border-[#5aa9ff] bg-elev/95 p-4 backdrop-blur
      sm:inset-x-auto sm:bottom-auto sm:top-20 sm:right-3 sm:w-80 sm:max-h-[calc(100vh-6rem)] sm:overflow-y-auto sm:rounded-xl sm:border"
  >
    <div class="flex items-start justify-between gap-3">
      <div class="flex items-center gap-2">
        <span class="h-3 w-3 rounded-full" style="background:{typeColor(selectedNode.type)}"></span>
        <h2 class="text-[1rem] font-semibold text-ink">{selectedNode.name || 'Unnamed node'}</h2>
      </div>
      <button onclick={() => onSelect(null)} aria-label="Close" class="text-dim hover:text-ink">
        <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6 6 18" stroke-linecap="round" /></svg>
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
        <div class="py-2 text-[0.8rem] text-dim">Couldn’t load links.</div>
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
                class="flex w-full flex-col gap-1 rounded-lg border border-edge bg-bg/60 px-2.5 py-2 text-left transition hover:border-accent hover:bg-elev2"
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

<style>
  .live-dot {
    width: 6px;
    height: 6px;
    border-radius: 9999px;
    background: var(--color-dim);
  }
  .live-dot.is-on {
    background: var(--color-accent);
    animation: live-blink 1.6s ease-in-out infinite;
  }
  @keyframes live-blink {
    0%,
    100% {
      opacity: 1;
      box-shadow: 0 0 0 0 color-mix(in srgb, var(--color-accent) 60%, transparent);
    }
    50% {
      opacity: 0.5;
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-accent) 0%, transparent);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .live-dot.is-on {
      animation: none;
    }
  }
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
