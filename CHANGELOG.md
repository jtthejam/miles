# Changelog

## v1.22.0 — 2026-10-29

### Added
- **Thai Airways** (Star Alliance), 13 Economy rows: Bangkok nonstop, and via Bangkok to London, Paris, Frankfurt, Munich, Zurich, Milan, Amsterdam (resumed July 2026), Brussels, Copenhagen, Stockholm, Oslo and Istanbul. **No Premium Economy:** Thai's new Premium Economy cabin starts mid-2027.
  - KrisFlyer accrual: B/H/M/Q/U/Y 100%, K/T/S 50%. V and W aren't in the chart and earn nothing (shown as 0% in the class picker).
  - **Thai's cheapest fares earn no KrisFlyer miles.** Thai's fare families are Saver (W), Standard (V/S/K), Flexi (T/Q/H) and Full Flexi (M/B/Y), so advertised fares (Saver, W) show **0 miles**. Pick the class you'd actually book on the row: Standard S/K earn 50% (London: 6,831 mi, 4.16 mi/S$ at S$1,643), Flexi Q/H 100%. A Standard or Flexi fare costs more than the advertised price: update the price too.
  - "From" fares on Thai's Singapore route pages (seen 29 Oct 2026): Bangkok S$428, Paris S$1,548, Frankfurt S$1,628, London S$1,643, Amsterdam S$1,738. Other cities have no advertised fare.
  - Map colour: purple.

### Technical
- An accrual tier can have `"pct": 0` (classes that earn nothing), so a stated sale class like Thai's W can be modelled.

## v1.21.0 — 2026-10-29

### Added
- **EVA Air** (Star Alliance), 34 rows: Taipei nonstop, and via Taipei to Los Angeles, San Francisco, Seattle, New York (JFK), Chicago, Houston, Dallas/Fort Worth, Washington (Dulles), Vancouver, Toronto, London (Heathrow), Paris, Amsterdam, Vienna, Munich and Milan. Every route has Economy and Premium Economy.
  - KrisFlyer accrual (chart dated 8 Aug 2025): Premium Economy K/L 110%, P/T 100%; Economy B/M/Y 100%, H/Q/S 50%. **V and W earn nothing.**
  - Sale fares assumed **S** (Economy, 50%) and **T** (Premium Economy, 100%); EVA doesn't publish them. Its cheapest Economy Basic fares can book into V/W (0 miles): check the class before buying, and set it on the row.
  - Advertised fares from EVA's Singapore site (seen 29 Oct 2026), e.g. San Francisco S$1,326 Economy / S$2,268 Premium Economy, Toronto S$1,601 / S$2,389, Taipei S$465 / S$651. Europe and a few US cabins have no advertised fare yet: use ↻, G or click them on the map.
  - New airports: Vancouver (YVR), Toronto (YYZ). Map colour: brown.
  - Vienna: some EVA flights stop in Bangkok; those 2-stop itineraries aren't counted by live searches.

## v1.20.0 — 2026-10-29

### Added
- **Click the map to search missing prices.** With live prices on, clicking a dashed (unpriced) route searches its fares without a price, and clicking a city searches every unpriced fare to it. It works like ↻: your dates, flexibility and Max connection apply, prices saved in the last 24 h are reused, and results are saved to the price database. A status line under the map shows progress ("Searching Portland: 1 of 2…") and the result. The tooltip says "Click to search the 2 fares without a price". One map search runs at a time. Priced routes and cities just show details as before.

## v1.19.1 — 2026-10-29

### Fixed
- **fast-flights now searches as Singapore** (`gl=sg`, `hl=en`), like the G links. fast-flights only sent `hl=en-GB&curr=SGD`, and for some searches Google then left every fare out of the page. Example: Air China to London, 30 Apr – 9 May 2027, 8 h max connection: all four Beijing itineraries came back "Price unavailable" (so "no fares"). The same search with `gl=sg` returns S$1,714, matching Google Flights.

## v1.19.0 — 2026-10-29

### Added
- **"Max connection" filter** (next to Sort; **default 4 h**; Any, 4 h, 8 h, 12 h, 24 h; remembered). Leaves out itineraries whose longest connection (layover or stopover) is longer, e.g. Air China to London via Chengdu with a 19 h stopover.
  - **↻ and region search** (fast-flights and SerpApi) take the cheapest itinerary within the limit. Example (30 Apr – 9 May 2027): Air China London is S$1,707 via Beijing (1 h 5 min) at 4 h, S$1,423 via Chengdu at "Any".
  - **"No fares"** lists what was left out with its connection time, e.g. "Air China (SIN–TFU–LHR, 19 h 5 min connection, over your limit): S$1,423", and suggests raising the limit.
  - **G links** on connecting rows set Google's layover-duration filter to the same limit.
  - **Saved prices** now record the itinerary's longest connection, so changing the limit re-filters them without searching again. Prices saved before v1.19 have no connection time and still show.
  - **Rows show the connection time** of the price shown (red when over the limit).
  - **Bookmark imports** read connection times from Google's results and skip ones over the limit. Re-drag the bookmark to get this. The date grid can't show connection times; the import says so unless the page has Google's layover filter set (G links set it).
- Community prices can carry the connection time (`layoverMin`); the search's limit is not shared.

### Technical
- `scripts/ff_quote.py --max-layover MINUTES`: sent to Google as `max_layover_minutes` (tfs leg field 18) and checked per itinerary from segment times; prints `layoverMin`.
- Records: optional `layoverMin` (minutes; 0 = nonstop) and `maxLayover` (the search's limit). A saved price is reused only if its search was at least as wide and its itinerary fits.
- `maxLayover` query parameter on `/api/routes` and `/api/live`; `maxLayover`/`layoverMin` on `POST /api/db/records`.

## v1.18.1 — 2026-10-29

### Added
- **Region search: "Only rows without a price"** (checkbox next to the button). It searches only rows that show no price yet: none of yours, no saved or community search for these dates, and no advertised fare. The button shows the count (e.g. "↻ Search North Asia (6 unpriced rows)"), and the setting is remembered.

## v1.18.0 — 2026-10-29

### Added
- **Flexible-connection rows.** One-airline, one-stop rows for **Air China** (Beijing Capital, Beijing Daxing, Chengdu Tianfu, Chengdu Shuangliu, Shanghai Pudong), **ANA** (Haneda, Narita) and **SWISS** (Zurich, Geneva) now accept any of the airline's hubs (71 rows).
  - ↻, region search and the bookmark take the cheapest fare at any hub and record which hub it used. Miles follow that connection; the return is assumed to connect the same way.
  - The row shows the connection priced (e.g. "SIN → TFU → LHR **priced ⇄**"). Hover for the hubs. Before any price, "or ⇄" means the default hub is assumed.
  - Example (live, 30 Apr – 9 May 2027): Air China to London is cheapest via **Chengdu** (S$1,395–1,423, 7,191 miles at 50%), vs S$1,707 via Beijing (7,857 miles). Previously the row only accepted Beijing, so the cheapest fare showed as unavailable.
  - **Lufthansa stays fixed** to its checked hub: a different hub may be flown by Lufthansa City Airlines, which earns no KrisFlyer miles. Turkish has only Istanbul.
- **Bookmark imports read the connection** from Google's results ("Stopover … at Chengdu Tianfu International"). Results connecting elsewhere are skipped, on fixed rows too. Date-grid imports can't see the connection, so flexible rows assume the default hub and say so. Re-drag the bookmark to get this.
- **"Price unavailable" explained:** when Google lists itineraries without a price, "no fares" now says how many and suggests trying again or using **G**. Google often fills prices in later.

### Technical
- `data/carriers.json`: `hubs` per airline (`code` and `match`, how Google names the airport). Routes get `flexible` and `hubs`; `"fixed": true` opts a route out. New airports: PKX, TFU, CTU, GVA.
- Saved prices (`data/db`) and shared community prices keep `via`, the connection priced. Community files may include `via`; nothing personal.
- `scripts/ff_quote.py` VIA takes alternatives (`PEK/TFU/PVG`) and returns the `via` used. SerpApi does the same.
- 4 new tests.

## v1.17.0 — 2026-10-29

### Changed
- **Map colours (Miles per SGD)** are now a rainbow: red < 2, orange 2–4, yellow 4–6, green 6–8, blue 8–10, purple 10+ (on the 3D globe and the flat map; separate light and dark shades). Previously a 5-step blue scale from 4 to 10.
- **Filters are remembered** in this browser: region, cabin, sort, "priced only" and "round trip". They used to reset whenever the page reloaded, e.g. when a Google Flights import opened the app again.

### Fixed
- **Mixed-airline rows (e.g. Singapore Airlines → Zurich + SWISS → Bordeaux):**
  - Checked live (1–8 Dec 2026): Google Flights has no Singapore Airlines + SWISS itinerary for these dates, only SWISS all the way (S$1,451). So fast-flights correctly found no fare for the row.
  - **Date-grid imports were wrong for mixed rows.** The grid can't show who flies each flight, so it saved the SWISS-only price to the SQ + SWISS row, with the wrong miles. Date-grid imports are now refused for mixed rows, with a pointer to the results list, which shows each itinerary's airlines.
  - **"No fares" now says what Google does have**, for both fast-flights and SerpApi. For example: "Google Flights only has itineraries this row's miles don't apply to: SWISS (SIN–ZRH–BOD): S$1,451 — that's the SWISS row". Nonstop rows get the same treatment, e.g. only via-Narita itineraries.

### Technical
- `scripts/ff_quote.py` and `/api/live` return `others` (up to 3 cheapest itineraries that don't fit the row: price, airlines, routing).

## v1.16.1 — 2026-10-29

### Changed
- Region search with fast-flights explains its time estimate: about 2.5 s per search. That's ~1 s of deliberate pause between searches (pacing) plus ~1.5 s fetching and reading each Google Flights page. E.g. 159 searches ≈ 7 min.

## v1.16.0 — 2026-10-29

### Added
- **Search a whole region**: "↻ Search <region> (N rows)" under Live prices runs a live search for every row shown. The region filter, plus your airline, cabin and "priced only" filters, decide which rows. Each search uses your travel dates ± flexibility, and every result is saved to the price database.
  - Asks first, with the maximum number of searches (rows × dates). With SerpApi it shows the free plan's 250-a-month quota; with fast-flights, a rough time.
  - Progress ("Searching 3 of 20: Hong Kong · Singapore Airlines · Economy…"), a **Stop** button, and a summary (searched, priced, reused, failed; failures listed in the console). The table updates every 5 rows.
  - Prices saved in the last 24 hours are reused, so re-running a region costs only the missing dates.
- **All regions at once needs a SerpApi key.** Without one, pick a region. The server enforces this too (`/api/live?batch=all` returns 403 without a key).
- **fast-flights pacing**: fast-flights searches now run one at a time, with a random pause between searches: normal distribution, mean 1 s, standard deviation 0.25 s, never negative. This covers every fast-flights search: region runs, ↻ with ± days (previously 2 at once), and SerpApi fallbacks. `MILES_FF_DELAY_MEAN_MS` and `MILES_FF_DELAY_SD_MS` change it.

### Technical
- `lib/live.js`: fast-flights queue with Box–Muller Gaussian delay (`gaussian`, `ffDelay`).
- `public/app.js`: `searchRow()` shared by ↻ and region search.
- 3 new tests (delay distribution, one-at-a-time with pauses, all-regions rule).

## v1.15.4 — 2026-10-29

### Fixed
- **Failed fast-flights searches now log their URL and the real cause.** The helper prints the Google Flights URL *before* fetching, so it's known even if the fetch hangs or Python crashes. Failures now say which happened:
  - "fast-flights timed out after 45 s" (`MILES_FF_TIMEOUT_MS` changes the limit);
  - "fast-flights crashed: <last line of the Python error>";
  - or the helper's own message (e.g. Google returned a page without flight data).
  - The browser console also shows, per date searched, the error or "reused a price saved in the last 24 h (no search)".
- **"No fares found" results are no longer reused** for 24 hours: a ↻ searches those dates again. Only priced results are reused.

### Checked
- Live Google Flights page for SQ Singapore–New York (JFK), Premium Economy, 30 Apr – 9 May 2027 (from your laptop's browser): nonstop S$1,907 and via Frankfurt S$2,217 / S$3,964. It parses fine with fast-flights 3.1.0 and with the app's reader. So that failure happens before parsing; the new messages will show where.

## v1.15.3 — 2026-10-29

### Added
- **fast-flights request URLs are logged**, so you can open the exact Google Flights page fast-flights asked for and compare:
  - in the browser console after each ↻ (`fast-flights URLs for …`, one per date searched, also when the search fails);
  - in the server terminal (`[fast-flights] <dates> <airline> <dest>: <url>`, or `FAILED … — <reason>`).
- `scripts/ff_quote.py` output and `/api/live` responses include the URL (`url`; `byDate[].url`; `urls` on errors).

## v1.15.2 — 2026-10-29

### Fixed
- **Nonstop rows were priced with connecting itineraries** in ↻ searches. Checked against the live Google Flights page for SQ Singapore–Los Angeles (2–9 May 2027): Singapore Airlines also sells SIN–NRT–LAX, and that S$1,012 itinerary priced the nonstop row, whose miles assume the nonstop distance. The nonstop fare was S$1,020.
  - fast-flights: only itineraries with the row's exact routing count; for nonstop rows, nonstop only.
  - SerpApi: nonstop rows search nonstop only (`stops=1`) and keep only offers without layovers. Google's overall `price_insights` lowest, which covers any routing, is no longer used.
  - Bookmark imports already did this (since v1.11.0).

### Checked
- The live Google Flights page (via your laptop's browser) still has the data layout fast-flights reads. So the v1.15.1 `IndexError` comes from the different page Google serves fast-flights' own HTTP client. v1.15.1's tolerant reading skips such results, and saves pages without data to `.local/ff-debug/`.

## v1.15.1 — 2026-10-29

### Fixed
- **fast-flights: "IndexError: list index out of range"** (↻ returned 502). fast-flights 3.1.0's parser gives up on the whole Google Flights page if any one result has an unexpected shape, e.g. a result without a price, a missing "other flights" list, or no airline metadata block. Reproduced on test pages: 3.1.0 fails with exactly this error.
  - `scripts/ff_quote.py` now fetches the page with fast-flights but reads the results itself, one at a time. Unreadable results are skipped and counted (`skipped` in the output) instead of failing the search.
  - It also reads Google's "best flights" list, which fast-flights 3.1.0 ignored, so cheaper top results are no longer missed.
  - If Google returns a page with no flight data at all (consent or verification page, or a format change), the error says so and suggests **G**. The page is saved to `.local/ff-debug/` (last 5 kept) for diagnosis.

## v1.15.0 — 2026-10-27

### Added
- **Community prices**: anonymised prices shared by other users through the **private** data repo [`jtthejam/miles-prices`](https://github.com/jtthejam/miles-prices), cloned into `data/community/`.
  - On startup the app pulls the repo (fast-forward only; `MILES_COMMUNITY_PULL=0` skips) and loads every shared file.
  - Rows use community prices after your own: **your price → your latest search → community → advertised**. They're labelled "community · dates · age", and the tooltip says how many shared files agree (within 10%).
  - Prices backed by one report are flagged "check it". Prices under half or over 3× the typical shared price for a route are ignored, once there are 3+ to compare. Community prices over 14 days old are preliminary.
  - Your own shared files never count as community reports.
- **Automatic anonymised sharing**: on startup and every 6 hours, saved prices at least 2 days old are written to a new file in `data/community/` (`MILES_AUTO_SHARE=0` turns this off).
  - Each shared line keeps only route, cabin, dates priced, price (SGD), provider and the **day** searched. Search ranges, times and ids are removed.
  - Each route, cabin, date pair and day is merged to one price, and lines are shuffled.
  - A ledger in `data/db/` (gitignored) means nothing is shared twice, even while a pull request is open.
- **Send with one command**: `node scripts/share_prices.js --pr` checks the new share files, commits only those on a branch in `data/community/`, pushes it, opens the pull request (GitHub CLI) and switches back to `main`.
- **Sharing panel** under Live prices: what's shared, files waiting to be sent, how to join if `data/community/` isn't a clone yet, and "Create share file now" (choose a minimum age).
- **Checks on every pull request in miles-prices**: a GitHub Actions workflow runs this app's community test against the repo's files. Any line with extra fields (anything that could identify you), bad dates or prices, or an unknown route fails.

### Changed
- `data/community/` is gitignored in this repo (it's a clone of the private data repo).

### API
- `POST /api/db/share` `{"minAgeDays": 2}` (this computer only): write a share file now.
- `GET /api/db/searches` adds `community` (loaded shared prices) and `autoShare` (on/off, clone status, files waiting to be committed).
- `GET /api/routes` rows add `community` and `priceFrom: "community"`.

### Technical
- `lib/db.js`: `anonymise`, `share`, `communityForRange`, `communityProblem` (strict validation). `lib/community-repo.js`: pull and status of the clone.
- 8 new tests. `MILES_COMMUNITY_CHECK_DIR` points the validation test at any folder (used by the data repo's check).

## v1.14.0 — 2026-10-27

### Added
- **Price database** in `data/db/`: every price the app finds is saved as JSON lines (`prices-YYYY-MM.jsonl`). This covers ↻ searches (SerpApi or fast-flights, including searches that found no fares) and Google Flights imports (every cell of a date grid, even outside your dates).
  - Each record is tagged with the **search range** you asked for (departure, return, ± flexibility), the **dates the price is for**, and **when it was searched**.
  - **Nothing is ever deleted.** Files are append-only, so earlier searches stay available as a price reference.
  - **On startup the app loads every `.jsonl` file in `data/db/`**, so you can copy files over from another computer. The server log says how many prices it loaded.
- **Saved prices in the table**: each row shows the current price from saved searches for your date range: the newest price for each date pair, then the cheapest of those.
  - Under the price: its dates and age ("1 Dec – 8 Dec · 2 days ago").
  - Hover the price for **every earlier search** of that route in the range, with the lowest seen.
  - Your own typed price still wins; advertised fares show when there's no saved search.
- **Preliminary prices**: searches more than 14 days old are flagged "Preliminary price: searched N days ago". Newer searches are preferred when both exist.
- **Saved searches** picker under Live prices: lists every date range you've searched (newest first, with search date, number of routes, and "preliminary" when old). Choosing one loads its dates and saved prices. Past ranges stay viewable.
- On startup with no dates set, the app opens your **most recent saved search**.
- **Fewer searches**: a ↻ reuses a saved price less than 24 hours old for the same route, cabin and dates instead of searching again (`MILES_DB_REUSE_HOURS` changes this; `0` turns it off). With ± flexibility, only the date pairs without a recent price are searched.

### Changed
- ↻ and Google Flights results are no longer stored in the browser; they go to the database. Older browser-stored live prices are replaced the next time you search that row.
- `data/db/*.jsonl` is gitignored (personal search history); `data/db/README.md` explains the format.

### API
- `GET /api/routes` takes `outbound`, `inbound`, `flex` and returns saved prices for that range (`priceFrom`: yours / search / advertised, and `search`: latest, lowest, history).
- `GET /api/db/searches`: saved search ranges.
- `POST /api/db/records`: save Google Flights import prices. Route details come from the data, not the request.
- `GET /api/live` responses add `reused` (date pairs answered from the database) and `searchId`.

### Technical
- `lib/db.js`: load, append, range query, reuse, saved-search list. No dependencies, plain JSONL.
- 10 new tests. The test suite uses its own temporary database folder.

## v1.13.0 — 2026-10-26

### Added
- **69 cities**: the 3 main cities in the UK, Germany, France, Italy and Spain, the capitals of the other European countries with scheduled service, and 21 US airports (the top 20 cities; New York has JFK and Newark).
  - Not included: Bern (no scheduled flights; Zurich is in the table), Kyiv, Minsk and Moscow (no Star Alliance service), and microstates without an airport.
- **United** (KrisFlyer chart: B/E/H/M/U/Y 100%, Q/V/W 75%, L/S/T 50%, G/K 25%, Basic Economy N 10%; Premium Plus O/A/R 100%). Sale fares assumed G (25%), Premium Plus O.
- **290 new routes, each segment checked against current schedules** (research in `data/research/2026-10-26/`):

  | Route | Count |
  |---|---|
  | Turkish via Istanbul | 51 |
  | SWISS via Zurich | 43 |
  | Singapore Airlines + SWISS via Zurich | 43 |
  | Lufthansa via Munich/Frankfurt (mainline only) | 43 |
  | Singapore Airlines + Lufthansa via Munich/Frankfurt | 44 |
  | Air China via Beijing (incl. Zagreb via Bucharest, Reykjavik via Copenhagen) | 21 |
  | United via San Francisco (and nonstop SIN–SFO) | 20 |
  | ANA via Tokyo | 7 |
  | **ANA + United via Tokyo** (ANA to Tokyo, United onward; shortest United path, e.g. SIN–HND–ORD–ATL) | 13 |
  | Air New Zealand via Auckland | 5 |

- New routes are unpriced: price them with **G**, ↻ or your own quote.

### Corrections
- **Singapore Airlines New York nonstop** (A350-900ULR) has no Economy cabin. The nonstop row is now Premium Economy only, and Economy (S$1,447) moved to a new **Singapore Airlines via Frankfurt** row (`SQ:JFK@FRA`). If you saved your own Economy price on the old row, re-enter it on the Frankfurt row.
- **Singapore Airlines Madrid** now flies via Barcelona (from 26 Oct 2026). Miles use both segments; the price is unchanged.
- **Singapore Airlines Newark** added (nonstop, Premium Economy only).
- When only part of a trip earns, the flag names the segment. For example, Air New Zealand's sale class K earns only on Singapore–Auckland: "AKL–LAX: Class K earns only to AKL".

### Left out on purpose
- **11 Lufthansa cities** where Munich/Frankfurt flights are partly or fully run by Lufthansa City Airlines (no KrisFlyer miles) or Air Dolomiti: London, Manchester, Birmingham, Berlin, Lyon, Milan, Valencia, Amsterdam, Luxembourg, Helsinki, Bucharest. These cities still have Turkish, SWISS and other options.
- **United price and sales**: no Singapore-origin United fare or Singapore-market sale was found (only US-origin deals in USD). Both are recorded as notes rather than guessed.

### Caveats
- Turkish routes rest mainly on Wikipedia's destination list, which doesn't separate Istanbul Airport from Sabiha Gökçen (AJet). Smaller cities (e.g. Marseille, Valencia, Naples, Luxembourg, the Baltic capitals) are worth a check with **G**, which searches Turkish via Istanbul only.
- Premium Economy rows exist only where every segment has it confirmed: SWISS to LAX/SFO/BOS/ORD, Air NZ to the US, United nonstop to SFO and Lufthansa's US routes. Other routes are Economy only.

### Technical
- `data/fares.network.json` is generated by `scripts/build_network.py` from the research files (rules are in the script header). Re-run it after updating research.
- Map: 8th colour slot (red) for United, validated with the palette checker in light and dark.
- Table: flags wrap, so new routes keep the table inside its box.

## v1.12.0 — 2026-10-26

### Added
- **Mixed-airline routes**: one ticket flown by more than one airline, e.g. Singapore Airlines to Zurich, then SWISS to Bordeaux. KrisFlyer credits each segment by the airline that flies it, so:
  - Miles = each segment's distance × that airline's % for its booking class (sale-fare class by default).
  - The Earn column shows the effective % over the trip, plus **one class picker per airline**. Change SWISS's class and only the Zurich–Bordeaux segment changes.
  - The route line shows who flies each segment: SIN → ZRH `SQ` → BOD `LX`.
  - Segments that earn nothing (e.g. a class with no KrisFlyer accrual) are flagged "Partly earns".
- First mixed route: **Singapore Airlines + SWISS to Bordeaux via Zurich** (Economy; 6,882 mi, 50% + 50% by default).
- Airline chips: a mixed row shows when **all** its airlines are selected.

### Prices for mixed routes
- **G links** filter Google Flights to the route's airlines (e.g. Singapore Airlines + SWISS) with the route's number of stops.
- **SerpApi** searches with every airline on the route and keeps only offers whose segments are flown in order by the route's airlines (from flight numbers), via the route's connection.
- **fast-flights** keeps only itineraries via the route's connection that use exactly the route's airlines. A SWISS-only itinerary doesn't price the SQ + SWISS row.
- **Bookmark imports** find the route from the page's airline filter. Results must use exactly the route's airlines, so "Singapore Airlines and Austrian" no longer counts as a Singapore Airlines result. Date-grid imports for mixed routes remind you to check who flies each flight.

### Changed
- `/api/live` accepts `route=<id>` (e.g. `SQ+LX:BOD`); `carrier` + `dest` still work for single-airline routes.
- Table: mixed rows list airlines on separate lines, long routes wrap, and the Miles/SGD bar column is narrower, so the table keeps fitting its box.

### Data format
- Single airline (unchanged): `{"carrier": "TK", "to": "BOD", "via": ["IST"]}`.
- Mixed: `{"to": "BOD", "segments": [{"carrier": "SQ", "to": "ZRH"}, {"carrier": "LX", "to": "BOD"}]}`. A segment may set `"class": {"economy": "V"}`.
- Route ids: `TK:BOD` (single airline, the same as before, so saved prices keep working) or `SQ+LX:BOD`. Give a route an `"id"` if two would clash, e.g. the same airline to the same city via different hubs.
- Every existing row is unchanged: same miles, classes and prices (checked row by row against v1.11.0).

### Technical
- `data/index.js` normalises routes to segments (`segments`, `carriers`, `via`, `mixed`, `routeId`) and validates them.
- `lib/calc.js` computes accrual per segment. Rows add `routeId`, `carriers`, `mixed`, `segments`, `classes`, `partlyEligible`.
- `scripts/ff_quote.py`: CARRIERS may be a comma list, plus an optional 8th argument AIRLINE_NAMES.
- 7 new tests.

## v1.11.0 — 2026-10-26

### Added
- **Bordeaux (BOD)** on single-airline connections:
  - Turkish Airlines via Istanbul, Economy (6,891 mi; sale class V earns 25%).
  - SWISS via Zurich, Economy only (6,882 mi; 50%). Zurich–Bordeaux is short-haul, with no Premium Economy.
  - No advertised fares yet, so both show "add": price them with **G**, ↻ or your own quote.
- Routes can list the cabins they're sold in (`"cabins": ["economy"]` in `data/fares.*.json`).

### Changed
- **Searches now stick to the route's connection.** A row's miles assume its connection (e.g. SIN–IST–BOD), so:
  - **G links** limit Google Flights to that many stops on that airline. For these routes, that leaves only the intended hub.
  - **SerpApi** limits stops and keeps only offers whose layovers match the route. Its `price_insights` lowest price, which covers every connection, is no longer used for connecting rows.
  - **fast-flights** limits stops and keeps only itineraries that fly the route's airports.
  - **Bookmark imports** from the results list keep only results with the route's number of stops: none for nonstop rows, one for one-stop rows. If you turn off Google's stops filter, the app says so.
- Nonstop rows ignore connecting results in imports, since those earn different miles. For example, an SQ + Austrian two-stop itinerary no longer prices the SQ London nonstop row.

### Not included
- **Lufthansa to Bordeaux via Munich**: Munich–Bordeaux is flown at least partly by Lufthansa City Airlines, which earns no KrisFlyer miles. That needs per-segment earning, planned for v1.12.0 (mixed airlines).

### Technical
- `/api/live` takes the connection from the route data. The response includes `via`, and `otherConnections` (SerpApi offers dropped for a different connection).
- `scripts/ff_quote.py` takes an optional 7th argument, VIA.
- `GFLink.encodeTfs({ maxStops })` encodes byte-identically to fast-flights `max_stops`; `decodeTfs` returns `maxStops` per leg.
- The bookmarklet now also sends each result's number of stops. Bookmarks dragged before v1.11.0 still work but skip the stops check, so drag it again.
- Data validation: route cabins must exist for the airline; connections can't be Singapore or the destination.
- 6 new tests.

## v1.10.1 — 2026-10-26

### Fixed
- Travel dates and flexibility can now be set without a SerpApi key or fast-flights. Previously they were hidden whenever ↻ was off, but **G** links and Google Flights imports use them too.
- The hint under the dates now describes whichever price sources are available: ↻ (when on) and **G**, including how flexibility applies to each. ↻ shifts departure and return together; the date grid lets each move within ± flexibility.
- With ↻ off, the status line points to **G**, and the "Free prices from Google Flights" steps open by default.

## v1.10.0 — 2026-10-25

### Added
- **Google Flights links**: a **G** button on every row opens Google Flights already filtered to that airline, cabin, SGD and your travel dates (or ~60 days out for 7 nights).
- **"Send to Miles Maximiser" bookmarklet** (Live prices → "Free prices from Google Flights"): drag it to your bookmarks bar once. On a Google Flights page, click it and the app saves the cheapest price to the matching row, with its dates. Free, no SerpApi key, no searches used.
  - With **Date grid** open it reads all 49 departure × return cells and keeps the cheapest within your dates ± flexibility. Here departure and return vary independently, since the grid prices every pair.
  - Without the grid it uses the results list for the page's dates.
  - The route, airline and cabin come from the Google Flights page address, so prices go to the right row even if you change dates on Google.
- Lufthansa results that include **Lufthansa City Airlines** flights are skipped: they earn no KrisFlyer miles (KrisFlyer chart note 7). For the date grid, which can't show the operator, the app adds a reminder.

### Safeguards
- Refuses pages without a one-airline filter (prices could be on any airline), non-SGD prices, one-way or multi-city searches, departures not from Singapore, and airlines not in the app. Each case explains what to change.
- The bookmarklet only reads price labels and the page address, and opens this app with them. It sends nothing anywhere else.

### Changed
- Price box is narrower (68px) so the table still fits its box with the new button.

### Why not call the date grid from the server?
Tested 2026-10-25: Google's date-grid request (`GetCalendarGrid`) now carries a per-request BotGuard token (`x-goog-batchexecute-bgr`). Without it, or with a token from a different request, Google rejects it (status 13). Only a real browser session produces a valid token, so the grid is read from the page you're viewing instead.

### Technical
- `public/gflink.js` (browser + Node): `tfs` protobuf encoder (byte-identical to fast-flights 3.1.0), tolerant decoder (handles Google's rewritten URLs: url-safe base64, extra fields, unpacked passengers), import interpretation.
- `public/bookmarklet.js`: bookmarklet source; the app inlines its own address. Google writes a non-breaking space after "SGD", and the date grid is drawn on a canvas with zero-size labelled cells; both are handled.
- 9 new tests, including a real 49-cell date grid captured from Google Flights (`test/fixtures/gf-grid-lh-sin-lhr.json`).

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
