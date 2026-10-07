// Shared by the board (/) and the sessions dashboard (/dashboard).

// Official line colors, so a station's badges read the way the signage does.
const ROUTE_COLORS = {
  1: '#ee352e', 2: '#ee352e', 3: '#ee352e',
  4: '#00933c', 5: '#00933c', 6: '#00933c',
  7: '#b933ad',
  A: '#0039a6', C: '#0039a6', E: '#0039a6',
  B: '#ff6319', D: '#ff6319', F: '#ff6319', M: '#ff6319',
  G: '#6cbe45',
  J: '#996633', Z: '#996633',
  N: '#fccc0a', Q: '#fccc0a', R: '#fccc0a', W: '#fccc0a',
  L: '#a7a9ac',
  S: '#808183', SIR: '#0078c6', SI: '#0078c6',
};
const DARK_TEXT = new Set(['N', 'Q', 'R', 'W', 'L', 'S']);

function esc(text) {
  return String(text).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function badge(route, express) {
  const color = ROUTE_COLORS[route] || '#808183';
  const text = DARK_TEXT.has(route) ? '#000' : '#fff';
  return `<span class="badge${express ? ' express' : ''}" style="background:${color};color:${text}">` +
         `<span>${esc(route)}</span></span>`;
}

function clock(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

// --- Chosen place --------------------------------------------
// The board owns this; other pages read it so their header agrees.
const PLACE_KEY = 'maujerdash:place';

// The app's namesake, shown until someone picks a location of their own.
const DEFAULT_PLACE = {
  lat: 40.7118, lon: -73.943, label: 'Maujer St, Brooklyn', source: 'default',
};

function loadPlace() {
  try {
    const saved = JSON.parse(localStorage.getItem(PLACE_KEY));
    return Number.isFinite(saved?.lat) && Number.isFinite(saved?.lon) ? saved : null;
  } catch {
    return null;
  }
}

// --- Device identity -----------------------------------------
// A session is owned by a device, not an account: the id is generated in the
// browser, kept in localStorage, and only ever leaves as an opaque string.
const DEVICE_KEY = 'maujerdash:device';
const NAME_KEY = 'maujerdash:name';
const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

const ADJECTIVES = ['Quiet', 'Rapid', 'Patient', 'Lucky', 'Restless', 'Cheerful',
  'Nimble', 'Steady', 'Curious', 'Brave', 'Sleepy', 'Clever'];
const ANIMALS = ['Otter', 'Heron', 'Fox', 'Pigeon', 'Raccoon', 'Sparrow',
  'Badger', 'Falcon', 'Rabbit', 'Beaver', 'Magpie', 'Marten'];

function hashString(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  }
  return hash;
}

// Derived from the id, so the same device keeps the same name without storing one.
function autoName(id) {
  const hash = hashString(id);
  return `${ADJECTIVES[hash % ADJECTIVES.length]} ${ANIMALS[(hash >>> 5) % ANIMALS.length]}`;
}

let cachedDeviceId = null;

function deviceId() {
  if (cachedDeviceId) return cachedDeviceId;

  let id = null;
  try {
    id = localStorage.getItem(DEVICE_KEY);
  } catch {
    id = null;   // private mode, blocked storage
  }

  if (!id || !ID_PATTERN.test(id)) {
    const raw = crypto.randomUUID ? crypto.randomUUID()
      : `d${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    id = raw.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
    try { localStorage.setItem(DEVICE_KEY, id); } catch { /* in-memory for this page */ }
  }

  cachedDeviceId = id;
  return id;
}

function displayName() {
  try {
    const saved = localStorage.getItem(NAME_KEY);
    if (saved && saved.trim()) return saved.trim().slice(0, 32);
  } catch { /* fall through to the derived name */ }
  return autoName(deviceId());
}

// An empty name clears the override and falls back to the derived one.
function setDisplayName(name) {
  const trimmed = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 32);
  try {
    if (trimmed) localStorage.setItem(NAME_KEY, trimmed);
    else localStorage.removeItem(NAME_KEY);
  } catch { /* nothing to persist to */ }
  return displayName();
}
