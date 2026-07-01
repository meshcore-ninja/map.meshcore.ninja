<script>
  // A single country flag rendered as inline SVG (rounded, hairline ring,
  // cover-fit). Renders nothing for an unknown code.
  import { countryFlagSvg } from '$lib/flags.js';
  let { code, class: cls = 'h-3 w-4' } = $props();
  const svg = $derived(countryFlagSvg(code));
</script>

{#if svg}
  <span
    class="inline-flex shrink-0 overflow-hidden rounded-[2px] ring-1 ring-edge/70 [&>svg]:h-full [&>svg]:w-full [&>svg]:object-cover {cls}"
    title={code}
    aria-hidden="true"
  >
    <!-- eslint-disable-next-line svelte/no-at-html-tags -->
    {@html svg}
  </span>
{/if}
