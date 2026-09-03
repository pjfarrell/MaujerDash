// Regenerates stations.json from the MTA's published subway station list.
//
//   node scripts/build-stations.mjs
//
// Source: https://data.ny.gov/Transportation/MTA-Subway-Stations/39hk-dx4f
// The dataset is one row per station (parent stop), which is exactly the
// granularity the realtime feeds use once you strip the N/S suffix.

import { writeFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import path from 'path';

const SOURCE = 'https://data.ny.gov/api/views/39hk-dx4f/rows.csv?accessType=DOWNLOAD';
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'stations.json');

// Which GTFS-realtime feed carries each route. Feed keys map to
// https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs[-<key>]
const ROUTE_FEEDS = {
  1: 'main', 2: 'main', 3: 'main', 4: 'main', 5: 'main', 6: 'main', 7: 'main',
  A: 'ace', C: 'ace', E: 'ace',
  B: 'bdfm', D: 'bdfm', F: 'bdfm', M: 'bdfm',
  G: 'g',
  J: 'jz', Z: 'jz',
  N: 'nqrw', Q: 'nqrw', R: 'nqrw', W: 'nqrw',
  L: 'l',
  SIR: 'si',
};

// "S" is three different shuttles. The 42 St shuttle rides in the numbered-line
// feed; Franklin Av and Rockaway Park ride in the ACE feed.
function feedFor(route, line) {
  if (route === 'S') return line.includes('Lexington') ? 'main' : 'ace';
  return ROUTE_FEEDS[route];
}

function parseCsv(text) {
  const [header, ...rows] = text.trim().split(/\r?\n/);
  const cols = header.split(',');
  return rows.map(row => Object.fromEntries(row.split(',').map((v, i) => [cols[i], v])));
}

const res = await fetch(SOURCE);
if (!res.ok) throw new Error(`Station list download failed: ${res.status} ${res.statusText}`);

const stations = parseCsv(await res.text())
  .map(r => {
    const line = r['Line'];
    const routes = r['Daytime Routes'].split(' ').filter(Boolean);
    return {
      id: r['GTFS Stop ID'],
      name: r['Stop Name'],
      borough: r['Borough'],
      routes,
      feeds: [...new Set(routes.map(rt => feedFor(rt, line)).filter(Boolean))],
      lat: Number(r['GTFS Latitude']),
      lon: Number(r['GTFS Longitude']),
      north: r['North Direction Label'],
      south: r['South Direction Label'],
    };
  })
  .filter(s => s.id && s.feeds.length && Number.isFinite(s.lat) && Number.isFinite(s.lon))
  .sort((a, b) => a.id.localeCompare(b.id));

const unmapped = stations.filter(s => s.feeds.length === 0);
if (unmapped.length) console.warn('Stations with no feed:', unmapped.map(s => s.id).join(', '));

await writeFile(OUT, JSON.stringify(stations, null, 0) + '\n');
console.log(`Wrote ${stations.length} stations to ${OUT}`);
