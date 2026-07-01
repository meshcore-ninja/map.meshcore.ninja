// Basemap (tile layer) definitions shared by the map and the layer chooser.
//
// On high-DPI screens we request double-resolution ("@2x") tiles so the basemap
// stays crisp (MapView packs the 2x image into a 256 CSS-px slot via
// tileSize:256). CARTO basemaps follow the app theme; Mapy.com offers a "basic"
// and an "outdoor" style.

export const MAPY_KEY = 'vHsJFt01jVTQpcBX1tIWkmiviQ9R8EzZ7srEiWed7Fc';

const isRetina = () => typeof window !== 'undefined' && window.devicePixelRatio > 1;

// Mapy basemap ids → mapset name in the tile URL.
const MAPY_MAPSETS = { mapy: 'basic' };
const STADIA_STYLES = {
  'stadia-outdoors': { style: 'outdoors', ext: 'png' },
  'stadia-smooth-dark': { style: 'alidade_smooth_dark', ext: 'png' },
  'stadia-smooth-light': { style: 'alidade_smooth', ext: 'png' },
  'stadia-satellite': { style: 'alidade_satellite', ext: 'jpg' }
};

/** Tile URL templates for a basemap id, given the current theme. */
export function basemapTiles(id, theme) {
  const mapset = MAPY_MAPSETS[id];
  if (mapset) {
    const size = isRetina() ? '256@2x' : '256';
    return [`https://api.mapy.com/v1/maptiles/${mapset}/${size}/{z}/{x}/{y}.png?lang=cs&apikey=${MAPY_KEY}`];
  }
  if (id === 'osm') {
    return ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'];
  }
  if (id === 'carto-voyager') {
    const r = isRetina() ? '@2x' : '';
    return ['a', 'b', 'c', 'd'].map(
      (s) => `https://${s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}${r}.png`
    );
  }
  const stadia = STADIA_STYLES[id];
  if (stadia) {
    const r = isRetina() ? '@2x' : '';
    return [`https://tiles.stadiamaps.com/tiles/${stadia.style}/{z}/{x}/{y}${r}.${stadia.ext}`];
  }
  // auto → CARTO, following the theme.
  const variant = theme === 'light' ? 'light_all' : 'dark_all';
  const r = isRetina() ? '@2x' : '';
  return ['a', 'b', 'c', 'd'].map(
    (s) => `https://${s}.basemaps.cartocdn.com/${variant}/{z}/{x}/{y}${r}.png`
  );
}

/** Attribution string for a basemap id. */
export function basemapAttribution(id) {
  if (MAPY_MAPSETS[id]) return '© Seznam.cz a.s., © OpenStreetMap';
  if (id === 'osm') return '© OpenStreetMap contributors';
  if (id === 'stadia-satellite') {
    return '© CNES, Airbus DS, PlanetObserver, Copernicus · © Stadia Maps · © OpenMapTiles · © OpenStreetMap';
  }
  if (STADIA_STYLES[id]) return '© Stadia Maps · © OpenMapTiles · © OpenStreetMap contributors';
  return '© OpenStreetMap contributors © CARTO';
}

// Representative preview tiles (central Europe at z6) for the chooser thumbnails.
const cartoThumb = (theme) =>
  `https://a.basemaps.cartocdn.com/${theme === 'light' ? 'light_all' : 'dark_all'}/6/34/21@2x.png`;
const mapyThumb = (mapset) =>
  `https://api.mapy.com/v1/maptiles/${mapset}/256@2x/6/34/21.png?apikey=${MAPY_KEY}`;
const osmThumb = 'https://tile.openstreetmap.org/6/34/21.png';
const voyagerThumb = 'https://a.basemaps.cartocdn.com/rastertiles/voyager/6/34/21@2x.png';
const stadiaThumb = (style, ext = 'png') =>
  `https://tiles.stadiamaps.com/tiles/${style}/6/34/21@2x.${ext}`;

// Options shown in the layer chooser. Every option carries a `theme` (light/dark)
// so picking a layer also switches the app's light/dark chrome to match the tile
// style — the UI never clashes with the map. CARTO entries use basemap 'auto'
// (theme-following tiles); the others set their basemap directly.
export const LAYER_OPTIONS = [
  { key: 'carto-voyager', label: 'Carto Voyager', basemap: 'carto-voyager', theme: 'light', thumb: voyagerThumb },
  { key: 'carto-dark', label: 'Carto Dark', basemap: 'auto', theme: 'dark', thumb: cartoThumb('dark') },
  { key: 'carto-light', label: 'Carto Light', basemap: 'auto', theme: 'light', thumb: cartoThumb('light') },
  { key: 'osm', label: 'OpenStreetMap', basemap: 'osm', theme: 'light', thumb: osmThumb },
  { key: 'mapy', label: 'Mapy.com', basemap: 'mapy', theme: 'light', thumb: mapyThumb('basic') },
];

export const DEFAULT_BASEMAP = 'auto';
export const isBasemapId = (id) =>
  id === 'auto' ||
  id === 'osm' ||
  id === 'carto-voyager' ||
  id in MAPY_MAPSETS ||
  id in STADIA_STYLES;

/** The theme (light/dark) that matches a basemap id, for keeping chrome in sync. */
export function basemapTheme(id, fallback = 'dark') {
  const o = LAYER_OPTIONS.find((x) => x.basemap === id && x.basemap !== 'auto');
  return o ? o.theme : fallback;
}
