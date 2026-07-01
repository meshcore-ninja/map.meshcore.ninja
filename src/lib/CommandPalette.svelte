<script>
  import { Command, Dialog } from 'bits-ui';
  import Flag from '$lib/Flag.svelte';
  import { TYPE_LABEL, TYPE_ICON } from '$lib/filters.js';
  import { shortKey, agoLabel, fmtCoords, nodeBands, nodeNetworkTags, nodeStatus, bandBadge } from '$lib/nodeMeta.js';

  let {
    open = $bindable(false),
    nodes = [],
    networks = [],
    networksCatalog = {},
    bandsCatalog = {},
    isMac = true,
    onselect = () => {},
    onselectNetwork = () => {},
    onselectLocation = () => {}
  } = $props();

  let query = $state('');
  let mode = $state('nodes');

  const MODES = [
    { id: 'nodes', label: 'Nodes' },
    { id: 'locations', label: 'Locations' }
  ];
  const LOCATION_LIMIT = 8;

  // Pre-lowered search index, rebuilt only when the node set changes. Fuzzy
  // matching (Fuse.js) was too slow over the ~50k-node snapshot, so we run a
  // plain tokenised substring match instead — fast enough to filter on every
  // keystroke without debouncing.
  let index = $derived(
    nodes.map((node) => ({
      node,
      name: (node.name ?? '').toLowerCase(),
      pubkey: (node.pubkey ?? '').toLowerCase()
    }))
  );

  const RESULT_LIMIT = 50;
  // With no query, show the most-recently-heard live nodes. Imported directory
  // nodes carry a map-publish timestamp, which can look brand new even though it
  // is not a fresh advert, so keep them after live nodes.
  function recentSort(a, b) {
    if (!!a.imported !== !!b.imported) return a.imported ? 1 : -1;
    return (b.lastAdvertAt ?? 0) - (a.lastAdvertAt ?? 0);
  }
  let recent = $derived(
    [...nodes].sort(recentSort).slice(0, RESULT_LIMIT)
  );

  // Rank a single entry against the query. Higher is better; -1 excludes it.
  // Prefix > word-boundary > substring on the name, then pubkey, then a
  // token-AND fallback so multi-word queries ("solar repeater dov") still hit.
  function score(entry, q, tokens) {
    const { name, pubkey } = entry;
    if (name.startsWith(q)) return 1000 - name.length;
    const wb = name.indexOf(' ' + q);
    if (wb >= 0) return 900 - wb;
    const sub = name.indexOf(q);
    if (sub >= 0) return 800 - sub;
    if (pubkey.startsWith(q)) return 700;
    if (pubkey.includes(q)) return 600;
    for (const t of tokens) {
      if (!name.includes(t) && !pubkey.includes(t)) return -1;
    }
    return 400;
  }

  let results = $derived.by(() => {
    const q = query.trim().toLowerCase();
    if (!q) return recent;
    const tokens = q.split(/\s+/).filter(Boolean);
    const scored = [];
    for (const entry of index) {
      const s = score(entry, q, tokens);
      if (s >= 0) scored.push({ node: entry.node, s });
    }
    scored.sort((a, b) => b.s - a.s);
    return scored.slice(0, RESULT_LIMIT).map((r) => r.node);
  });

  // Networks are searchable too (by name, short name, aka or id). Shown as a
  // small group above the node matches; only when there's a query.
  const NET_LIMIT = 8;
  let networkIndex = $derived(
    networks.map((net) => ({
      net,
      name: (net.name ?? '').toLowerCase(),
      short: (net.short_name ?? '').toLowerCase(),
      aka: (net.also_known_as ?? []).join(' ').toLowerCase(),
      id: (net.id ?? '').toLowerCase()
    }))
  );
  function scoreNet(entry, q, tokens) {
    if (entry.name.startsWith(q) || entry.short.startsWith(q)) return 1000;
    const hay = `${entry.name} ${entry.short} ${entry.aka} ${entry.id}`;
    if (hay.includes(q)) return 700;
    for (const t of tokens) if (!hay.includes(t)) return -1;
    return 400;
  }
  let networkResults = $derived.by(() => {
    if (mode !== 'nodes') return [];
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const tokens = q.split(/\s+/).filter(Boolean);
    const scored = [];
    for (const entry of networkIndex) {
      const s = scoreNet(entry, q, tokens);
      if (s >= 0) scored.push({ net: entry.net, s });
    }
    scored.sort((a, b) => b.s - a.s);
    return scored.slice(0, NET_LIMIT).map((r) => r.net);
  });

  let locationResults = $state([]);
  let locationLoading = $state(false);
  let locationError = $state(false);

  function locationTitle(feature) {
    const p = feature.properties ?? {};
    return p.name || p.street || p.city || p.county || p.state || p.country || 'Unnamed place';
  }

  function locationSubtitle(feature) {
    const p = feature.properties ?? {};
    const parts = [p.street, p.city, p.county, p.state, p.country].filter(Boolean);
    return [...new Set(parts.filter((part) => part !== locationTitle(feature)))].join(', ');
  }

  function locationType(feature) {
    const p = feature.properties ?? {};
    return [p.osm_value, p.osm_key].filter(Boolean).join(' · ') || 'Place';
  }

  function locationKey(feature, index) {
    const p = feature.properties ?? {};
    return `loc:${p.osm_type ?? ''}:${p.osm_id ?? ''}:${feature.geometry.coordinates.join(',')}:${index}`;
  }

  let showingNodes = $derived(mode === 'nodes');
  let locationFallback = $derived(
    showingNodes && query.trim().length >= 2 && !networkResults.length && !results.length
  );
  let showingLocations = $derived(mode === 'locations' || locationFallback);

  $effect(() => {
    if (!showingLocations) {
      locationResults = [];
      locationLoading = false;
      locationError = false;
      return;
    }

    const q = query.trim();
    if (q.length < 2) {
      locationResults = [];
      locationLoading = false;
      locationError = false;
      return;
    }

    const ctl = new AbortController();
    const timer = setTimeout(() => {
      locationLoading = true;
      locationError = false;
      const sp = new URLSearchParams({ q, limit: String(LOCATION_LIMIT), lang: 'en' });
      fetch(`https://photon.komoot.io/api/?${sp}`, { signal: ctl.signal })
        .then((r) => {
          if (!r.ok) throw new Error(`Photon ${r.status}`);
          return r.json();
        })
        .then((d) => {
          locationResults = (d.features ?? []).filter((f) => {
            const coords = f.geometry?.coordinates ?? [];
            return Number.isFinite(coords[0]) && Number.isFinite(coords[1]);
          });
          locationLoading = false;
        })
        .catch((e) => {
          if (e?.name === 'AbortError') return;
          locationResults = [];
          locationLoading = false;
          locationError = true;
        });
    }, 250);

    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  });

  let emptyText = $derived.by(() => {
    if (locationFallback) return `No nodes or networks found for “${query}”.`;
    if (showingNodes) return query.trim() ? `No matches for “${query}”.` : 'No nodes yet.';
    if (query.trim().length < 2) return 'Type at least 2 characters to search places.';
    if (locationLoading) return 'Searching locations…';
    if (locationError) return 'Location search is unavailable right now.';
    return `No locations for “${query}”.`;
  });

  // Fresh query every time the palette opens.
  $effect(() => {
    if (open) {
      query = '';
      mode = 'nodes';
    }
  });

  // Show the results scrollbar only while actively scrolling: flag on each
  // scroll event and clear it again after a short idle.
  let scrolling = $state(false);
  let scrollTimer;
  function onListScroll() {
    scrolling = true;
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => (scrolling = false), 700);
  }

  function choose(node) {
    open = false;
    onselect(node);
  }

  function chooseNetwork(net) {
    open = false;
    onselectNetwork(net);
  }

  function chooseLocation(feature) {
    open = false;
    const coords = feature.geometry.coordinates;
    onselectLocation({
      lon: coords[0],
      lat: coords[1],
      name: locationTitle(feature),
      subtitle: locationSubtitle(feature),
      feature
    });
  }

  function toggleMode() {
    mode = mode === 'nodes' ? 'locations' : 'nodes';
  }

  function onPaletteKeydown(e) {
    if (e.key !== 'Tab' || e.metaKey || e.ctrlKey || e.altKey) return;
    e.preventDefault();
    toggleMode();
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Portal>
    <Dialog.Overlay class="fixed inset-0 z-[60] bg-black/50 backdrop-blur-sm" />
    <Dialog.Content
      class="map-float fixed left-1/2 top-[12vh] z-[61] flex max-h-[76vh] w-[min(46rem,calc(100vw-1.5rem))] -translate-x-1/2 flex-col overflow-hidden rounded-2xl border border-edge bg-elev/95 backdrop-blur"
    >
      <Dialog.Title class="sr-only">Search nodes and networks</Dialog.Title>
      <Dialog.Description class="sr-only">
        Search all nodes by name or public key, and all networks by name, then open one on the map.
      </Dialog.Description>

      <Command.Root shouldFilter={false} class="flex min-h-0 flex-col" onkeydown={onPaletteKeydown}>
        <!-- Search field -->
        <div class="flex items-center gap-2.5 border-b border-edge px-4 py-3">
          <svg class="h-5 w-5 shrink-0 text-dim" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" stroke-linecap="round" />
          </svg>
          <div class="relative min-w-0 flex-1">
            {#if !query}
              <div class="pointer-events-none absolute inset-y-0 left-0 flex min-w-0 items-center text-[0.95rem] text-dim">
                {#if showingNodes}
                  <span class="truncate">Search nodes or networks…</span>
                  <span class="ml-1.5 inline-flex shrink-0 items-center gap-1">
                    <span>or press</span>
                    <kbd class="rounded border border-edge bg-bg px-1 py-0.5 text-[0.68rem] font-medium leading-none">Tab</kbd>
                    <span>to search locations</span>
                  </span>
                {:else}
                  <span class="truncate">Search locations…</span>
                {/if}
              </div>
            {/if}
            <Command.Input
              bind:value={query}
              autofocus
              placeholder=""
              class="relative w-full bg-transparent text-[0.95rem] text-ink outline-none"
            />
          </div>
          {#if !showingNodes || query}
            <div class="hidden shrink-0 items-center gap-1 rounded-lg border border-edge bg-bg p-0.5 sm:flex">
              {#each MODES as item}
                <button
                  type="button"
                  onclick={() => (mode = item.id)}
                  class="rounded-md px-2 py-1 text-[0.68rem] font-semibold transition {mode === item.id ? 'bg-elev2 text-ink' : 'text-dim hover:text-ink'}"
                  aria-pressed={mode === item.id}
                >
                  {item.label}
                </button>
              {/each}
            </div>
          {/if}
          <kbd class="hidden shrink-0 rounded border border-edge bg-bg px-1.5 py-0.5 text-[0.7rem] font-medium text-dim sm:block">
            Esc
          </kbd>
        </div>

        <Command.List
          onscroll={onListScroll}
          class="cmd-list min-h-0 flex-1 overflow-y-auto overscroll-contain py-1 {scrolling ? 'is-scrolling' : ''}"
        >
          {#if showingNodes && !networkResults.length && !results.length}
            <div class="px-4 {showingLocations ? 'pb-2 pt-5' : 'py-10'} text-center text-[0.85rem] text-dim">
              {emptyText}
            </div>
          {/if}
          {#if !showingNodes && !locationResults.length}
            <div class="px-4 py-10 text-center text-[0.85rem] text-dim">
              {emptyText}
            </div>
          {/if}
          {#if locationFallback && !locationResults.length}
            <div class="px-4 pb-7 pt-2 text-center text-[0.78rem] text-dim">
              {#if locationLoading}
                Searching locations…
              {:else if locationError}
                Location search is unavailable right now.
              {:else}
                No location matches either.
              {/if}
            </div>
          {/if}

          <!-- Matching networks -->
          {#if showingNodes && networkResults.length}
            <div class="px-4 pb-1 pt-2 text-[0.68rem] font-semibold uppercase tracking-wide text-dim">Networks</div>
            {#each networkResults as net (net.id)}
              {@const band = bandBadge(String(net.radio?.frequency ?? ''), bandsCatalog)}
              {@const countries = net.coverage?.countries ?? []}
              <Command.Item
                value={`net:${net.id}`}
                keywords={[net.name ?? '', net.short_name ?? '']}
                onSelect={() => chooseNetwork(net)}
                class="group mx-1 flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 aria-selected:bg-elev2"
              >
                <!-- Network icon (neutral silver) -->
                <svg
                  viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                  stroke-linecap="round" stroke-linejoin="round"
                  class="h-5 w-5 shrink-0 self-center text-dim" aria-hidden="true"
                >
                  <circle cx="12" cy="12" r="9" /><path d="M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18M3 12h18" />
                </svg>

                <div class="min-w-0 flex-1">
                  <div class="truncate text-[0.95rem] font-medium text-ink">{net.name || net.id}</div>
                  <div class="mt-0.5 flex flex-wrap items-center gap-1.5">
                    {#each countries.slice(0, 8) as cc}
                      <Flag code={cc} class="h-2.5 w-3.5 opacity-70" />
                    {/each}
                    {#if net.short_name && net.short_name !== net.name}
                      <span class="text-[0.72rem] text-dim">{net.short_name}</span>
                    {/if}
                  </div>
                </div>

                <div class="shrink-0 text-right">
                  <div class="flex items-center justify-end gap-2">
                    <span class="text-[0.8rem] text-dim">Network</span>
                    {#if band}
                      <span
                        class="rounded-full border px-1.5 py-0.5 text-[0.62rem] font-semibold leading-none"
                        style="color:{band.color};border-color:color-mix(in srgb,{band.color} 45%,transparent)"
                      >{band.region}</span>
                    {/if}
                  </div>
                </div>
              </Command.Item>
            {/each}
          {/if}

          <!-- Matching nodes -->
          {#if showingNodes && networkResults.length && results.length}
            <div class="px-4 pb-1 pt-2 text-[0.68rem] font-semibold uppercase tracking-wide text-dim">Nodes</div>
          {/if}

          {#if showingLocations && locationResults.length}
            <div class="px-4 pb-1 pt-2 text-[0.68rem] font-semibold uppercase tracking-wide text-dim">Locations</div>
            {#each locationResults as place, i (locationKey(place, i))}
              <Command.Item
                value={locationKey(place, i)}
                keywords={[locationTitle(place), locationSubtitle(place)]}
                onSelect={() => chooseLocation(place)}
                class="group mx-1 flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 aria-selected:bg-elev2"
              >
                <svg
                  viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                  stroke-linecap="round" stroke-linejoin="round"
                  class="h-5 w-5 shrink-0 self-center text-dim" aria-hidden="true"
                >
                  <path d="M20 10c0 5-8 12-8 12S4 15 4 10a8 8 0 1 1 16 0Z" />
                  <circle cx="12" cy="10" r="3" />
                </svg>

                <div class="min-w-0 flex-1">
                  <div class="truncate text-[0.95rem] font-medium text-ink">{locationTitle(place)}</div>
                  <div class="mt-0.5 flex min-w-0 items-center gap-1.5 text-[0.72rem] text-dim">
                    {#if place.properties?.countrycode}
                      <Flag code={place.properties.countrycode} class="h-2.5 w-3.5 opacity-80" />
                    {/if}
                    <span class="truncate">{locationSubtitle(place) || locationType(place)}</span>
                  </div>
                </div>

                <div class="shrink-0 text-right">
                  <div class="text-[0.8rem] text-dim">{locationType(place)}</div>
                  <div class="mt-0.5 font-mono text-[0.72rem] text-dim">
                    {fmtCoords(place.geometry.coordinates[1], place.geometry.coordinates[0])}
                  </div>
                </div>
              </Command.Item>
            {/each}
          {/if}

          {#if showingNodes}
          {#each results as node (node.pubkey)}
            {@const bands = nodeBands(node.networks, networksCatalog, bandsCatalog, node.band)}
            {@const tags = nodeNetworkTags(node.networks, networksCatalog)}
            {@const status = nodeStatus(node)}
            <Command.Item
              value={node.pubkey}
              keywords={[node.name ?? '']}
              onSelect={() => choose(node)}
              class="group mx-1 flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 aria-selected:bg-elev2"
            >
              <!-- Type icon (neutral silver, matching the directory rows) -->
              <svg
                viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                stroke-linecap="round" stroke-linejoin="round"
                class="h-5 w-5 shrink-0 self-center text-dim" aria-hidden="true"
                >{@html TYPE_ICON[node.type] ?? ''}</svg
              >

              <!-- Name + key + network chips -->
              <div class="min-w-0 flex-1">
                <div class="flex min-w-0 items-center gap-1.5">
                  <span class="truncate text-[0.95rem] font-medium text-ink">{node.name || 'Unnamed node'}</span>
                  {#if status.unsigned}
                    <span class="shrink-0 rounded-full border border-warn/50 px-1.5 py-0.5 text-[0.6rem] font-semibold uppercase leading-none tracking-wide text-warn">Unsigned</span>
                  {/if}
                  {#if status.stale}
                    <span class="shrink-0 rounded-full border border-edge px-1.5 py-0.5 text-[0.6rem] font-semibold uppercase leading-none tracking-wide text-dim">Stale</span>
                  {/if}
                </div>
                <div class="font-mono text-[0.72rem] text-dim">{shortKey(node.pubkey)}</div>
                {#if tags.length}
                  <div class="mt-1.5 flex flex-wrap gap-1">
                    {#each tags.slice(0, 6) as tag (tag.id)}
                      <span class="inline-flex items-center gap-1 rounded bg-elev2 px-1.5 py-0.5 text-[0.68rem] leading-none text-dim">
                        <Flag code={tag.code} class="h-2.5 w-3.5 opacity-70" />
                        {tag.name}
                      </span>
                    {/each}
                    {#if tags.length > 6}
                      <span class="rounded bg-elev2 px-1.5 py-0.5 text-[0.68rem] leading-none text-dim">+{tags.length - 6}</span>
                    {/if}
                  </div>
                {/if}
              </div>

              <!-- Type label + band + coords + age -->
              <div class="shrink-0 text-right">
                <div class="flex items-center justify-end gap-2">
                  <span class="text-[0.8rem] capitalize text-dim">{TYPE_LABEL[node.type] ?? 'unknown'}</span>
                  {#each bands as b (b.region)}
                    <span
                      class="rounded-full border px-1.5 py-0.5 text-[0.62rem] font-semibold leading-none"
                      style="color:{b.color};border-color:color-mix(in srgb,{b.color} 45%,transparent)"
                    >{b.region}</span>
                  {/each}
                </div>
                <div class="mt-0.5 font-mono text-[0.72rem] text-dim">{fmtCoords(node.lat, node.lon) || '—'}</div>
                <div class="text-[0.72rem] text-dim">
                  {#if agoLabel(node.lastAdvertAt)}{status.unsigned ? 'map publish ' : ''}{agoLabel(node.lastAdvertAt)}{:else}—{/if}
                </div>
              </div>
            </Command.Item>
          {/each}
          {/if}
        </Command.List>

        <!-- Footer hint -->
        <div class="flex items-center justify-between border-t border-edge px-4 py-2 text-[0.7rem] text-dim">
          <span class="flex items-center gap-3">
            <span class="flex items-center gap-1"><kbd class="rounded border border-edge bg-bg px-1 py-0.5">↑↓</kbd> navigate</span>
            <span class="flex items-center gap-1"><kbd class="rounded border border-edge bg-bg px-1 py-0.5">↵</kbd> open</span>
            <span class="hidden items-center gap-1 sm:flex"><kbd class="rounded border border-edge bg-bg px-1 py-0.5">Tab</kbd> {showingNodes ? 'locations' : 'nodes'}</span>
          </span>
          <span>
            {#if showingNodes}
              {results.length}{results.length === RESULT_LIMIT ? '+' : ''} nodes{#if locationFallback && (locationLoading || locationResults.length)} · {locationLoading ? 'searching locations' : `${locationResults.length}${locationResults.length === LOCATION_LIMIT ? '+' : ''} locations`}{/if}
            {:else if locationLoading}
              searching
            {:else}
              {locationResults.length}{locationResults.length === LOCATION_LIMIT ? '+' : ''} locations
            {/if}
          </span>
        </div>
      </Command.Root>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

<style>
  /* Auto-hiding results scrollbar: the track keeps its width (no layout shift),
     but the thumb stays transparent until `.is-scrolling` is toggled on while
     the user is actively scrolling. */
  :global(.cmd-list) {
    scrollbar-width: thin;
    scrollbar-color: transparent transparent;
  }
  :global(.cmd-list.is-scrolling) {
    scrollbar-color: var(--color-edge) transparent;
  }
  :global(.cmd-list::-webkit-scrollbar) {
    width: 8px;
  }
  :global(.cmd-list::-webkit-scrollbar-thumb) {
    border-radius: 9999px;
    background-color: transparent;
    transition: background-color 0.3s ease;
  }
  :global(.cmd-list.is-scrolling::-webkit-scrollbar-thumb) {
    background-color: var(--color-edge);
  }
</style>
