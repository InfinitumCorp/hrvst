# [HRVST]

Personal data exchange. A capture is refined, privacy-filtered, and packaged. The owner keeps it in the silo or lists it. Buyers pay in Harvest Credits. Contributors receive 85 percent. The platform keeps 15. Restricted places never become packets.

A kept or listed packet can emit a `fault` signal for :\ARCHITECT\. The signal is a service request. Architect still stops before any irreversible step. The standalone bridge is `examples/architect-signal.ts`, which posts to `POST /v1/signals/hrvst` on the Architect server.

## API

`HRVST_API_TOKEN` is required whenever the process is reachable by anyone else.

| Method | Path | |
|---|---|---|
| GET | `/healthz` | liveness |
| GET | `/v1/board` | captures, packets, missions, grants, ledger, signals |
| POST | `/v1/captures` | `{ owner, note, placeLabel, placeClass }` |
| POST | `/v1/captures/:id/refine` | filter, or exclude a restricted place |
| POST | `/v1/packets/:id/decide` | `{ action: keep|list|delete, priceCredits? }` |
| POST | `/v1/packets/:id/license` | `{ licensee }` |
| POST | `/v1/packets/:id/signal` | queue an Architect fault |
| POST | `/v1/missions` | buyer posts a rewarded request |
| POST | `/v1/missions/:id/claim` | `{ owner }` |
| POST | `/v1/missions/:id/submit` | `{ packetId }` |
| POST | `/v1/missions/:id/accept` | pays the claimer |

```bash
npm test
HRVST_API_TOKEN=change-me npm start
```

## Geo routing

Geo routing is off unless the saved preference and `INFINITUM_GEO_ENABLED` are both on. Captures, the privacy filter, licenses, and missions are unchanged while it is off.

HRVST has no settings screen. The preference is `.hrvst/settings.json` (`geoRouting`, default off):

```bash
node --experimental-strip-types src/settings.ts
node --experimental-strip-types src/settings.ts --geo-routing on
node --experimental-strip-types src/settings.ts --no-geo-routing
npm start -- --geo-routing off
```

With both switches on, HRVST reads `data/geoip.dat` and `data/geosite.dat`, logs the client country and the request host's site categories, and adds that note to an Architect fault. `npm run geo:fetch` downloads the pinned v2fly releases, checks them against `geo.lock.json` and the official `.sha256sum` assets, and stops on a mismatch. The `.dat` files are not committed. See `THIRD_PARTY_NOTICES`.

Proof of perspective is a SHA-256 chain over owner, capture time, raw digest, and the filtered observation. Raw media is not stored.

This is the civilian product. It does not sell observations from restricted places, and it does not task military systems.
