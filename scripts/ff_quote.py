#!/usr/bin/env python3
"""Live fare lookup via fast-flights (unofficial Google Flights scraper). Used when no SerpApi key is set.

Usage: ff_quote.py DEST CABIN OUTBOUND INBOUND CARRIERS [VIA [AIRLINE_NAMES]]
  CABIN: economy | premium      dates: YYYY-MM-DD
  CARRIERS: 2-letter IATA code(s), comma-separated for mixed-airline routes (e.g. SQ,LX)
  VIA: connection airports, comma-separated (e.g. IST), or "-" / omitted for nonstop. Only
       itineraries with exactly that routing count (the row's miles assume it).
  AIRLINE_NAMES: mixed routes only, "|"-separated (e.g. "Singapore Airlines|SWISS"). Only itineraries
       using exactly these airlines count, so a SWISS-only itinerary doesn't price an SQ + SWISS row.
Prints one JSON object: {"lowest": int|null, "average": int|null, "offers": int} or {"error": "..."}.
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
    if len(argv) not in (6, 7, 8):
        return fail("usage: ff_quote.py DEST CABIN OUTBOUND INBOUND CARRIERS [VIA [AIRLINE_NAMES]]")
    _, dest, cabin, outbound, inbound, carrier_arg = argv[:6]
    carriers = carrier_arg.split(",")
    via = [] if len(argv) == 6 or argv[6] in ("", "-") else argv[6].split(",")
    names = argv[7].split("|") if len(argv) == 8 and argv[7] else []
    if len(via) > 2 or not all(re.fullmatch(r"[A-Z]{3}", v) for v in via):
        return fail("via must be up to 2 IATA codes")
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
                        max_stops=len(via) if via else None),
            FlightQuery(date=inbound, from_airport=dest, to_airport="SIN", airlines=carriers,
                        max_stops=len(via) if via else None),
        ],
        seat=SEAT[cabin],
        trip="round-trip",
        passengers=Passengers(adults=1),
        language="en-GB",
        currency="SGD",
    )
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
    results = [r for r in results if r["path"][: len(via) + 2] == ["SIN", *via, dest]]
    if names:
        want = {n.lower() for n in names}
        results = [r for r in results if {a.lower() for a in r["airlines"]} == want]
    return ok([r["price"] for r in results], skipped)


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
            results.append({"price": price, "path": path,
                            "airlines": [a for a in airlines if isinstance(a, str)] if isinstance(airlines, list) else []})
    return results, skipped


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


def ok(prices, skipped=0):
    out = {
        "lowest": min(prices) if prices else None,
        "average": round(sum(prices) / len(prices)) if prices else None,
        "offers": len(prices),
        "skipped": skipped,
    }
    print(json.dumps(out))
    return 0


def fail(msg):
    print(json.dumps({"error": msg}))
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
