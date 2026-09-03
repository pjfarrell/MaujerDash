# MaujerDash

A small live subway dashboard. The dark-themed single page (`home.html`) shows a map of the search radius around you with the nearby stations pinned on it, and below the map lists those stations — closest first — with upcoming arrivals in each direction. Hovering a station highlights its pin; clicking a pin jumps to its row. An Express server reads the MTA GTFS-realtime feeds on demand and caches each feed for 15 seconds.

The map is [Leaflet](https://leafletjs.com/), installed as a dependency and served from `node_modules` at `/vendor/leaflet` rather than from a CDN. Tiles come from OpenStreetMap's public tile servers (no API key, attribution shown on the map) and are inverted in CSS to match the dark theme.

## Arrivals, travel times and focus sessions

Each train is a circle of liquid: full and green about 20 minutes out, draining and reddening as it approaches.

A **Walk / Bike / Drive** selector in the header sets how you plan to reach a station, and the whole board answers for that choice: each station row shows that method's travel time (the other two stay on the tooltip), and a train is dimmed as unreachable when that method can't get you there in time. The choice is saved for next time.

Clicking a station traces the street route to it on the map. Clicking one of its trains does the same and opens a **focus session** — a full-screen countdown to the moment you need to *leave*, which is the train's arrival minus your travel time minus a 2-minute buffer for actually getting to the platform. It turns amber under two minutes and reads `NOW` in red when the time is up, and it follows the feed, so a delayed train pushes your deadline out.

The session shows the route to the station and its own **Walk / Bike / Drive** selector, each labelled with its travel time, so you can reconsider for one train without changing the board. Switching recomputes the countdown, and a method that can no longer make the train is greyed out — so a train 20 minutes away from a station 17 minutes' walk offers only Bike and Drive. A session opens on the board's method, or on the simplest one that still makes the train if that method no longer does. Press `Escape` or `End session` to leave.

## A caveat on travel times

Travel times come from the public [OSRM](https://project-osrm.org/) demo server, which only runs the **car** profile — it returns identical numbers whatever profile you ask it for. So the app takes the *street distance* from OSRM and derives walking (3 mph) and cycling (10 mph) times from it, and uses OSRM's duration only for driving. Two consequences worth knowing:

- The drawn route is a driving route, so a walking path may differ where one-way streets are involved. This is why the Walk / Bike / Drive selector changes the *times* but not the drawn line — the public router has no walking or cycling geometry to give. Pointing `OSRM_BASE` at an instance with foot and bike profiles, or swapping in a router like Valhalla, would make the paths differ too.
- Walking and cycling times are steady-pace estimates; they do not account for hills, lights or waiting to cross.

If OSRM is unreachable the app falls back to straight-line distance padded by 30% for the street grid, and flags it as `estimated` in the API and in the row's tooltip.

Current conditions for the chosen location sit next to the clock in the header and at the top of a focus session. Clicking the header reading opens a forecast widget for the whole day: current conditions, today's high and low, wind, sunrise and sunset, and all 24 hours as a scrollable strip — temperature, a bar scaled to the day's own range, conditions and chance of rain, with the current hour highlighted and scrolled into view.

Data is [Open-Meteo](https://open-meteo.com/) (no API key), cached for 10 minutes and refreshed when the location moves. `GET /api/weather?lat=&lon=` returns it. If it fails the app hides the weather rather than breaking the board.

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

## Running on a Raspberry Pi

Docker Compose builds and runs it as a service. From the project directory on the Pi:

```sh
docker compose up -d --build
```

That serves the dashboard on port 8080. Copy `.env.example` to `.env` to change `HOST_PORT` or `TZ`. Useful follow-ups:

```sh
docker compose logs -f      # follow the log
docker compose ps           # state, including the healthcheck
docker compose down         # stop and remove
docker compose up -d --build   # redeploy after a git pull
```

Notes for a Pi specifically:

- `node:20-alpine` is multi-arch, so the same Dockerfile builds on 64-bit Pi OS (arm64) and 32-bit (arm/v7). The first build is the slow part — it compiles nothing, but `npm ci` on an SD card takes a few minutes. Later builds reuse that layer unless `package.json` or `package-lock.json` changed.
- Logs are capped at 3 × 10 MB. Unbounded container logs will fill an SD card eventually.
- The healthcheck hits `/healthz`, which touches nothing external, so an MTA or OSRM outage shows up in the UI rather than restarting the container.
- The container runs as the unprivileged `node` user and stores nothing — all caches are in memory, so there are no volumes to back up. To reset everything, restart it.

### Geolocation over the LAN

Browsers only expose location over https or on `localhost`. Reaching the Pi at `http://raspberrypi.local:8080` from a phone means **"Use my location" will not work** — the dashboard falls back to Maujer St, and you set the location with the search box instead (it is saved, so this is a one-time step per device).

If you want the location button to work off the Pi, the page has to be served over https — a reverse proxy such as Caddy with a real certificate, or a mesh network like Tailscale, are the usual routes.

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
