# Changelog

## v1.9.0 — 2026-10-25

### Added
- Every airline now has at least one priced route (new test enforces it):
  - Lufthansa Singapore–Munich from S$1,307 and SWISS Singapore–Zurich from S$1,263 (Economy, from the airlines' SG fare pages).
  - Air China Singapore–Beijing from S$425 (Economy).
  - ANA Singapore–Los Angeles via Tokyo Haneda from S$1,188 (Economy), 21,920 miles in Premium Economy at 125%.
- Air China Premium Economy: classes G (110%) and E (100%) from the KrisFlyer chart; sale fares assumed to book into E. Priced at "add" until a fare is entered.

### Changed
- Lufthansa Munich is no longer flagged seasonal: it runs 5 weekly through winter 2026–27 (daily 17 Jan – 17 Feb 2027).
- Air China Economy accrual now lists only Economy classes (Y/B/M/U 100%, H/Q/V 50%); G and E moved to Premium Economy.

## v1.8.1 — 2026-10-25

### Fixed
- Table no longer runs past the right edge of the cards above it. Its natural width matched the page width in Chromium on Linux, so the wider system fonts on macOS and Windows pushed it about 16px over. Inner cell padding is now 8px (was 12px); the first and last columns keep 12px so text still lines up with the cards. The table now fits with 40–75px to spare.

## v1.8.0 — 2026-10-25

### Added
- **Optional travel dates** for live prices: Depart and Return in the Live prices bar now start blank. ↻ searches only within the dates you enter. With no dates, it checks a trip about 60 days out for 7 nights (as before). Leaving Return blank means 7 nights.
- **Flexible dates**: Exact, ± 1, ± 2 or ± 3 days. ↻ searches every shifted trip (departure and return move together, so trip length stays the same) and keeps the cheapest. Ties go to the date closest to the one you entered. Past departure days are skipped.
- Each live price shows the dates it was found for under the price (e.g. "3 Dec – 10 Dec"), and in its tooltip.
- A hint under the bar explains what ↻ will search. With SerpApi, it warns that ± N uses up to 2N + 1 searches per ↻ (free tier: 250/month).
- Dates and flexibility are remembered in your browser; dates that have passed are dropped.

### Changed
- Dates are validated as real calendar dates; Return must be on or after Depart; Depart can't be in the past (Singapore date).
- Typing a price over a live fare removes its dates; "Reset my edits" clears them too.

### Technical
- `/api/live` takes optional `outbound`, `inbound` and `flex` (0-3). Response adds `outbound`/`inbound` of the cheapest trip, `requested`, `window`, `searched`, `failed`, `providers` and `byDate` (fare or error per date). Existing fields unchanged.
- `lib/live.js`: `datePairs()` and `lowestFareInWindow()`. Searches run 2 at a time; each date is still cached for 6 hours and still falls back from SerpApi to fast-flights. If some dates fail, the cheapest of the rest is returned; if all fail, the first error is.
- 8 new tests (date defaults, flex shifting, past-day skipping, validation, cheapest pick and tie-break, partial and total failure, SerpApi request per date, endpoint).

## v1.7.0 — 2026-10-24

### Added
- **SerpApi key prompt**: on first load the app asks for a free SerpApi key (250 searches/month), with links to sign up and find the key. "Not now" hides the prompt; "Add / Remove SerpApi key" in the Live prices bar manages it.
- Key is saved only on the computer running the server (`.local/config.json`, mode 600, gitignored) and is never sent to the browser. `SERPAPI_KEY` env var still works and takes precedence.
- **fast-flights fallback**: with no key, live prices come from fast-flights (free, unofficial Google Flights scraper, `pip install fast-flights`). With a key, fast-flights is the backup if SerpApi fails (e.g. monthly quota used up).
- Live prices bar always shows which provider is in use; ↻ buttons appear whenever a provider is available.

### Changed
- Server now listens on `127.0.0.1` by default (set `HOST=0.0.0.0` to expose it on your network). Settings can only be changed from the same machine.

### Technical
- `scripts/ff_quote.py` (fast-flights helper, called by the Node server), `lib/settings.js`, `requirements.txt`.
- New tests cover provider selection, SerpApi→fast-flights fallback, key validation/permissions and the settings endpoint (fast-flights simulated).

## v1.6.0 — 2026-10-24

### Changed
- Planner now searches **up to** N trips (1 to N) instead of exactly N, and ranks all combination sizes together by total fare. Each result shows its trip count.
- Only combinations where every trip is needed are listed (dropping any one would fall short of the target), so results don't pad a qualifying set with extra flights.
- New defaults: **50,000 miles, up to 5 trips**. Previously saved planner settings are reset to these defaults once.

## v1.5.0 — 2026-10-24

### Changed
- **Earn rates now follow the sale fare's booking class** instead of per-airline assumptions you had to set. Each airline/cabin carries the class its sale fares book into, with a note on whether the airline publishes it (✓) or it is assumed (≈):
  - Singapore Airlines Economy sale fares → K/V Economy Lite (50%); Premium Economy → R PE Lite (100%). Published in SIA fare rules.
  - Air New Zealand Singapore promo Economy → K (10% to Auckland; nothing to Christchurch).
  - Turkish V (25%), ANA K (50%) / E-G (125%), Lufthansa & SWISS V (50%) / N (100%), Air China Q (50%), Air NZ PE O/A (110%): assumed, as these airlines don't publish sale classes.
- Removed the "Booking class assumptions" panel. The Earn column shows the % and class letter; tap the letter only if your quote is in a different class (per row, highlighted when changed).
- Ineligible rows explain why (e.g. "Class K earns only to AKL", "Class K earns no KrisFlyer miles").
- Planner results and map tooltips show each trip's booking class.
- "Reset edited prices" is now "Reset my edits" and also clears class changes.

### Effect on numbers
- Singapore Airlines Economy sale fares now earn 50% (was 75% by default), so Economy miles/S$ drop by a third; Premium Economy is unchanged. Air NZ Economy promo now earns 10% to Auckland (was 100%).

### Technical
- `/api/routes` takes `classes` (per-row overrides) instead of `tiers`. Old saved per-airline settings are discarded.

## v1.4.1 — 2026-10-24

### Changed
- Sales calendar now includes each airline's main yearly sales, including ones run outside Singapore: Turkish Friday Flyday + Travel Tuesday, Lufthansa and SWISS Black Friday, Air China Double 11 / Cyber Week / summer flash sale, Air New Zealand New Year and Adventure Beyond sales, ANA Japan time sale, Turkish Sales Fest.
- Air New Zealand's main sale is now its New Year sale; the Singapore promo is a Large Sale.
- Legend and labels read **Small Sale**, **Large Sale**, **Main Sale** (opacity still 10% / 25% / 40%).
- Sales run in another market have a dashed outline and a market tag in the details list.
- Overlapping sales for the same airline stack into lanes instead of covering each other.

### Technical
- `data/sales.json` entries carry a required `market` field.

## v1.4.0 — 2026-10-24

### Added
- **Planner** tab: enter the miles you want to earn and the number of trips (1–6); get the 20 cheapest combinations of exactly that many tickets that reach the target, ranked by total fare.
- Each result shows total fare, total miles, surplus over target and cost per mile, with every trip's airline, cabin, routing, miles and fare.
- "Different destinations" toggle (on by default); turn off to allow repeat trips to the same city.
- Uses the same airline, cabin, region, booking class and price settings as the table, and re-ranks live when they change. Explains when a target is out of reach and the most that many trips can earn.
- Planner settings and the chosen tab are remembered.

### Technical
- `public/planner.js`: branch-and-bound search (cost and miles bounds), shared by the browser and Node tests; verified against brute force on random cases. Worst case (6 trips, full dataset) runs in milliseconds.

## v1.3.0 — 2026-10-24

### Added
- **Sales calendar** button (top right) opens a year-planner overlay of typical sale windows for bookings from Singapore, one row per airline.
- Bars use each airline's brand colour: 10% opacity = small sale, 25% = large sale, 40% = main sale of the year. Travel fairs (NATAS Travel, NATAS Holidays, SIA Time To Fly) shown as a hatched row; red line marks today.
- Click or tap a bar to jump to its details (dates, basis year, source link). Airlines with no recurring Singapore sale found are labelled as such.
- Phone layout: airline names stay fixed while the timeline scrolls, opening on the current month. Esc or backdrop click closes; focus stays inside the dialog.

### Technical
- Sale windows in `data/sales.json` (MM-DD ranges, wrap over New Year allowed), validated on start and served in `/api/meta`.

## v1.2.0 — 2026-10-24

### Added
- Map view (Table / Map toggle) with an interactive **3D globe**: drag to spin, scroll or pinch to zoom, double-click or Recentre to fly back to Singapore. Far-side cities hide behind the horizon.
- Flat world map option (Pacific-centred); on phones it scrolls sideways and starts on Singapore.
- Every visible route drawn as a great-circle line from Singapore, via any stopover hub.
- Colour by miles per SGD (5-step blue scale) or by airline; dashed grey lines have no price yet.
- Hover or tap a route or city for a tooltip listing each airline/cabin with miles earned, fare and miles per SGD; on phones it docks under the map.
- Map follows the same filters as the table (airlines, cabin, region, priced only) and remembers the chosen view.

### Technical
- Map libraries vendored in `public/vendor/` (d3-geo, d3-array, topojson-client, world-atlas 110m), so the app still needs no install and works offline. Licences in `public/vendor/licenses/`.
- `/api/meta` now includes airport coordinates.

## v1.1.0 — 2026-10-24

### Added
- Star Alliance partners: Turkish Airlines, Lufthansa, SWISS, ANA, Air China, Air New Zealand, each with its KrisFlyer accrual table (chart dated 8 Aug 2025).
- Connecting itineraries: distance is summed per segment flown (e.g. SIN → IST → LHR).
- Airline filter chips and a "Booking class assumptions" panel (one selector per airline and cabin).
- Route-restricted classes (Air NZ L/S/G/K earn only on SIN–AKL); ineligible rows are flagged.
- Unpriced routes are listed with miles so you can type in a quote; "Priced only" filter.
- Live pricing now queries the row's own airline.
- Version shown in the page header, footer and `/api/meta`.

### Changed
- Data split into `data/airports.json`, `carriers.json`, `fares.*.json`, `sources.json`, validated on start.
- Price override keys now include the airline (`SQ:JFK:premium`); v1.0.0 browser edits migrate automatically.

## v1.0.0 — 2026-10-24
- Initial release: Singapore Airlines Economy and Premium Economy from Singapore, miles per SGD ranking, editable prices, optional SerpApi live pricing.
