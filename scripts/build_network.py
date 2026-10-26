#!/usr/bin/env python3
"""Build data/fares.network.json from verified route research (data/research/<date>/*.json).

Run: python3 scripts/build_network.py data/research/2026-10-26
Routes are unpriced (price them in the app with G, the refresh button or your own quote).

Rules (one route per airline combination per city, only where every segment was verified):
  Europe + USA, any target city:
    TK      SIN-IST-city               Turkish serves city from Istanbul Airport
    LX      SIN-ZRH-city               SWISS serves city from Zurich
    SQ+LX   SIN-ZRH (SQ), ZRH-city (LX) same, Singapore Airlines to Zurich
    LH      SIN-MUC|FRA-city            Lufthansa mainline only (City Airlines earns no KrisFlyer miles,
            SQ+LH same hub                Air Dolomiti / mixed operators skipped); Munich preferred
    CA      SIN-PEK-city               Air China from Beijing Capital (incl. same-flight stops, e.g. PEK-OTP-ZAG)
  USA only:
    UA      SIN-SFO[-city]             United to San Francisco, then United nonstop
    NH      SIN-HND|NRT-city           ANA nonstop from Tokyo (Haneda preferred)
    NH+UA   SIN-HND|NRT (NH), Tokyo-hub[-city] (UA)   cities ANA doesn't fly to; shortest United path
    NZ      SIN-AKL-city               Air New Zealand from Auckland
  Cabins: Premium Economy only where every segment is long-haul with Premium Economy confirmed;
  otherwise Economy only.
"""
import json
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RES = Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / "data/research/2026-10-26")

airports = json.loads((ROOT / "data/airports.json").read_text())
existing_ids = set()
for f in ("fares.sq.json", "fares.partners.json"):
    for r in json.loads((ROOT / "data" / f).read_text()):
        ids = {"segments": None}
        if "id" in r:
            existing_ids.add(r["id"])
        elif "segments" in r:
            existing_ids.add("+".join(dict.fromkeys(s["carrier"] for s in r["segments"])) + ":" + r["to"])
        else:
            existing_ids.add(f'{r["carrier"]}:{r["to"]}')

tk_ca = json.loads((RES / "tk_ca.json").read_text())
lx_lh = json.loads((RES / "lx_lh.json").read_text())
nh_ua = json.loads((RES / "nh_ua.json").read_text())
sq_nz = json.loads((RES / "sq_nz.json").read_text())

EUROPE = "LHR MAN BHX BER HAM MUC CDG MRS LYS FCO MXP NAP MAD BCN VLC DUB LIS AMS BRU LUX VIE CPH OSL ARN HEL KEF WAW PRG BTS BUD LJU ZAG SJJ BEG TGD SKP TIA PRN ATH SOF OTP RMO TLL RIX VNO MLA LCA ESB".split()
USA = "JFK EWR LAX SFO ORD SEA IAH IAD BOS DFW MIA DEN HNL ATL LAS MCO PHX SAN PHL MSP PDX".split()


def dist(a, b):
    p, q = airports[a], airports[b]
    la1, la2 = math.radians(p["lat"]), math.radians(q["lat"])
    dl, dp = math.radians(q["lon"] - p["lon"]), la2 - la1
    h = math.sin(dp / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin(dl / 2) ** 2
    return 2 * 3958.8 * math.asin(math.sqrt(h))


routes, skipped = [], []


def add(route, why=""):
    rid = route.get("id") or ("+".join(dict.fromkeys(s["carrier"] for s in route["segments"])) + ":" + route["to"]
                             if "segments" in route else f'{route["carrier"]}:{route["to"]}')
    if rid in existing_ids or any(r.get("_id") == rid for r in routes):
        return
    route["_id"] = rid
    routes.append(route)


def single(carrier, to, via, premium=False, seasonal=False, note=""):
    r = {"carrier": carrier, "to": to, "via": via}
    if not premium:
        r["cabins"] = ["economy"]
    r["price"] = {"economy": None, **({"premium": None} if premium else {})}
    if seasonal:
        r["seasonal"] = True
    if note:
        r["note"] = note
    add(r)


def mixed(segs, premium=False, seasonal=False, note=""):
    r = {"to": segs[-1][1], "segments": [{"carrier": c, "to": t} for c, t in segs]}
    if not premium:
        r["cabins"] = ["economy"]
    r["price"] = {"economy": None, **({"premium": None} if premium else {})}
    if seasonal:
        r["seasonal"] = True
    if note:
        r["note"] = note
    add(r)


ok = lambda x: isinstance(x, dict) and x.get("served") is True

for city in EUROPE + USA:
    us = city in USA
    # Turkish via Istanbul (no Premium Economy cabin)
    if city != "IST" and ok(tk_ca["TK"].get(city)):
        single("TK", city, ["IST"], seasonal=tk_ca["TK"][city].get("seasonal", False))
    # SWISS via Zurich, and Singapore Airlines + SWISS
    lx = lx_lh["LX"].get(city)
    if city != "ZRH" and ok(lx):
        pe = us and city in lx_lh["LX"].get("premiumEconomyUS", [])
        single("LX", city, ["ZRH"], premium=pe, seasonal=lx.get("seasonal", False))
        mixed([("SQ", "ZRH"), ("LX", city)], premium=pe, seasonal=lx.get("seasonal", False))
    # Lufthansa mainline via Munich (preferred) or Frankfurt
    lh = lx_lh["LH"].get(city) or {}
    hub = next((h for h in ("MUC", "FRA") if h != city and isinstance(lh.get(h), dict)
                and lh[h].get("served") is True and lh[h].get("operator") == "LH"), None)
    if hub:
        single("LH", city, [hub], premium=us)
        mixed([("SQ", hub), ("LH", city)], premium=us)
    else:
        served = [h for h in ("MUC", "FRA") if h != city and isinstance(lh.get(h), dict) and lh[h].get("served")]
        if served:
            ops = ", ".join(f"{h} {lh[h].get('operator')}" for h in served)
            skipped.append(f"LH {city}: {ops} (no mainline-only service)")
    # Air China via Beijing Capital
    ca = tk_ca["CA"].get(city)
    if ok(ca):
        via = ["PEK"] + {"ZAG": ["OTP"], "KEF": ["CPH"]}.get(city, [])
        single("CA", city, via, seasonal=ca.get("seasonal", False))

    if not us:
        continue
    ua = nh_ua["UA"].get(city) or {}
    # United via San Francisco (or nonstop to SFO)
    if city == "SFO":
        single("UA", "SFO", [], premium=True)
    elif ua.get("SFO") is True:
        single("UA", city, ["SFO"])
    # ANA from Tokyo
    nh = nh_ua["NH"].get(city) or {}
    tyo = "HND" if nh.get("HND") else "NRT" if nh.get("NRT") else None
    if tyo:
        single("NH", city, [tyo])
    else:
        # ANA to Tokyo + United onward: shortest Tokyo -> hub [-> city] path on United.
        best = None
        for t, key in (("HND", "fromHND"), ("NRT", "fromNRT")):
            for h in [x["to"] for x in nh_ua["UA"][key]]:
                if h == city:
                    path = [t, city]
                elif ua.get(h) is True:
                    path = [t, h, city]
                else:
                    continue
                d = sum(dist(a, b) for a, b in zip(["SIN"] + path, path))
                if not best or d < best[0]:
                    best = (d, path)
        if best:
            path = best[1]
            segs = [("NH", path[0])] + [("UA", p) for p in path[1:]]
            mixed(segs)
    # Air New Zealand via Auckland
    nz = sq_nz["NZ"].get(city)
    if ok(nz):
        single("NZ", city, ["AKL"], premium=bool(nz.get("premiumEconomy")))

for r in routes:
    r.pop("_id", None)

out = ROOT / "data/fares.network.json"
lines = ",\n".join("  " + json.dumps(r, ensure_ascii=False) for r in routes)
out.write_text("[\n" + lines + "\n]\n")
print(f"{len(routes)} routes -> {out.relative_to(ROOT)}")
from collections import Counter
print(Counter("+".join(dict.fromkeys(s["carrier"] for s in r["segments"])) if "segments" in r else r["carrier"] for r in routes))
print("skipped (Lufthansa operator):", len(skipped))
for s in skipped:
    print("  ", s)
