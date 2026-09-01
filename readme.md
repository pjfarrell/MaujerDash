# MaujerDash

A small live subway dashboard for the Lorimer St (L) and Metropolitan Av (G) stations. An Express server polls the MTA GTFS-realtime feeds every 15 seconds and serves a dark-themed single-page dashboard (`home.html`) showing upcoming train arrivals in each direction.

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
- <http://localhost:3000/api/trains> — raw arrivals JSON
- <http://localhost:3000/api/debug/stops> — lists all stop IDs seen in the feeds, useful for verifying/correcting the configured stop IDs

To use a different port:

```sh
PORT=4000 npm start
```

## Configuration

Stop IDs and direction labels are configured at the top of [server.js](server.js):

- `L_STOP` — Lorimer St (L train), default `L10`
- `G_STOP` — Metropolitan Av (G train), default `G29`

Verify or find stop IDs via the `/api/debug/stops` endpoint above, or by browsing the static GTFS package at <https://api.mta.info/#/subwayRealTimeFeeds>.
