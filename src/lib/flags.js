// Country flags via `country-flag-icons` (same source as meshcore.ninja), as
// inline SVG strings keyed by ISO 3166-1 alpha-2 code.
import * as countryFlags from 'country-flag-icons/string/3x2';

/** Inline 3:2 flag SVG for a country code, or null. Case-insensitive. */
export function countryFlagSvg(code) {
  if (!code) return null;
  return countryFlags[String(code).toUpperCase()] ?? null;
}
