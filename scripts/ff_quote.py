#!/usr/bin/env python3
"""Live fare lookup via fast-flights (unofficial Google Flights scraper). Used when no SerpApi key is set.

Usage: ff_quote.py DEST CABIN OUTBOUND INBOUND CARRIER [VIA]
  CABIN: economy | premium      dates: YYYY-MM-DD      CARRIER: 2-letter IATA code
  VIA: connection airports, comma-separated (e.g. IST), or "-" / omitted for any. With VIA, only
       itineraries that connect exactly there count (the row's miles assume that connection).
Prints one JSON object: {"lowest": int|null, "average": int|null, "offers": int} or {"error": "..."}.
Exit code 0 on success (including "no flights"), 1 on error.

fast-flights reverse-engineers Google's page format and may break without notice.
"""
import json
import re
import sys

SEAT = {"economy": "economy", "premium": "premium-economy"}


def main(argv):
    if len(argv) not in (6, 7):
        return fail("usage: ff_quote.py DEST CABIN OUTBOUND INBOUND CARRIER [VIA]")
    _, dest, cabin, outbound, inbound, carrier = argv[:6]
    via = [] if len(argv) == 6 or argv[6] in ("", "-") else argv[6].split(",")
    if len(via) > 2 or not all(re.fullmatch(r"[A-Z]{3}", v) for v in via):
        return fail("via must be up to 2 IATA codes")
    if not re.fullmatch(r"[A-Z]{3}", dest):
        return fail("dest must be an IATA code")
    if cabin not in SEAT:
        return fail("cabin must be economy or premium")
    if not all(re.fullmatch(r"\d{4}-\d{2}-\d{2}", d) for d in (outbound, inbound)):
        return fail("dates must be YYYY-MM-DD")
    if not re.fullmatch(r"[A-Z0-9]{2}", carrier):
        return fail("carrier must be a 2-letter airline code")

    try:
        from fast_flights import FlightQuery, FlightsNotFound, Passengers, create_query, get_flights
    except ImportError:
        return fail("fast-flights not installed (pip install fast-flights)")

    query = create_query(
        flights=[
            FlightQuery(date=outbound, from_airport="SIN", to_airport=dest, airlines=[carrier],
                        max_stops=len(via) if via else None),
            FlightQuery(date=inbound, from_airport=dest, to_airport="SIN", airlines=[carrier],
                        max_stops=len(via) if via else None),
        ],
        seat=SEAT[cabin],
        trip="round-trip",
        passengers=Passengers(adults=1),
        language="en-GB",
        currency="SGD",
    )
    try:
        results = get_flights(query)
    except FlightsNotFound:
        return ok([])
    except Exception as e:  # network errors, Google format changes, blocks
        return fail(f"fast-flights failed: {type(e).__name__}: {e}"[:300])

    # The query already restricts results to the requested airline (accrual depends on the operator).
    if via:
        results = [f for f in results if connects(f, ["SIN", *via, dest])]
    prices = [f.price for f in results if isinstance(getattr(f, "price", None), int) and f.price > 0]
    return ok(prices)


def connects(result, path):
    """True if the itinerary flies exactly SIN -> via... -> dest on the way out.

    Checks the start of the segment list, so it works whether or not return segments are included.
    """
    segs = getattr(result, "flights", None) or []
    if not segs:
        return False
    try:
        flown = [segs[0].from_airport.code] + [s.to_airport.code for s in segs]
    except AttributeError:
        return False
    return flown[: len(path)] == path


def ok(prices):
    out = {
        "lowest": min(prices) if prices else None,
        "average": round(sum(prices) / len(prices)) if prices else None,
        "offers": len(prices),
    }
    print(json.dumps(out))
    return 0


def fail(msg):
    print(json.dumps({"error": msg}))
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
