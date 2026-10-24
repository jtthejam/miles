'use strict';

// Miles-goal planner: find combinations of up to N trips whose miles reach a target,
// ranked by total fare. Works in the browser (window.Planner) and Node (module.exports).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Planner = factory();
})(typeof self !== 'undefined' ? self : this, () => {
  /**
   * Only "minimal" combinations are returned: dropping any one trip would fall short of the target.
   * (Adding a trip to a combination that already qualifies only costs more, so those are skipped.)
   *
   * @param {Array} rows   rows from /api/routes (need key, code, miles, priceSgd)
   * @param {object} opts  { target, trips (max), distinct = true, limit = 20 }
   * @returns {{ results: Array, candidates: number, maxMiles: number }}
   *   results: [{ rows, miles, cost, surplus, centsPerMile }] cheapest first
   */
  function plan(rows, { target, trips, distinct = true, limit = 20 } = {}) {
    target = Math.max(0, Number(target) || 0);
    const maxTrips = Math.max(1, Math.min(6, Math.floor(Number(trips) || 1)));

    // Usable options, cheapest first: lets the cost bound stop the loop early.
    const cand = rows
      .filter((r) => r.priceSgd > 0 && r.miles > 0)
      .sort((a, b) => a.priceSgd - b.priceSgd || b.miles - a.miles);
    const n = cand.length;

    // Best miles available from index i onward (for the "can't reach target" bound).
    const sufMaxMiles = new Array(n + 1).fill(0);
    for (let i = n - 1; i >= 0; i--) sufMaxMiles[i] = Math.max(sufMaxMiles[i + 1], cand[i].miles);

    // Most miles achievable with up to maxTrips trips (for messaging when nothing qualifies).
    const byMiles = [...cand].sort((a, b) => b.miles - a.miles);
    let maxMiles = 0;
    if (distinct) {
      const seen = new Set();
      for (const c of byMiles) {
        if (seen.size === maxTrips) break;
        if (seen.has(c.code)) continue;
        seen.add(c.code); maxMiles += c.miles;
      }
    } else if (byMiles.length) maxMiles = byMiles[0].miles * maxTrips;

    const best = []; // sorted by cost asc, length ≤ limit
    const kthCost = () => (best.length < limit ? Infinity : best[best.length - 1].cost);
    const pick = [];
    const usedDest = new Set();

    function record(miles, cost) {
      const minTrip = Math.min(...pick.map((p) => p.miles));
      if (pick.length > 1 && miles - minTrip >= target) return; // not minimal: a trip could be dropped
      const entry = { rows: [...pick], miles, cost, surplus: miles - target, centsPerMile: +((cost * 100) / miles).toFixed(2) };
      let i = best.length;
      while (i > 0 && (best[i - 1].cost > cost || (best[i - 1].cost === cost && best[i - 1].miles < miles))) i--;
      best.splice(i, 0, entry);
      if (best.length > limit) best.pop();
    }

    function dfs(start, miles, cost) {
      if (pick.length && miles >= target) { record(miles, cost); return; } // supersets only cost more
      const left = maxTrips - pick.length;
      if (left === 0) return;
      for (let i = start; i < n; i++) {
        const c = cand[i];
        if (cost + c.priceSgd >= kthCost()) break;              // sorted by price: nothing later is cheaper
        if (miles + left * sufMaxMiles[i] < target) break;      // even the best remaining can't reach it
        if (distinct && usedDest.has(c.code)) continue;
        pick.push(c);
        if (distinct) usedDest.add(c.code);
        dfs(distinct ? i + 1 : i, miles + c.miles, cost + c.priceSgd);
        pick.pop();
        if (distinct) usedDest.delete(c.code);
      }
    }

    if (n) dfs(0, 0, 0);
    return { results: best, candidates: n, maxMiles };
  }

  return { plan };
});
