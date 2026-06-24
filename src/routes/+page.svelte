<script>
  import { onMount } from 'svelte';
  import MapView from '$lib/MapView.svelte';
  import { networks as fetchNetworks } from '$lib/api.js';
  import { NODE_TYPES, ACTIVITY, typeColor, TYPE_LABEL } from '$lib/filters.js';
  import { readState, writeState } from '$lib/urlState.js';

  // --- theme (mirrors the pre-paint bootstrap in app.html) ---
  let theme = $state('dark');
  onMount(() => {
    theme = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  });
  function toggleTheme() {
    theme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem('theme', theme);
    } catch (e) {
      /* ignore */
    }
  }

  // --- state, seeded from the URL so views are shareable & reload-safe ---
  const initial = readState();
  let view = $state({ z: initial.z, lat: initial.lat, lon: initial.lon });
  let filters = $state({ types: initial.types, net: initial.net, active: initial.active, q: initial.q });
  let selected = $state(initial.sel);
  let selectedNode = $state(null);
  let clustering = $state(initial.cluster);
  let showAreas = $state(initial.areas);
  let status = $state({ loading: true });
  let networkList = $state([]);
  let panelOpen = $state(false);

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
      areas: showAreas
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

  let activeFilterCount = $derived(
    filters.types.length + (filters.net ? 1 : 0) + (filters.active !== 'all' ? 1 : 0) + (filters.q ? 1 : 0)
  );
</script>

<MapView
  {view}
  {theme}
  {filters}
  {clustering}
  {showAreas}
  {selected}
  onselect={onSelect}
  onmove={(v) => (view = v)}
  onstatus={(s) => (status = s)}
/>

<!-- Top bar -->
<header
  class="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-center justify-between gap-3 p-3"
>
  <div
    class="pointer-events-auto flex items-center gap-2.5 rounded-xl border border-edge bg-elev/90 px-3 py-2 backdrop-blur"
  >
    <img src="logo.png" alt="" class="h-7 w-7" width="28" height="28" />
    <div class="leading-tight">
      <div class="flex items-center gap-2 text-[0.95rem] font-bold text-ink">
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
          {status.shown.toLocaleString()}{status.shown !== status.total
            ? ` of ${status.total.toLocaleString()}`
            : ''} nodes
        {:else}
          Node map
        {/if}
      </div>
    </div>
  </div>

  <div class="pointer-events-auto flex items-center gap-2">
    <a
      href="https://meshcore.ninja"
      class="hidden rounded-xl border border-edge bg-elev/90 px-3 py-2 text-[0.85rem] text-dim backdrop-blur hover:text-ink sm:block"
      >meshcore.ninja ↗</a
    >
    <button
      onclick={toggleTheme}
      aria-label="Toggle theme"
      class="grid h-[38px] w-[38px] place-items-center rounded-xl border border-edge bg-elev/90 text-dim backdrop-blur hover:text-ink"
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
  class="absolute bottom-4 left-4 z-20 flex items-center gap-2 rounded-xl border border-edge bg-elev/90 px-3.5 py-2.5 text-[0.85rem] font-medium text-ink backdrop-blur sm:hidden"
>
  <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
    <path d="M3 6h18M6 12h12M10 18h4" stroke-linecap="round" />
  </svg>
  Filters{#if activeFilterCount}<span class="rounded-full bg-accent px-1.5 text-[0.7rem] text-bg">{activeFilterCount}</span>{/if}
</button>

<aside
  class="absolute z-20 flex flex-col gap-4 border-edge bg-elev/95 backdrop-blur
    {panelOpen ? 'translate-y-0' : 'translate-y-full'} bottom-0 inset-x-0 max-h-[75vh] overflow-y-auto rounded-t-2xl border-t p-4 transition-transform
    sm:inset-x-auto sm:bottom-auto sm:left-3 sm:top-20 sm:max-h-[calc(100vh-7rem)] sm:w-72 sm:translate-y-0 sm:rounded-xl sm:border"
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
      {#each [{ label: 'Cluster nearby nodes', get: () => clustering, set: (v) => (clustering = v) }, { label: 'Network coverage areas', get: () => showAreas, set: (v) => (showAreas = v) }] as row}
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
</aside>

<!-- Selected node detail -->
{#if selectedNode}
  <aside
    class="absolute bottom-0 inset-x-0 z-30 rounded-t-2xl border-t border-edge bg-elev/95 p-4 backdrop-blur
      sm:inset-x-auto sm:bottom-4 sm:right-4 sm:w-80 sm:rounded-xl sm:border"
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
      <div><dt class="text-dim">Type</dt><dd class="capitalize text-ink">{TYPE_LABEL[selectedNode.type] ?? 'unknown'}</dd></div>
      <div><dt class="text-dim">Last advert</dt><dd class="text-ink">{agoLabel(selectedNode.lastAdvertAt) ?? '—'}</dd></div>
      <div><dt class="text-dim">Adverts</dt><dd class="text-ink">{selectedNode.advertCount ?? '—'}</dd></div>
      <div class="col-span-2">
        <dt class="text-dim">Networks</dt>
        <dd class="mt-1 flex flex-wrap gap-1">
          {#each selectedNode.networks ?? [] as net}
            <span class="rounded-md border border-edge bg-bg px-1.5 py-0.5 text-[0.72rem] text-dim">{net}</span>
          {/each}
        </dd>
      </div>
      <div class="col-span-2">
        <dt class="text-dim">Public key</dt>
        <dd class="mt-0.5 break-all font-mono text-[0.72rem] text-dim">{selectedNode.pubkey}</dd>
      </div>
    </dl>
  </aside>
{/if}
