# Miles Maximiser v1.9.0

Small Node.js web app that ranks Economy and Premium Economy flights from Singapore by **KrisFlyer miles earned per SGD spent**, across Singapore Airlines and selected Star Alliance partners.

No dependencies. Node 18+. See `CHANGELOG.md` for version history.

```bash
npm start            # http://localhost:3000
npm test             # unit tests
PORT=8080 npm start  # different port
```

## Airlines

| Code | Airline | Routes from SIN (Economy fare from) | Premium Economy |
|---|---|---|---|
| SQ | Singapore Airlines | 40 nonstop destinations | Yes |
| TK | Turkish Airlines | IST (S$707), plus Europe/New York via IST | No cabin |
| LH | Lufthansa | MUC (S$1,307); 5 weekly in winter 2026–27, daily 17 Jan – 17 Feb 2027 | Yes (no price yet) |
| LX | SWISS | ZRH (S$1,263) | Yes (no price yet) |
| NH | ANA | NRT (S$749), HND, LAX via HND (S$1,188) | Yes (no price yet) |
| CA | Air China | PEK (S$425) | Yes, classes G/E (no price yet) |
| NZ | Air New Zealand | AKL, CHC | Yes |

Every airline has at least one priced route (checked by `npm test`). Rows marked "no price yet" still show miles; type in a quote or use live prices.

Add a route by appending to `data/fares.partners.json`; add an airport to `data/airports.json`. Data is validated on start.

## Views

- **Table**: ranked list with editable prices.
- **Map**: routes from Singapore on an interactive 3D globe (drag to spin, scroll/pinch to zoom, double-click to recentre) or a flat world map. Colour by miles per SGD or by airline; hover or tap a line or city for details. Uses the same filters as the table.

- **Planner**: enter a miles target and the most trips you'd take (default 50,000 miles, up to 5 trips); get the cheapest combinations of 1 to N tickets that reach it, with no trip you could drop. Follows the filters and class settings above.
- **Sales calendar** (button, top right): typical yearly sale windows per airline (including main sales run in other markets, dashed), shaded in the airline's colour as Small Sale, Large Sale or Main Sale. Edit `data/sales.json` to update.

Map libraries (d3-geo, topojson-client, world-atlas) are vendored in `public/vendor/`, so there is still nothing to install.

## How it calculates

```
distance    = sum of great-circle segment distances (e.g. SIN→IST + IST→LHR)
miles       = distance × 2 (return) × accrual %
miles / SGD = miles ÷ return fare
¢ / mile    = return fare × 100 ÷ miles
```

Accrual % per airline and booking class comes from the KrisFlyer chart (updated 8 Aug 2025), in `data/carriers.json`. The partner chart lists Economy and Premium Economy together; Premium Economy classes are assigned per airline (LH/LX G, E, N; NH E, G; NZ A, E, O, U).

Earn rates follow the **booking class the sale fare books into** (`saleFare` in `data/carriers.json`, or a per-fare `class` in `fares.*.json`):

| Airline | Economy sale class | Premium Economy sale class | Basis |
|---|---|---|---|
| Singapore Airlines | K/V Economy Lite, 50% | R PE Lite, 100% | Published (SIA fare rules) |
| Air New Zealand | K, 10% to AKL only | O/A Global Saver, 110% | Economy published; PE assumed |
| Turkish | V, 25% | — | Assumed |
| ANA | K, 50% | E/G, 125% | Assumed |
| Lufthansa, SWISS | V, 50% | N, 100% | Assumed |
| Air China | Q, 50% | E, 100% (G earns 110%) | Assumed |

The Earn column shows ✓ (published) or ≈ (assumed). If your own quote books into a different class, change the letter in that row; "Reset my edits" restores sale classes. Notable rules:

- Air China: classes not in the chart (e.g. K, L) earn nothing.
- Air New Zealand: L, S, G, K earn only on Singapore–Auckland; other routes are flagged "not eligible".
- Lufthansa City flights do not earn.

## Prices

`data/fares.*.json` hold the **lowest advertised return fares** (SGD, all-in); sources and dates are in `data/sources.json` and shown in the page footer. Rows without a price still show miles — type in a quote or use live pricing. Edits are saved in your browser.

## Live prices

Tap ↻ on a row to fetch the current lowest fare on that airline. Results are cached for 6 hours per date.

**Travel dates (optional).** Enter Depart and Return to search only those dates. Leave both blank to check a trip about 60 days out for 7 nights; leave Return blank for 7 nights.

**Flexibility.** Exact, ± 1, ± 2 or ± 3 days. ↻ searches each trip shifted by up to that many days (departure and return move together, so trip length stays the same) and keeps the cheapest. The dates found appear under the price. With SerpApi, ± N costs up to 2N + 1 searches per ↻.

| Provider | When it's used | Setup |
|---|---|---|
| **SerpApi** (recommended) | You've added a key | Free key (250 searches/month) at [serpapi.com](https://serpapi.com/users/sign_up). Paste it when the app asks, or set `SERPAPI_KEY`. |
| **fast-flights** | No key, or SerpApi fails (e.g. quota used) | `pip install -r requirements.txt` (Python 3.9+). Free, but it's an unofficial Google Flights scraper and can break without notice. |

The saved key lives in `.local/config.json` on the machine running the server (gitignored, never sent to the browser). The server listens on `127.0.0.1`; set `HOST=0.0.0.0` to open it on your network. Use `PYTHON=/path/to/python` if `python3` isn't the interpreter with fast-flights installed.

## Free prices from Google Flights (no key)

1. Open **Live prices → Free prices from Google Flights** and drag **Send to Miles Maximiser** to your bookmarks bar.
2. Tap **G** on a row. Google Flights opens filtered to that airline, cabin, SGD and your dates.
3. Optionally open **Date grid** (7 × 7 nearby dates), then click the bookmark. The cheapest price within your dates ± flexibility is saved to the row, with its dates.

Keep Google's airline filter on one airline: miles depend on who flies you, so the app refuses pages without it. Lufthansa City flights are skipped (no KrisFlyer miles). If Google changes its page, the bookmark may stop working until `public/bookmarklet.js` is updated.

The server can't fetch the date grid itself: Google requires a per-request BotGuard token that only a real browser session produces.

## Connecting routes

A route's `via` (e.g. `"via": ["IST"]`) is part of its miles: distance is summed per segment flown. Live prices, **G** links and bookmark imports stick to that connection (airline filter + stop limit, and layover checks where the source reports them). Add `"cabins": ["economy"]` when the connecting flight has no Premium Economy.

**Mixed airlines**: list segments instead of carrier/via:

```json
{"to": "BOD", "segments": [{"carrier": "SQ", "to": "ZRH"}, {"carrier": "LX", "to": "BOD"}], "cabins": ["economy"]}
```

Each segment earns at its own airline's rate for its booking class (pick per airline in the Earn column). Searches filter to the route's airlines and check who flies each segment.

**Search a region**: "↻ Search <region>" under Live prices searches every row shown (region + airline/cabin filters), saving each result. Searching all regions at once needs a SerpApi key. fast-flights searches run one at a time, about 1 s apart (normally distributed pause, mean 1 s, sd 0.25 s).

## Price database

Every price found (↻ searches and Google Flights imports) is saved in `data/db/*.jsonl`, tagged with the search range, the dates priced and when it was searched. Nothing is deleted, and all files are loaded on startup. Rows show the latest saved price for your dates, with earlier searches in the tooltip. Prices older than 14 days are marked preliminary. Pick earlier date ranges from **Saved searches** under Live prices. A ↻ reuses a price saved in the last 24 hours instead of searching again. Details: [`data/db/README.md`](data/db/README.md).

## Sharing prices with other users

Prices can be shared, anonymised, through the private data repo [`jtthejam/miles-prices`](https://github.com/jtthejam/miles-prices). It's private because Google Flights and SerpApi results aren't licensed for public redistribution.

1. Ask for access, then clone it into this folder: `git clone https://github.com/jtthejam/miles-prices.git data/community`
2. Start the app: it pulls everyone's prices and shows them as **community** prices (after your own).
3. Your saved prices are anonymised into `data/community/` automatically once they're 2 days old. Send them with `node scripts/share_prices.js --pr`.

A shared price keeps only route, cabin, dates priced, price, provider and the day it was searched. Every pull request in the data repo is checked against these rules. Details: the data repo's README.

## Route network

`data/fares.network.json` holds unpriced connecting routes to the main European and US cities. `scripts/build_network.py` builds it from dated research files (`data/research/YYYY-MM-DD/*.json`), which record which hub serves which city and who operates it, with sources. Only routes where every segment was verified are included. Lufthansa routes flown partly by Lufthansa City Airlines (no KrisFlyer miles) are left out.

```
python3 scripts/build_network.py data/research/2026-10-26
```

## API

| Endpoint | Purpose |
|---|---|
| `GET /api/meta` | Version, carriers + accrual tables, sources, live pricing status |
| `GET /api/routes?tiers={"SQ:economy":"75-HMW"}&roundTrip=true&overrides={"CA:PEK:economy":420}` | Ranked rows |
| `GET /api/live?carrier=TK&dest=LHR&cabin=economy&outbound=2027-03-01&inbound=2027-03-10&flex=2` | Live lowest fare (SerpApi, else fast-flights). Dates optional; `flex` 0-3 days. Returns the cheapest trip's `lowest`, `outbound`, `inbound`, plus `byDate` |
| `POST /api/settings/serpapi` `{"key": "…"}` / `DELETE` | Save / remove the SerpApi key (local machine only) |
| `GET /api/db/searches` | Saved search ranges (newest first) |
| `POST /api/db/records` `{"route", "cabin", "range", "prices": [{outbound, inbound, price}]}` | Save Google Flights import prices |

## Limits

- Great-circle distances approximate KrisFlyer's sector mileage.
- PPS Club / Elite bonus miles are not included.
- Routings are fixed per row; real itineraries may connect elsewhere.
