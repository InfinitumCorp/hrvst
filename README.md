# [HRVST]

Personal data exchange. A capture is refined, privacy-filtered, and packaged. The owner keeps it in the silo or lists it. Buyers pay in Harvest Credits. Contributors receive 85 percent. The platform keeps 15. A restricted place (`private_residence`, `school`, `hospital`, `military`, `home_interior`) stays on the device unless the owner opts in. Opt-in is `POST /v1/captures/:id/refine` with `{ "optedIn": true }`. Without that flag it is excluded. Raw contact details are still stripped.

## Anchor buyer

**Premise** ([premise.com](https://premise.com)) is the data buyer to approach. They already pay people for retail-shelf audits and public-place inspections. Status: prospective. There is no contract, no Harvest Credit balance, and no licence until a person signs one. A mission from Premise may ask only for `retail`, `street`, `public_building`, or `field`.

A kept or listed packet can emit a `fault` signal for :\ARCHITECT\. The signal is a service request. Architect still stops before any irreversible step. The standalone bridge is `examples/architect-signal.ts`, which posts to `POST /v1/signals/hrvst` on the Architect server.

## API

`HRVST_API_TOKEN` is required whenever the process is reachable by anyone else. Services send it as `Authorization: Bearer`. People sign in with Cumulus ID in a product and send their Cumulus ID token instead; HRVST checks it at `CID_ISSUER` (default `https://id.cumuluscloud.app`, can be a mirror that loads in Russia) and lets them act only as their own CID.

| Method | Path | |
|---|---|---|
| GET | `/healthz` | liveness |
| GET | `/v1/board` | captures, packets, missions, grants, ledger, signals |
| POST | `/v1/captures` | `{ owner, note, placeLabel, placeClass }` |
| POST | `/v1/captures/:id/refine` | filter, or exclude a restricted place unless `{ "optedIn": true }` |
| POST | `/v1/packets/:id/decide` | `{ action: keep|list|delete, priceCredits? }` |
| GET | `/v1/market` | listed packets: place, quality, uses, price; no owner, no observation |
| POST | `/v1/packets/:id/license` | `{ licensee }` |
| GET | `/v1/grants/:id` | the licensee collects the observation and its proof; the contributor stays anonymous |
| POST | `/v1/packets/:id/signal` | queue an Architect fault |
| POST | `/v1/missions` | buyer posts a rewarded request; the reward is held in escrow; restricted places are refused |
| POST | `/v1/missions/:id/claim` | `{ owner }` |
| POST | `/v1/missions/:id/submit` | `{ packetId }` |
| POST | `/v1/missions/:id/accept` | pays the claimer from escrow |
| POST | `/v1/missions/:id/cancel` | buyer withdraws an open mission; the reward comes back |

A person only acts on what they own: refine their own captures, keep, list, delete or signal their own packets, license for themselves, submit missions they claimed, and accept missions they posted. Anything else is `403`. For a person, `GET /v1/board` shows their own silo, credits, grants and signals, plus open missions and their own missions. A service with `HRVST_API_TOKEN` sees the whole board.

## Storage

Set `HRVST_DATA_FILE` (for example `data/hrvst.json`) to keep captures, packets, missions, grants, the credit ledger and the proof-chain tip across restarts. Each successful change is written before the reply goes out, to a temporary file that is then renamed over the old one, with owner-only permissions. A new data file starts empty; set `HRVST_SEED=1` once to load the demo data. Without `HRVST_DATA_FILE` everything lives in memory with the demo data, and a restart loses it. The file holds personal data, so keep it out of git (`data/` is ignored) and on an encrypted disk. One process per data file.

```bash
npm test
HRVST_API_TOKEN=change-me HRVST_DATA_FILE=data/hrvst.json npm start
```

Proof of perspective is a SHA-256 chain over owner, capture time, raw digest, and the filtered observation. Raw media is not stored.

This is the civilian product. It does not sell observations from restricted places, and it does not task military systems.
