# Price database

Every price the app finds is saved here as JSON lines (`prices-YYYY-MM.jsonl`, one file per month of searching):

- live searches (↻, SerpApi or fast-flights), including searches that found no fares (`"price": null`);
- Google Flights imports (the "Send to Miles Maximiser" bookmark), including every cell of a date grid.

Each line records the route and cabin, the **search range** you asked for (`range`: departure, return, ± flexibility), the **dates the price is for** (`outbound`, `inbound`), **when it was searched** (`searchedAt`), the price in SGD and the provider.

Files are only ever appended to: nothing is deleted, so earlier searches stay available as a price reference. On startup the app loads every `*.jsonl` file in this folder, so you can copy files here from another computer. The `.jsonl` files are gitignored (personal search history).

Prices more than 14 days old are shown as preliminary. A live search reuses a saved price less than 24 hours old for the same route, cabin and dates instead of searching again (`MILES_DB_REUSE_HOURS` changes this; `0` turns reuse off).
