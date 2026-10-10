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

// Travel times. OSRM's public demo only runs the car profile — it returns the
// same numbers whatever profile you ask for — so we take the street distance
// from it and derive walking and cycling times ourselves, and use its duration
// only for driving. If it is unreachable we fall back to straight-line distance
// padded for the street grid, and say so via `estimated`.
const OSRM_BASE = 'https://router.project-osrm.org';
const OSRM_TIMEOUT_MS = 8000;
const METERS_PER_MILE = 1609.34;
const STREET_DETOUR = 1.3;
const WALKING_MPH = 3;
const CYCLING_MPH = 10;
const CITY_DRIVING_MPH = 12;
const TRAVEL_TTL = 60 * 60_000;   // road geometry barely changes; durations are free-flow
const TRAVEL_CACHE_MAX = 100;

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

// --- Travel times --------------------------------------------
const travelCache = new Map();

function cacheTravel(key, value) {
  if (travelCache.size >= TRAVEL_CACHE_MAX) travelCache.delete(travelCache.keys().next().value);
  travelCache.set(key, { at: Date.now(), value });
  return value;
}

async function osrmFetch(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(OSRM_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`OSRM ${res.status}: ${res.statusText}`);
  const body = await res.json();
  if (body.code !== 'Ok') throw new Error(`OSRM ${body.code}`);
  return body;
}

// One request covers every nearby station, so this costs a single call per
// location — not one per station, and not one per 15s refresh.
async function roadDistances(origin, stations) {
  const key = `table:${origin.lat.toFixed(5)},${origin.lon.toFixed(5)}|${stations.map(s => s.id).join(',')}`;
  const cached = travelCache.get(key);
  if (cached && Date.now() - cached.at < TRAVEL_TTL) return cached.value;

  const points = [origin, ...stations].map(p => `${p.lon},${p.lat}`).join(';');
  const body = await osrmFetch(
    `${OSRM_BASE}/table/v1/driving/${points}?sources=0&annotations=duration,distance`);

  const durations = body.durations?.[0] ?? [];
  const distances = body.distances?.[0] ?? [];
  return cacheTravel(key, stations.map((_, i) => ({
    meters: distances[i + 1],
    seconds: durations[i + 1],
  })));
}

function travelTimes(straightLineMiles, road) {
  const routed = Number.isFinite(road?.meters) && Number.isFinite(road?.seconds);
  const miles = routed ? road.meters / METERS_PER_MILE : straightLineMiles * STREET_DETOUR;
  const at = mph => Math.max(1, Math.round((miles / mph) * 60));

  return {
    streetMiles: Number(miles.toFixed(3)),
    estimated: !routed,
    walk: at(WALKING_MPH),
    bike: at(CYCLING_MPH),
    drive: routed ? Math.max(1, Math.round(road.seconds / 60)) : at(CITY_DRIVING_MPH),
  };
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

  // Routing is a nicety — if it is down, travelTimes falls back to estimates.
  let roads = null;
  let routingError = null;
  try {
    roads = await roadDistances(origin, found.map(s => s.station));
  } catch (err) {
    routingError = err.message;
  }

  res.json({
    origin,
    radiusMiles: radius,
    expandedSearch: expanded,
    updatedAt: Date.now(),
    feedErrors: errors,
    routingError,
    stations: found.map(({ station, distance }, index) => ({
      id: station.id,
      name: station.name,
      borough: station.borough,
      routes: station.routes,
      lat: station.lat,
      lon: station.lon,
      distanceMiles: Number(distance.toFixed(3)),
      travel: travelTimes(distance, roads?.[index]),
      directions: [
        { code: 'N', label: station.north, trains: arrivals.get(station.id).N },
        { code: 'S', label: station.south, trains: arrivals.get(station.id).S },
      ],
    })),
  });
}

app.use(express.json({ limit: '8kb' }));

app.use((_, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

// Liveness for the container healthcheck. Deliberately touches nothing
// external, so a flaky MTA or OSRM never restarts the app.
app.get('/healthz', (_req, res) => {
  res.json({
    status: 'ok',
    stations: STATIONS.length,
    uptimeSeconds: Math.round(process.uptime()),
  });
});

app.get('/api/nearby', nearby);
app.get('/api/trains', nearby); // legacy path, same payload

// Arrivals for a fixed set of stations, for pages that watch one place rather
// than following the chosen location. No routing: these pages don't need it.
const MAX_DEPARTURE_STATIONS = 6;

app.get('/api/departures', async (req, res) => {
  const ids = [...new Set(String(req.query.ids ?? '').split(',').map(id => id.trim()))];
  const stations = ids
    .map(id => STATIONS.find(s => s.id === id))
    .filter(Boolean)
    .slice(0, MAX_DEPARTURE_STATIONS);
  if (!stations.length) return res.status(400).json({ error: 'No known station ids in ids' });

  const { feeds, errors } = await loadFeeds([...new Set(stations.flatMap(s => s.feeds))]);
  if (!feeds.length) {
    return res.status(503).json({ error: 'MTA feeds unavailable', feedErrors: errors });
  }

  const now = Math.floor(Date.now() / 1000);
  const arrivals = collectArrivals(feeds, stations.map(s => s.id), now);

  res.json({
    updatedAt: Date.now(),
    feedErrors: errors,
    stations: stations.map(station => ({
      id: station.id,
      name: station.name,
      routes: station.routes,
      lat: station.lat,
      lon: station.lon,
      directions: [
        { code: 'N', label: station.north, trains: arrivals.get(station.id).N },
        { code: 'S', label: station.south, trains: arrivals.get(station.id).S },
      ],
    })),
  });
});

// --- Shared focus sessions ------------------------------------
// The one piece of cross-visitor state in the app: who is currently racing for
// a train. Held in memory only - sessions last minutes, and losing them on a
// restart is not worth a database.
const SESSION_TTL_MS = 90_000;      // drop a session we stop hearing from
const SESSION_GRACE_MS = 60_000;    // keep it briefly after the train is due
const MAX_SESSIONS = 200;
const MAX_NAME = 32;

const sessions = new Map();         // deviceId -> session
const sessionClients = new Set();   // open SSE responses

const isDeviceId = v => typeof v === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(v);

function cleanText(value, fallback, limit) {
  if (typeof value !== 'string') return fallback;
  // Collapse whitespace and drop control characters; clients escape on render.
  const text = value.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, limit) : fallback;
}

function clampNumber(value, lo, hi) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null;
}

// Expire sessions whose train has gone, or whose device stopped checking in.
function pruneSessions() {
  const now = Date.now();
  let changed = false;
  for (const [id, session] of sessions) {
    const stale = now - session.updatedAt > SESSION_TTL_MS;
    const departed = now > session.arrivalTime * 1000 + SESSION_GRACE_MS;
    if (stale || departed) {
      sessions.delete(id);
      changed = true;
    }
  }
  return changed;
}

const sessionList = () => [...sessions.values()].sort((a, b) => a.leaveAt - b.leaveAt);

const sessionPayload = () => JSON.stringify({ sessions: sessionList(), now: Date.now() });

function broadcastSessions() {
  if (!sessionClients.size) return;
  const frame = `event: sessions\ndata: ${sessionPayload()}\n\n`;
  for (const client of sessionClients) client.write(frame);
}

app.get('/api/sessions', (_req, res) => {
  pruneSessions();
  res.type('application/json').send(sessionPayload());
});

// Live feed for the dashboard. EventSource reconnects on its own, so there is
// no polling fallback to keep in step here.
app.get('/api/sessions/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');

  pruneSessions();
  res.write(`event: sessions\ndata: ${sessionPayload()}\n\n`);

  sessionClients.add(res);
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(keepAlive);
    sessionClients.delete(res);
  });
});

// Start or refresh a session. The board re-posts on every refresh, which doubles
// as the heartbeat and carries any revision to the train's arrival time.
app.post('/api/sessions', (req, res) => {
  const body = req.body ?? {};
  if (!isDeviceId(body.deviceId)) return res.status(400).json({ error: 'Bad deviceId' });

  const station = STATIONS.find(s => s.id === body.stationId);
  if (!station) return res.status(400).json({ error: 'Unknown stationId' });

  const arrivalTime = clampNumber(body.arrivalTime, 1, 2 ** 40);
  if (!arrivalTime) return res.status(400).json({ error: 'Bad arrivalTime' });

  const existing = sessions.get(body.deviceId);
  if (!existing && sessions.size >= MAX_SESSIONS) {
    return res.status(503).json({ error: 'Too many active sessions' });
  }

  const southbound = body.dirCode === 'S';
  const travelMinutes = clampNumber(body.travelMinutes, 0, 600) ?? 0;
  const bufferMinutes = clampNumber(body.bufferMinutes, 0, 60) ?? 0;

  const session = {
    deviceId: body.deviceId,
    name: cleanText(body.name, 'Someone', MAX_NAME),
    // Display fields come from our own station index, not from the client.
    stationId: station.id,
    stationName: station.name,
    routes: station.routes,
    dirCode: southbound ? 'S' : 'N',
    dirLabel: southbound ? station.south : station.north,
    route: cleanText(body.route, '?', 4),
    express: Boolean(body.express),
    destination: cleanText(body.destination, null, 60),
    arrivalTime,
    mode: ['walk', 'bike', 'drive'].includes(body.mode) ? body.mode : 'walk',
    travelMinutes,
    bufferMinutes,
    leaveAt: arrivalTime * 1000 - (travelMinutes + bufferMinutes) * 60_000,
    startedAt: existing?.startedAt ?? Date.now(),
    updatedAt: Date.now(),
  };

  sessions.set(session.deviceId, session);
  pruneSessions();
  broadcastSessions();
  res.json(session);
});

app.delete('/api/sessions/:deviceId', (req, res) => {
  if (!isDeviceId(req.params.deviceId)) return res.status(400).json({ error: 'Bad deviceId' });
  const removed = sessions.delete(req.params.deviceId);
  pruneSessions();
  if (removed) broadcastSessions();
  res.json({ removed });
});

// Sessions also age out with no traffic at all, so the dashboard empties itself
// once everyone has caught their train.
setInterval(() => {
  if (pruneSessions()) broadcastSessions();
}, 15_000);

// The street path from the origin to one station, for drawing on the map.
// The geometry is a car route (see the OSRM note above), so a walking line may
// differ where one-way streets are involved.
app.get('/api/route', async (req, res) => {
  const from = readOrigin(req.query);
  const toLat = Number(req.query.toLat);
  const toLon = Number(req.query.toLon);
  if (!Number.isFinite(toLat) || !Number.isFinite(toLon) ||
      Math.abs(toLat) > 90 || Math.abs(toLon) > 180) {
    return res.status(400).json({ error: 'Missing or invalid toLat/toLon' });
  }

  const key = `route:${from.lat.toFixed(5)},${from.lon.toFixed(5)}|${toLat.toFixed(5)},${toLon.toFixed(5)}`;
  const cached = travelCache.get(key);
  if (cached && Date.now() - cached.at < TRAVEL_TTL) return res.json(cached.value);

  try {
    const body = await osrmFetch(
      `${OSRM_BASE}/route/v1/driving/${from.lon},${from.lat};${toLon},${toLat}` +
      `?overview=full&geometries=geojson`);

    const route = body.routes[0];
    if (!route) throw new Error('No route found');

    res.json(cacheTravel(key, {
      travel: travelTimes(0, { meters: route.distance, seconds: route.duration }),
      geometry: route.geometry,
    }));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// --- Weather --------------------------------------------------
// Open-Meteo needs no API key. Conditions come back as WMO codes.
const WEATHER_URL = 'https://api.open-meteo.com/v1/forecast';
const WEATHER_TTL = 10 * 60_000;
// How far ahead the forecast strip looks, past the current hour.
const FORECAST_HOURS = 12;
const weatherCache = new Map();

const WMO = {
  0: ['Clear', '☀️', '🌙'], 1: ['Mainly clear', '🌤️', '🌙'], 2: ['Partly cloudy', '⛅', '☁️'],
  3: ['Overcast', '☁️', '☁️'], 45: ['Fog', '🌫️', '🌫️'], 48: ['Freezing fog', '🌫️', '🌫️'],
  51: ['Light drizzle', '🌦️', '🌦️'], 53: ['Drizzle', '🌦️', '🌦️'], 55: ['Heavy drizzle', '🌧️', '🌧️'],
  56: ['Freezing drizzle', '🌧️', '🌧️'], 57: ['Freezing drizzle', '🌧️', '🌧️'],
  61: ['Light rain', '🌦️', '🌦️'], 63: ['Rain', '🌧️', '🌧️'], 65: ['Heavy rain', '🌧️', '🌧️'],
  66: ['Freezing rain', '🌧️', '🌧️'], 67: ['Freezing rain', '🌧️', '🌧️'],
  71: ['Light snow', '🌨️', '🌨️'], 73: ['Snow', '🌨️', '🌨️'], 75: ['Heavy snow', '❄️', '❄️'],
  77: ['Snow grains', '🌨️', '🌨️'],
  80: ['Light showers', '🌦️', '🌦️'], 81: ['Showers', '🌧️', '🌧️'], 82: ['Heavy showers', '⛈️', '⛈️'],
  85: ['Snow showers', '🌨️', '🌨️'], 86: ['Snow showers', '🌨️', '🌨️'],
  95: ['Thunderstorm', '⛈️', '⛈️'], 96: ['Thunderstorm', '⛈️', '⛈️'], 99: ['Thunderstorm', '⛈️', '⛈️'],
};

// Open-Meteo returns local wall-clock strings for the requested location, so
// format them by hand rather than through Date, which would reinterpret them
// in the server's timezone.
function hourLabel(iso) {
  const hour = Number(iso.slice(11, 13));
  return `${hour % 12 === 0 ? 12 : hour % 12} ${hour < 12 ? 'AM' : 'PM'}`;
}

function timeLabel(iso) {
  if (!iso) return null;
  const hour = Number(iso.slice(11, 13));
  return `${hour % 12 === 0 ? 12 : hour % 12}:${iso.slice(14, 16)} ${hour < 12 ? 'AM' : 'PM'}`;
}

app.get('/api/weather', async (req, res) => {
  const origin = readOrigin(req.query);
  const key = `${origin.lat.toFixed(2)},${origin.lon.toFixed(2)}`;
  const cached = weatherCache.get(key);
  if (cached && Date.now() - cached.at < WEATHER_TTL) return res.json(cached.value);

  const params = new URLSearchParams({
    latitude: origin.lat,
    longitude: origin.lon,
    current: 'temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,is_day',
    hourly: 'temperature_2m,weather_code,precipitation_probability,is_day',
    daily: 'temperature_2m_max,temperature_2m_min,sunrise,sunset',
    // Two days so the next 12 hours stay available across midnight.
    forecast_days: '2',
    temperature_unit: 'fahrenheit',
    wind_speed_unit: 'mph',
    precipitation_unit: 'inch',
    timezone: 'auto',
  });

  try {
    const response = await fetch(`${WEATHER_URL}?${params}`, {
      signal: AbortSignal.timeout(OSRM_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Weather ${response.status}: ${response.statusText}`);

    const body = await response.json();
    const now = body.current;
    const isDay = now.is_day === 1;
    const conditions = (code, day) => {
      const [description, dayIcon, nightIcon] = WMO[code] ?? ['Unknown', '🌡️', '🌡️'];
      return { description, icon: day ? dayIcon : nightIcon };
    };
    const current = conditions(now.weather_code, isDay);

    const allHours = (body.hourly?.time ?? []).map((time, i) => ({
      time,
      label: hourLabel(time),
      temperature: Math.round(body.hourly.temperature_2m[i]),
      precipChance: body.hourly.precipitation_probability?.[i] ?? 0,
      ...conditions(body.hourly.weather_code[i], body.hourly.is_day?.[i] === 1),
    }));

    // The strip leads with the current conditions, so hand back only what comes
    // after the current hour. Hours are the location's own wall clock, matched
    // by string rather than Date so the server's timezone stays out of it.
    const nowIndex = allHours.findIndex(hour => hour.time.slice(0, 13) === now.time.slice(0, 13));
    const start = nowIndex >= 0
      ? nowIndex + 1
      : Math.max(allHours.findIndex(hour => hour.time > now.time), 0);
    const hourly = allHours.slice(start, start + FORECAST_HOURS);

    const daily = body.daily ?? {};
    const value = {
      temperature: Math.round(now.temperature_2m),
      feelsLike: Math.round(now.apparent_temperature),
      precipitation: now.precipitation,
      precipChance: nowIndex >= 0 ? allHours[nowIndex].precipChance : 0,
      windMph: Math.round(now.wind_speed_10m),
      description: current.description,
      icon: current.icon,
      isDay,
      observedAt: now.time,
      today: {
        high: Math.round(daily.temperature_2m_max?.[0] ?? now.temperature_2m),
        low: Math.round(daily.temperature_2m_min?.[0] ?? now.temperature_2m),
        sunrise: timeLabel(daily.sunrise?.[0]),
        sunset: timeLabel(daily.sunset?.[0]),
      },
      hourly,
    };
    weatherCache.set(key, { at: Date.now(), value });
    if (weatherCache.size > 50) weatherCache.delete(weatherCache.keys().next().value);
    res.json(value);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

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

// Leaflet is served from node_modules rather than a CDN, so the only external
// requests the page makes are for map tiles.
app.use('/vendor/leaflet', express.static(path.join(__dirname, 'node_modules/leaflet/dist')));

app.get('/dashboard', (_req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));
app.get('/lorimer', (_req, res) => res.sendFile(path.join(__dirname, 'lorimer.html')));

app.use(express.static(__dirname, { index: 'home.html' }));

app.listen(PORT, () => {
  console.log(`\nDashboard -> http://localhost:${PORT}`);
  console.log(`Nearby API -> http://localhost:${PORT}/api/nearby?lat=40.7118&lon=-73.943`);
  console.log(`Stop ID debug -> http://localhost:${PORT}/api/debug/stops?feed=l\n`);

  // Warm the feeds around the fallback location so the first load is instant.
  const { nearby: seed } = stationsNear(DEFAULT_LOCATION, DEFAULT_RADIUS_MI, DEFAULT_LIMIT);
  loadFeeds([...new Set(seed.flatMap(s => s.station.feeds))]);
});
