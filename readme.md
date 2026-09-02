# MaujerDash

A small live subway dashboard. The dark-themed single-page dashboard (`home.html`) lists the nearest subway stations — closest first — with upcoming arrivals in each direction. An Express server reads the MTA GTFS-realtime feeds on demand and caches each feed for 15 seconds.

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

Returns the stations within `radius` sorted by distance, each with its routes, distance, walking estimate, and up to six upcoming arrivals per direction. If nothing is within `radius`, the closest few stations are returned anyway with `expandedSearch: true`.

`GET /api/geocode?q=` turns typed text into candidate coordinates. `lat, lon` pairs and station names are answered from `stations.json` with no network call; anything else is looked up against [Nominatim](https://nominatim.openstreetmap.org/), rate-limited to their one-request-per-second policy and cached. A geocoder failure is reported in `geocoderError` and does not remove the local matches, so station search keeps working offline.

## Station data

`stations.json` is the station index — one entry per station with its GTFS stop ID, coordinates, daytime routes, direction labels, and which realtime feeds carry it. It is generated from the MTA's published [subway station list](https://data.ny.gov/Transportation/MTA-Subway-Stations/39hk-dx4f):

```sh
node scripts/build-stations.mjs
```

Re-run that when the MTA changes stations or route assignments. Realtime stop IDs are the station ID plus a direction suffix (`L10` covers `L10N` and `L10S`), which is how arrivals are matched back to stations.
