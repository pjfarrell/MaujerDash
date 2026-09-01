import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import GtfsRT from 'gtfs-realtime-bindings';
const { transit_realtime } = GtfsRT;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// Stop IDs from MTA GTFS static data.
// Verify/browse stops at: https://api.mta.info/#/subwayRealTimeFeeds
// or download stops.txt from the static GTFS package.
const L_STOP = 'L10';  // Lorimer St (L train)
const G_STOP = 'G29';  // Metropolitan Av (G train)

const DIRECTION_LABELS = {
  L: { N: '8 Av / Manhattan', S: 'Canarsie' },
  G: { N: 'Court Sq–23 St', S: 'Church Av' },
};

const FEED_URLS = {
  L: 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-l',
  G: 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-g',
};

async function fetchFeed(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`MTA API ${res.status}: ${res.statusText}`);
  const buf = await res.arrayBuffer();
  return transit_realtime.FeedMessage.decode(new Uint8Array(buf));
}

function extractArrivals(feed, stopId) {
  const now = Math.floor(Date.now() / 1000);
  const arrivals = [];

  for (const entity of feed.entity) {
    const tu = entity.tripUpdate;
    if (!tu) continue;
    for (const stu of tu.stopTimeUpdate) {
      if (!stu.stopId?.startsWith(stopId)) continue;
      const t = Number(stu.arrival?.time ?? stu.departure?.time ?? 0);
      if (t <= now) continue;
      arrivals.push({
        route: tu.trip.routeId,
        direction: stu.stopId.slice(-1), // 'N' or 'S'
        arrivalTime: t,
        minutesAway: Math.round((t - now) / 60),
      });
    }
  }

  return arrivals.sort((a, b) => a.arrivalTime - b.arrivalTime);
}

// Debug: list all unique stop IDs seen in a feed (useful for finding correct stop IDs)
function listStopIds(feed) {
  const ids = new Set();
  for (const entity of feed.entity) {
    for (const stu of entity.tripUpdate?.stopTimeUpdate ?? []) {
      if (stu.stopId) ids.add(stu.stopId);
    }
  }
  return [...ids].sort();
}

let cache = null;
let cacheTime = 0;
let refreshing = false;

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const [lFeed, gFeed] = await Promise.all([
      fetchFeed(FEED_URLS.L),
      fetchFeed(FEED_URLS.G),
    ]);
    const L = extractArrivals(lFeed, L_STOP);
    const G = extractArrivals(gFeed, G_STOP);
    cache = {
      L, G,
      directionLabels: DIRECTION_LABELS,
      updatedAt: Date.now(),
      _debug: { lStops: listStopIds(lFeed), gStops: listStopIds(gFeed) },
    };
    cacheTime = Date.now();
    console.log(`[${new Date().toLocaleTimeString()}] L: ${L.length} trains · G: ${G.length} trains`);
  } catch (err) {
    console.error('Refresh failed:', err.message);
  } finally {
    refreshing = false;
  }
}

app.use((_, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

app.get('/api/trains', async (_req, res) => {
  if (!cache || Date.now() - cacheTime > 15_000) await refresh();
  if (!cache) return res.status(503).json({ error: 'Feed unavailable — check server logs' });
  const { _debug, ...data } = cache;
  res.json(data);
});

// Expose raw stop IDs to help verify/correct STOP constants above
app.get('/api/debug/stops', async (_req, res) => {
  if (!cache) await refresh();
  if (!cache) return res.status(503).json({ error: 'No data yet' });
  res.json({
    configured: { L: L_STOP, G: G_STOP },
    lStops: cache._debug.lStops,
    gStops: cache._debug.gStops,
  });
});

app.use(express.static(__dirname, { index: 'home.html' }));

app.listen(PORT, () => {
  console.log(`\nDashboard → http://localhost:${PORT}`);
  console.log(`Stop ID debug → http://localhost:${PORT}/api/debug/stops\n`);
  refresh();
});

setInterval(refresh, 15_000);
