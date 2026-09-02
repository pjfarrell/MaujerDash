import express from 'express';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import GtfsRT from 'gtfs-realtime-bindings';
const { transit_realtime } = GtfsRT;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// Every subway station with its coordinates, routes and realtime feeds.
// Regenerate from the MTA's published list with: node scripts/build-stations.mjs
const STATIONS = JSON.parse(readFileSync(path.join(__dirname, 'stations.json'), 'utf8'));
const STATION_NAMES = new Map(STATIONS.map(s => [s.id, s.name]));

// Where the dashboard looks when the browser won't share a location: Maujer St.
const DEFAULT_LOCATION = { lat: 40.7118, lon: -73.943 };

const FEED_BASE = 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs';
const feedUrl = key => (key === 'main' ? FEED_BASE : `${FEED_BASE}-${key}`);

const FEED_TTL = 15_000;          // how long a decoded feed stays fresh
const DEFAULT_RADIUS_MI = 0.5;
const MAX_RADIUS_MI = 5;
const DEFAULT_LIMIT = 6;
const MAX_LIMIT = 20;
const ARRIVALS_PER_DIRECTION = 6;
const WALKING_MPH = 3;

// --- Feed fetching -------------------------------------------
// One cache entry per feed. Concurrent callers share the in-flight request, and
// a failed refresh leaves the previous decode in place so we can serve it stale.
const feedCache = new Map();

async function getFeed(key) {
  const entry = feedCache.get(key);
  if (entry?.feed && Date.now() - entry.at < FEED_TTL) return entry.feed;
  if (entry?.inflight) return entry.inflight;

  const inflight = (async () => {
    const res = await fetch(feedUrl(key));
    if (!res.ok) throw new Error(`MTA ${key} feed ${res.status}: ${res.statusText}`);
    const feed = transit_realtime.FeedMessage.decode(new Uint8Array(await res.arrayBuffer()));
    feedCache.set(key, { at: Date.now(), feed });
    return feed;
  })();

  inflight.catch(() => {
    const current = feedCache.get(key);
    if (current?.inflight !== inflight) return;
    if (current.feed) feedCache.set(key, { at: current.at, feed: current.feed });
    else feedCache.delete(key);
  });

  feedCache.set(key, { ...entry, inflight });
  return inflight;
}

async function loadFeeds(keys) {
  const feeds = [];
  const errors = [];
  await Promise.all(keys.map(async key => {
    try {
      feeds.push(await getFeed(key));
    } catch (err) {
      const stale = feedCache.get(key)?.feed;
      if (stale) feeds.push(stale);
      errors.push({ feed: key, error: err.message, servedStale: Boolean(stale) });
    }
  }));
  return { feeds, errors };
}

// --- Geography -----------------------------------------------
const EARTH_RADIUS_MI = 3958.8;
const toRad = deg => (deg * Math.PI) / 180;

function distanceMiles(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_MI * Math.asin(Math.sqrt(h));
}

// Stations within `radius` of the origin, nearest first. If nothing is in range
// we still return the closest few, so the dashboard is never blank.
function stationsNear(origin, radius, limit) {
  const ranked = STATIONS
    .map(station => ({ station, distance: distanceMiles(origin, station) }))
    .sort((a, b) => a.distance - b.distance);

  const inRange = ranked.filter(s => s.distance <= radius).slice(0, limit);
  if (inRange.length) return { nearby: inRange, expanded: false };
  return { nearby: ranked.slice(0, Math.min(3, limit)), expanded: true };
}

// --- Arrivals ------------------------------------------------
// Realtime stop IDs are the station ID plus a direction suffix ("L10" -> "L10N").
const parentOf = stopId => stopId.slice(0, -1);

// Feeds use internal route IDs: the shuttles have their own codes, and express
// runs are the line number with an X (which the MTA signs as a diamond).
const SHUTTLE_ROUTES = { GS: 'S', FS: 'S', H: 'S', SI: 'SIR' };

function displayRoute(routeId) {
  if (SHUTTLE_ROUTES[routeId]) return { route: SHUTTLE_ROUTES[routeId], express: false };
  if (/^\dX$/.test(routeId)) return { route: routeId[0], express: true };
  return { route: routeId, express: false };
}

function destinationOf(tripUpdate) {
  const last = tripUpdate.stopTimeUpdate[tripUpdate.stopTimeUpdate.length - 1]?.stopId;
  return last ? STATION_NAMES.get(parentOf(last)) ?? null : null;
}

// Single pass over the feeds, collecting arrivals for the stations we care about.
function collectArrivals(feeds, stationIds, now) {
  const byStation = new Map(stationIds.map(id => [id, { N: [], S: [] }]));

  for (const feed of feeds) {
    for (const entity of feed.entity) {
      const tu = entity.tripUpdate;
      if (!tu?.stopTimeUpdate?.length) continue;

      const { route, express } = displayRoute(tu.trip.routeId);
      let destination;
      for (const stu of tu.stopTimeUpdate) {
        if (!stu.stopId) continue;
        const direction = stu.stopId.slice(-1);
        if (direction !== 'N' && direction !== 'S') continue;

        const bucket = byStation.get(parentOf(stu.stopId));
        if (!bucket) continue;

        const time = Number(stu.arrival?.time ?? stu.departure?.time ?? 0);
        if (!time || time < now - 30) continue; // skip just-departed trains

        destination ??= destinationOf(tu);
        bucket[direction].push({
          route,
          express,
          destination,
          arrivalTime: time,
          minutesAway: Math.max(0, Math.round((time - now) / 60)),
        });
      }
    }
  }

  for (const bucket of byStation.values()) {
    for (const direction of ['N', 'S']) {
      bucket[direction] = bucket[direction]
        .sort((a, b) => a.arrivalTime - b.arrivalTime)
        .slice(0, ARRIVALS_PER_DIRECTION);
    }
  }
  return byStation;
}

// --- Request handling ----------------------------------------
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function readOrigin(query) {
  const lat = Number(query.lat);
  const lon = Number(query.lon);
  const valid =
    Number.isFinite(lat) && Number.isFinite(lon) &&
    Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
  return valid
    ? { lat, lon, usedDefault: false }
    : { ...DEFAULT_LOCATION, usedDefault: true };
}

function readNumber(value, fallback, lo, hi) {
  const n = Number(value);
  return Number.isFinite(n) ? clamp(n, lo, hi) : fallback;
}

async function nearby(req, res) {
  const origin = readOrigin(req.query);
  const radius = readNumber(req.query.radius, DEFAULT_RADIUS_MI, 0.05, MAX_RADIUS_MI);
  const limit = readNumber(req.query.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);

  const { nearby: found, expanded } = stationsNear(origin, radius, limit);
  const feedKeys = [...new Set(found.flatMap(s => s.station.feeds))];
  const { feeds, errors } = await loadFeeds(feedKeys);

  if (!feeds.length) {
    return res.status(503).json({ error: 'MTA feeds unavailable', feedErrors: errors });
  }

  const now = Math.floor(Date.now() / 1000);
  const arrivals = collectArrivals(feeds, found.map(s => s.station.id), now);

  res.json({
    origin,
    radiusMiles: radius,
    expandedSearch: expanded,
    updatedAt: Date.now(),
    feedErrors: errors,
    stations: found.map(({ station, distance }) => ({
      id: station.id,
      name: station.name,
      borough: station.borough,
      routes: station.routes,
      lat: station.lat,
      lon: station.lon,
      distanceMiles: Number(distance.toFixed(3)),
      walkMinutes: Math.max(1, Math.round((distance / WALKING_MPH) * 60)),
      directions: [
        { code: 'N', label: station.north, trains: arrivals.get(station.id).N },
        { code: 'S', label: station.south, trains: arrivals.get(station.id).S },
      ],
    })),
  });
}

app.use((_, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

app.get('/api/nearby', nearby);
app.get('/api/trains', nearby); // legacy path, same payload

// --- Geocoding ------------------------------------------------
// Turns whatever someone types into candidate coordinates. Coordinates and
// station names are answered from memory; anything else goes to Nominatim,
// which is best-effort — a failure there still leaves the local matches.
const BOROUGHS = { Bk: 'Brooklyn', M: 'Manhattan', Q: 'Queens', Bx: 'Bronx', SI: 'Staten Island' };
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const NOMINATIM_VIEWBOX = '-74.30,40.90,-73.65,40.47'; // left,top,right,bottom
const NOMINATIM_MIN_INTERVAL = 1100; // their usage policy allows 1 request/sec
const GEOCODE_CACHE_MAX = 200;

const geocodeCache = new Map();
let lastNominatimAt = 0;

function coordinateMatch(query) {
  const m = query.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (!m) return [];
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return [];
  return [{ label: `${lat}, ${lon}`, lat, lon, source: 'coordinates' }];
}

function stationMatches(query) {
  const needle = query.toLowerCase();
  return STATIONS
    .filter(s => s.name.toLowerCase().includes(needle))
    .slice(0, 5)
    .map(s => ({
      label: `${s.name} (${s.routes.join(' ')}) · ${BOROUGHS[s.borough] ?? s.borough}`,
      lat: s.lat,
      lon: s.lon,
      source: 'station',
    }));
}

async function addressMatches(query) {
  const wait = NOMINATIM_MIN_INTERVAL - (Date.now() - lastNominatimAt);
  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
  lastNominatimAt = Date.now();

  const params = new URLSearchParams({
    q: query,
    format: 'jsonv2',
    limit: '5',
    viewbox: NOMINATIM_VIEWBOX,
    bounded: '1',
  });
  const res = await fetch(`${NOMINATIM_URL}?${params}`, {
    headers: { 'User-Agent': 'MaujerDash/1.0 (subway arrivals dashboard)' },
  });
  if (!res.ok) throw new Error(`Geocoder ${res.status}: ${res.statusText}`);

  return (await res.json()).map(hit => ({
    label: hit.display_name,
    lat: Number(hit.lat),
    lon: Number(hit.lon),
    source: 'address',
  }));
}

app.get('/api/geocode', async (req, res) => {
  const query = String(req.query.q ?? '').trim();
  if (!query) return res.status(400).json({ error: 'Missing q' });

  const cached = geocodeCache.get(query.toLowerCase());
  if (cached) return res.json(cached);

  const coordinates = coordinateMatch(query);
  const results = [...coordinates, ...stationMatches(query)];
  let geocoderError = null;

  // Coordinates are already an exact answer; don't spend a geocoder call on them.
  if (!coordinates.length && results.length < 5) {
    try {
      results.push(...await addressMatches(query));
    } catch (err) {
      geocoderError = err.message;
    }
  }

  const payload = { query, results: results.slice(0, 8), geocoderError };
  if (!geocoderError) {
    if (geocodeCache.size >= GEOCODE_CACHE_MAX) geocodeCache.delete(geocodeCache.keys().next().value);
    geocodeCache.set(query.toLowerCase(), payload);
  }
  res.json(payload);
});

// Debug: raw stop IDs seen in a feed, for checking the station index
app.get('/api/debug/stops', async (req, res) => {
  const key = String(req.query.feed || 'l');
  try {
    const feed = await getFeed(key);
    const ids = new Set();
    for (const entity of feed.entity) {
      for (const stu of entity.tripUpdate?.stopTimeUpdate ?? []) {
        if (stu.stopId) ids.add(stu.stopId);
      }
    }
    res.json({ feed: key, url: feedUrl(key), stops: [...ids].sort() });
  } catch (err) {
    res.status(502).json({ feed: key, error: err.message });
  }
});

app.use(express.static(__dirname, { index: 'home.html' }));

app.listen(PORT, () => {
  console.log(`\nDashboard -> http://localhost:${PORT}`);
  console.log(`Nearby API -> http://localhost:${PORT}/api/nearby?lat=40.7118&lon=-73.943`);
  console.log(`Stop ID debug -> http://localhost:${PORT}/api/debug/stops?feed=l\n`);

  // Warm the feeds around the fallback location so the first load is instant.
  const { nearby: seed } = stationsNear(DEFAULT_LOCATION, DEFAULT_RADIUS_MI, DEFAULT_LIMIT);
  loadFeeds([...new Set(seed.flatMap(s => s.station.feeds))]);
});
