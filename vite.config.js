import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// VITE_API_BASE (the MeshCore Ninja API origin) is read natively from the
// environment / .env files via import.meta.env — see src/lib/api.js for the
// production default. Set it in .env.local for dev or in the deploy workflow.
export default defineConfig({
  plugins: [tailwindcss(), sveltekit()]
});
