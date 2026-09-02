# MaujerDash

A small live subway dashboard. The dark-themed single page (`home.html`) shows a map of the search radius around you with the nearby stations pinned on it, and below the map lists those stations — closest first — with upcoming arrivals in each direction. Hovering a station highlights its pin; clicking a pin jumps to its row. An Express server reads the MTA GTFS-realtime feeds on demand and caches each feed for 15 seconds.

The map is [Leaflet](https://leafletjs.com/), installed as a dependency and served from `node_modules` at `/vendor/leaflet` rather than from a CDN. Tiles come from OpenStreetMap's public tile servers (no API key, attribution shown on the map) and are inverted in CSS to match the dark theme.

## Arrivals, travel times and focus sessions

Each train is a circle of liquid: full and green about 20 minutes out, draining and reddening as it approaches. Every station row also shows how long it takes to reach that station on foot, by bike and by car, with the fastest of the three picked out.

Clicking a station traces the street route to it on the map. Clicking one of its trains does the same and opens a **focus session** — a full-screen countdown to the moment you need to *leave*, which is the train's arrival minus the walk minus a 3-minute buffer for actually getting to the platform. It turns amber under two minutes and reads `NOW` in red when the time is up, and it follows the feed, so a delayed train pushes your deadline out. Trains you can no longer reach in time are dimmed and cannot start a session. Press `Escape` or `End session` to leave.

## A caveat on travel times

Travel times come from the public [OSRM](https://project-osrm.org/) demo server, which only runs the **car** profile — it returns identical numbers whatever profile you ask it for. So the app takes the *street distance* from OSRM and derives walking (3 mph) and cycling (10 mph) times from it, and uses OSRM's duration only for driving. Two consequences worth knowing:

- The drawn route is a driving route, so a walking path may differ where one-way streets are involved.
- Walking and cycling times are steady-pace estimates; they do not account for hills, lights or waiting to cross.

If OSRM is unreachable the app falls back to straight-line distance padded by 30% for the street grid, and flags it as `estimated` in the API and in the row's tooltip.

## Setting the location

The location is picked once and then stays put; only the arrival times refresh. Use **Change** to set it, either way:

- **Use my location** — takes a single GPS fix. It does not keep re-locating; press it again to re-fix.
- **Search** — an address, a station name, or raw `lat, lon`. Pick a result to pin it.

The choice is saved in `localStorage`, so it survives reloads until you change it. On a first visit the page asks for location once; decline it and the picker opens with Maujer St in Williamsburg shown in the meantime.

## Requirements

- Node.js (with npm)

## Running locally

Install dependencies:

```sh
npm install
```

Start the server:

```sh
npm start
```

This runs `node server.js`, listening on port 3000 by default. Open:

- <http://localhost:3000> — the dashboard
- <http://localhost:3000/api/nearby?lat=40.7118&lon=-73.943> — raw nearby-stations JSON
- <http://localhost:3000/api/debug/stops?feed=l> — every stop ID seen in one realtime feed

To use a different port:

```sh
PORT=4000 npm start
```

Note that browsers only expose geolocation over https or on `localhost`. Reaching the dashboard over plain http at a LAN address will silently fall back to Maujer St.

## API

`GET /api/nearby` (also served at `/api/trains`)

| Query    | Default          | Notes                                     |
| -------- | ---------------- | ----------------------------------------- |
| `lat`    | 40.7118 (Maujer St) | Falls back to the default if missing or invalid |
| `lon`    | -73.943          | ″                                         |
| `radius` | `0.5`            | Miles, capped at 5                        |
| `limit`  | `6`              | Max stations returned, capped at 20       |

Returns the stations within `radius` sorted by distance, each with its routes, distance, a `travel` block (`walk` / `bike` / `drive` minutes, `streetMiles`, and `estimated`), and up to six upcoming arrivals per direction. If nothing is within `radius`, the closest few stations are returned anyway with `expandedSearch: true`. A routing failure is reported in `routingError` and leaves the arrivals untouched.

`GET /api/route?lat=&lon=&toLat=&toLon=` returns the street path between two points as GeoJSON plus the same `travel` block. Results are cached for an hour.

`GET /api/geocode?q=` turns typed text into candidate coordinates. `lat, lon` pairs and station names are answered from `stations.json` with no network call; anything else is looked up against [Nominatim](https://nominatim.openstreetmap.org/), rate-limited to their one-request-per-second policy and cached. A geocoder failure is reported in `geocoderError` and does not remove the local matches, so station search keeps working offline.

## Station data

`stations.json` is the station index — one entry per station with its GTFS stop ID, coordinates, daytime routes, direction labels, and which realtime feeds carry it. It is generated from the MTA's published [subway station list](https://data.ny.gov/Transportation/MTA-Subway-Stations/39hk-dx4f):

```sh
node scripts/build-stations.mjs
```

Re-run that when the MTA changes stations or route assignments. Realtime stop IDs are the station ID plus a direction suffix (`L10` covers `L10N` and `L10S`), which is how arrivals are matched back to stations.
