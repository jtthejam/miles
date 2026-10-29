#!/usr/bin/env python3
"""Live fare lookup via fast-flights (unofficial Google Flights scraper). Used when no SerpApi key is set.

Usage: ff_quote.py [--max-layover MINUTES] DEST CABIN OUTBOUND INBOUND CARRIERS [VIA [AIRLINE_NAMES]]
  --max-layover: longest connection allowed (minutes; 0 or omitted = any). Also sent to Google.
  CABIN: economy | premium      dates: YYYY-MM-DD
  CARRIERS: 2-letter IATA code(s), comma-separated for mixed-airline routes (e.g. SQ,LX)
  VIA: connection airports, comma-separated (e.g. IST), or "-" / omitted for nonstop. Only
       itineraries with exactly that routing count (the row's miles assume it).
  AIRLINE_NAMES: mixed routes only, "|"-separated (e.g. "Singapore Airlines|SWISS"). Only itineraries
       using exactly these airlines count, so a SWISS-only itinerary doesn't price an SQ + SWISS row.
Prints a first line {"url": "..."} (the Google Flights URL requested), then one JSON object:
{"lowest": int|null, "average": int|null, "offers": int, "skipped": int, "url": "..."} or {"error": "...", "url": "..."}.
Exit code 0 on success (including "no flights"), 1 on error.

fast-flights reverse-engineers Google's page format and may break without notice. Its own parser
(3.1.0) abandons the whole page if any one result has an unexpected shape (e.g. a result without a
price), so this script fetches the page with fast-flights and reads the results itself, one at a
time: unreadable results are skipped and counted ("skipped" in the output). If Google returns a page
without flight data (consent or verification page, or a format change), the page is saved to
.local/ff-debug/ for diagnosis.
"""
import json
import os
import re
import sys
import time
from pathlib import Path

SEAT = {"economy": "economy", "premium": "premium-economy"}


def main(argv):
    max_layover = None
    if len(argv) > 2 and argv[1] == "--max-layover":
        try:
            max_layover = int(argv[2]) or None
        except ValueError:
            return fail("--max-layover must be minutes")
        argv = [argv[0], *argv[3:]]
    if len(argv) not in (6, 7, 8):
        return fail("usage: ff_quote.py DEST CABIN OUTBOUND INBOUND CARRIERS [VIA [AIRLINE_NAMES]]")
    _, dest, cabin, outbound, inbound, carrier_arg = argv[:6]
    carriers = carrier_arg.split(",")
    # VIA alternatives separated by "/" (flexible rows: any of the airline's hubs), stops by ","
    via_options = [[]] if len(argv) == 6 or argv[6] in ("", "-") else [v.split(",") for v in argv[6].split("/")]
    via = via_options[0]
    names = argv[7].split("|") if len(argv) == 8 and argv[7] else []
    if any(len(v) > 2 or len(v) != len(via) or not all(re.fullmatch(r"[A-Z]{3}", x) for x in v) for v in via_options):
        return fail("via must be up to 2 IATA codes (alternatives with the same number of stops)")
    if not re.fullmatch(r"[A-Z]{3}", dest):
        return fail("dest must be an IATA code")
    if cabin not in SEAT:
        return fail("cabin must be economy or premium")
    if not all(re.fullmatch(r"\d{4}-\d{2}-\d{2}", d) for d in (outbound, inbound)):
        return fail("dates must be YYYY-MM-DD")
    if not all(re.fullmatch(r"[A-Z0-9]{2}", c) for c in carriers):
        return fail("carrier must be a 2-letter airline code")

    try:
        from fast_flights import FlightQuery, Passengers, create_query, fetch_flights_html
    except ImportError:
        return fail("fast-flights not installed (pip install fast-flights)")

    query = create_query(
        flights=[
            FlightQuery(date=outbound, from_airport="SIN", to_airport=dest, airlines=carriers,
                        max_stops=len(via) if via else None,
                        max_layover_minutes=max_layover if via else None),
            FlightQuery(date=inbound, from_airport=dest, to_airport="SIN", airlines=carriers,
                        max_stops=len(via) if via else None,
                        max_layover_minutes=max_layover if via else None),
        ],
        seat=SEAT[cabin],
        trip="round-trip",
        passengers=Passengers(adults=1),
        language="en-GB",
        currency="SGD",
    )
    # The exact URL fast-flights requests (its fetcher: URL + query.params()), reported in the output
    # so it can be opened in a browser to compare with what fast-flights receives.
    global REQUEST_URL
    try:
        from fast_flights.fetcher import URL as FF_URL
        from urllib.parse import urlencode
        REQUEST_URL = f"{FF_URL}?{urlencode(query.params())}"
    except Exception:
        REQUEST_URL = None
    # Printed first, so the URL is known even if the fetch hangs or Python crashes.
    print(json.dumps({"url": REQUEST_URL}), flush=True)
    try:
        html = fetch_flights_html(query)
    except Exception as e:  # network errors, blocks
        return fail(f"fast-flights couldn't reach Google Flights: {type(e).__name__}: {e}"[:300])

    try:
        results, skipped = read_results(html)
    except NoFlightData as e:
        saved = save_debug(html)
        return fail(f"Google Flights returned a page without flight data ({e}). "
                    f"Use G on the row instead{f'; page saved to {saved}' if saved else ''}."[:400])
    if results is None:  # Google reported no flights for this search
        return ok([], 0)

    # The query already restricts results to the requested airline (accrual depends on the operator).
    # The row's miles assume its exact routing: nonstop rows only count nonstop itineraries (e.g. SQ
    # Los Angeles also sells SIN-NRT-LAX), connecting rows only their connection.
    want = {n.lower() for n in names}
    def fits(r):
        return (any(r["path"][: len(v) + 2] == ["SIN", *v, dest] for v in via_options)
                and (not names or {a.lower() for a in r["airlines"]} == want)
                and (max_layover is None or r["layover"] is None or r["layover"] <= max_layover))
    others = sorted((r for r in results if not fits(r)), key=lambda r: r["price"])
    results = [r for r in results if fits(r)]
    # Itineraries Google has that don't fit this row (e.g. SWISS-only for an SQ + SWISS row), so a
    # "no fares" result can say what Google does have.
    cheapest = min(results, key=lambda r: r["price"]) if results else None
    used_via = cheapest["path"][1:cheapest["path"].index(dest)] if cheapest and dest in cheapest["path"] else None
    return ok([r["price"] for r in results], skipped, others[:3], used_via, cheapest["layover"] if cheapest else None)


class NoFlightData(Exception):
    pass


def dig(obj, *path):
    """obj[a][b]... or None if any step is missing (Google's arrays have optional tails)."""
    for k in path:
        try:
            obj = obj[k]
        except (IndexError, KeyError, TypeError):
            return None
    return obj


def read_results(html):
    """Results from Google Flights' embedded data block (script.ds:1), one at a time.

    Returns (results, skipped) where each result is {"price", "airlines", "path"}, or (None, 0) when
    Google says there are no flights. Raises NoFlightData if the page has no readable data block.
    """
    from selectolax.lexbor import LexborHTMLParser  # installed with fast-flights

    script = LexborHTMLParser(html).css_first(r"script.ds\:1")
    if script is None:
        raise NoFlightData("no results data on the page")
    js = script.text()
    if "data:" not in js:
        raise NoFlightData("results data has an unexpected format")
    data = js.split("data:", 1)[1].rsplit(",", 1)[0]
    if data.endswith("errorHasStatus: true"):
        return None, 0
    try:
        payload = json.loads(data)
    except ValueError:
        raise NoFlightData("results data isn't valid JSON")

    results, skipped = [], 0
    # payload[2]: "best" flights, payload[3]: other flights (fast-flights 3.1.0 only reads [3]).
    for block in (dig(payload, 2, 0), dig(payload, 3, 0)):
        for k in block if isinstance(block, list) else []:
            price = dig(k, 1, 0, 1)
            airlines = dig(k, 0, 1)
            segs = dig(k, 0, 2)
            if not (isinstance(price, int) and price > 0 and isinstance(segs, list) and segs):
                skipped += 1  # e.g. a result without a price
                continue
            path = [dig(segs, 0, 3)] + [dig(s, 6) for s in segs]
            if not all(isinstance(c, str) for c in path):
                skipped += 1
                continue
            results.append({"price": price, "path": path, "layover": longest_connection(segs),
                            "airlines": [a for a in airlines if isinstance(a, str)] if isinstance(airlines, list) else []})
    return results, skipped


def longest_connection(segs):
    """Longest connection in minutes on the way out (0 = nonstop, None = unknown).

    Each segment has local departure/arrival date ([y, m, d], index 20/21) and time ([h, m], 8/10);
    a connection is next departure - previous arrival, both local at the connecting airport.
    """
    from datetime import datetime
    def at(d, hm):
        if not (isinstance(d, list) and len(d) == 3):
            raise ValueError
        h = (hm or [None, None]) + [None, None]
        return datetime(d[0], d[1], d[2], h[0] or 0, h[1] or 0)
    try:
        gaps = [(at(dig(b, 20), dig(b, 8)) - at(dig(a, 21), dig(a, 10))).total_seconds() / 60 for a, b in zip(segs, segs[1:])]
    except (ValueError, TypeError):
        return None
    return int(max(gaps)) if gaps else 0


def save_debug(html):
    """Keep the page (last 5) so a format change can be diagnosed. Returns the path or None."""
    try:
        d = Path(__file__).resolve().parent.parent / ".local" / "ff-debug"
        d.mkdir(parents=True, exist_ok=True)
        f = d / f"page-{time.strftime('%Y%m%d-%H%M%S')}.html"
        f.write_text(html, encoding="utf-8")
        for old in sorted(d.glob("page-*.html"))[:-5]:
            old.unlink()
        return os.path.relpath(f, Path(__file__).resolve().parent.parent)
    except OSError:
        return None


REQUEST_URL = None


def ok(prices, skipped=0, others=(), via=None, layover=None):
    out = {
        "lowest": min(prices) if prices else None,
        "average": round(sum(prices) / len(prices)) if prices else None,
        "offers": len(prices),
        "skipped": skipped,
        "via": via,
        "layoverMin": layover,  # longest connection of the cheapest itinerary (0 = nonstop)
        "others": [{"price": r["price"], "airlines": r["airlines"], "path": r["path"][:4], "layoverMin": r["layover"]} for r in others],
        "url": REQUEST_URL,
    }
    print(json.dumps(out))
    return 0


def fail(msg):
    print(json.dumps({"error": msg, "url": REQUEST_URL}))
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
