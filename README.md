# Miles Maximiser v1.6.0

Small Node.js web app that ranks Economy and Premium Economy flights from Singapore by **KrisFlyer miles earned per SGD spent**, across Singapore Airlines and selected Star Alliance partners.

No dependencies. Node 18+. See `CHANGELOG.md` for version history.

```bash
npm start            # http://localhost:3000
npm test             # unit tests
PORT=8080 npm start  # different port
```

## Airlines

| Code | Airline | Routes from SIN | Premium Economy |
|---|---|---|---|
| SQ | Singapore Airlines | 40 nonstop destinations | Yes |
| TK | Turkish Airlines | IST, plus Europe/New York via IST | No cabin |
| LH | Lufthansa | MUC (seasonal, 7 May – 23 Oct 2026) | Yes |
| LX | SWISS | ZRH | Yes |
| NH | ANA | NRT, HND | Yes |
| CA | Air China | PEK | Not modelled |
| NZ | Air New Zealand | AKL, CHC | Yes |

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
| Air China | Q, 50% | — | Assumed |

The Earn column shows ✓ (published) or ≈ (assumed). If your own quote books into a different class, change the letter in that row; "Reset my edits" restores sale classes. Notable rules:

- Air China: classes not in the chart (e.g. K, L) earn nothing.
- Air New Zealand: L, S, G, K earn only on Singapore–Auckland; other routes are flagged "not eligible".
- Lufthansa City flights do not earn.

## Prices

`data/fares.*.json` hold the **lowest advertised return fares** (SGD, all-in); sources and dates are in `data/sources.json` and shown in the page footer. Rows without a price still show miles — type in a quote or use live pricing. Edits are saved in your browser.

## Live prices (optional)

```bash
SERPAPI_KEY=your_key npm start
```

A ↻ button appears beside each price and fetches the lowest Google Flights fare on that row's airline for the chosen dates. Results are cached for 6 hours (free tier: 250 searches/month).

## API

| Endpoint | Purpose |
|---|---|
| `GET /api/meta` | Version, carriers + accrual tables, sources, live pricing status |
| `GET /api/routes?tiers={"SQ:economy":"75-HMW"}&roundTrip=true&overrides={"CA:PEK:economy":420}` | Ranked rows |
| `GET /api/live?carrier=TK&dest=LHR&cabin=economy&outbound=2027-03-01&inbound=2027-03-10` | Live lowest fare |

## Limits

- Great-circle distances approximate KrisFlyer's sector mileage.
- PPS Club / Elite bonus miles are not included.
- Routings are fixed per row; real itineraries may connect elsewhere.
