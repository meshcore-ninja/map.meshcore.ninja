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
    onselectNetwork = () => {}
  } = $props();

  let query = $state('');

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
  // With no query, show the most-recently-heard nodes (matches the directory's
  // default ordering). Imported directory nodes have no lastAdvertAt, so they
  // naturally sort last.
  let recent = $derived(
    [...nodes].sort((a, b) => (b.lastAdvertAt ?? 0) - (a.lastAdvertAt ?? 0)).slice(0, RESULT_LIMIT)
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

  // Fresh query every time the palette opens.
  $effect(() => {
    if (open) query = '';
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

      <Command.Root shouldFilter={false} class="flex min-h-0 flex-col">
        <!-- Search field -->
        <div class="flex items-center gap-2.5 border-b border-edge px-4 py-3">
          <svg class="h-5 w-5 shrink-0 text-dim" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" stroke-linecap="round" />
          </svg>
          <Command.Input
            bind:value={query}
            autofocus
            placeholder="Search nodes or networks…"
            class="w-full bg-transparent text-[0.95rem] text-ink outline-none placeholder:text-dim"
          />
          <kbd class="hidden shrink-0 rounded border border-edge bg-bg px-1.5 py-0.5 text-[0.7rem] font-medium text-dim sm:block">
            Esc
          </kbd>
        </div>

        <Command.List
          onscroll={onListScroll}
          class="cmd-list min-h-0 flex-1 overflow-y-auto overscroll-contain py-1 {scrolling ? 'is-scrolling' : ''}"
        >
          {#if !networkResults.length && !results.length}
            <div class="px-4 py-10 text-center text-[0.85rem] text-dim">
              {query.trim() ? `No matches for “${query}”.` : 'No nodes yet.'}
            </div>
          {/if}

          <!-- Matching networks -->
          {#if networkResults.length}
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
          {#if networkResults.length && results.length}
            <div class="px-4 pb-1 pt-2 text-[0.68rem] font-semibold uppercase tracking-wide text-dim">Nodes</div>
          {/if}

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
        </Command.List>

        <!-- Footer hint -->
        <div class="flex items-center justify-between border-t border-edge px-4 py-2 text-[0.7rem] text-dim">
          <span class="flex items-center gap-3">
            <span class="flex items-center gap-1"><kbd class="rounded border border-edge bg-bg px-1 py-0.5">↑↓</kbd> navigate</span>
            <span class="flex items-center gap-1"><kbd class="rounded border border-edge bg-bg px-1 py-0.5">↵</kbd> open</span>
          </span>
          <span>{results.length}{results.length === RESULT_LIMIT ? '+' : ''} nodes</span>
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
