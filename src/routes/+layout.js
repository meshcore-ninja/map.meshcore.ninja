// Single-page client app: prerender the shell at build time, but render the map
// and its data entirely in the browser (the API is queried per viewport, never
// at build time).
export const prerender = true;
export const ssr = false;
