// Tests for the street graph and the routing over it. Run with `npm test`.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { DELIVERY_STOPS, EDGES, NODES, deliveryLoopNodes, isEdge, metersBetween, nearestNode, pointsOf, shortestPath } from "./streets.js";

const ONE_BLOCK = 250; // metres: no single straight step may be longer than this
const CHARGERS = ["charger-001", "charger-002", "charger-003"];
const intersections = Object.entries(NODES).filter(([, node]) => node.kind === "intersection");
const stepLengths = (nodeIds) => nodeIds.slice(1).map((id, i) => metersBetween(NODES[nodeIds[i]], NODES[id]));

describe("street graph", () => {
  test("every edge joins two known, different nodes, and no edge is listed twice", () => {
    const seen = new Set();
    for (const [a, b, street] of EDGES) {
      assert.ok(NODES[a] && NODES[b], `${a} -> ${b}`);
      assert.notEqual(a, b);
      assert.ok(typeof street === "string" && street.length > 0);
      const key = [a, b].sort().join("|");
      assert.ok(!seen.has(key), `duplicate edge ${key}`);
      seen.add(key);
    }
  });

  test("no edge is longer than one block", () => {
    for (const [a, b] of EDGES) {
      const meters = metersBetween(NODES[a], NODES[b]);
      assert.ok(meters > 5 && meters <= ONE_BLOCK, `${NODES[a].name} -> ${NODES[b].name} is ${Math.round(meters)} m`);
    }
  });

  test("it covers the downtown grid: six avenues crossed with Cesar Chavez and 2nd through 11th St", () => {
    const names = new Set(intersections.map(([, node]) => node.name));
    const has = (avenue, cross) => [...names].some((name) => name.startsWith(`${avenue} &`) && name.includes(cross));
    for (const avenue of ["Lavaca St", "Colorado St", "Congress Ave", "Brazos St", "San Jacinto Blvd", "Trinity St"]) {
      for (const cross of ["Cesar Chavez St", "2nd St", "3rd St", "4th St", "5th St", "6th St", "7th St", "8th St", "9th St", "10th St", "11th St"]) {
        assert.ok(has(avenue, cross), `${avenue} & ${cross}`);
      }
    }
  });

  test("it reaches over the bridge to South Congress and east along 6th St past I-35", () => {
    const names = intersections.map(([, node]) => node.name).join("\n");
    for (const expected of ["Congress Ave Bridge, north end", "S Congress Ave & Riverside Dr", "S Congress Ave & Gibson St", "E 6th St & Red River St", "E 6th St & I-35 frontage road (east side)", "E 6th St & Medina St"]) {
      assert.ok(names.includes(expected), expected);
    }
  });

  test("coordinates are all in downtown Austin", () => {
    for (const [id, node] of Object.entries(NODES)) {
      assert.ok(node.lat > 30.247 && node.lat < 30.275 && node.lng > -97.752 && node.lng < -97.728, `${id} at ${node.lat}, ${node.lng}`);
    }
  });

  test("edges follow a street: every edge on a numbered street joins neighbouring avenues, and vice versa", () => {
    // On the grid, two intersections joined along "6th St" must both be on 6th St, and so on.
    for (const [a, b, street] of EDGES) {
      if (street === "charger" || NODES[a].kind !== "intersection" || NODES[b].kind !== "intersection") continue;
      const word = street.replace(/ (St|Ave|Blvd)$/, "");
      for (const id of [a, b]) assert.ok(NODES[id].name.includes(word), `${NODES[id].name} is on ${street}`);
    }
  });

  test("the whole graph is connected", () => {
    const reached = new Set(["congress-ave-and-6th-st"]);
    const queue = ["congress-ave-and-6th-st"];
    while (queue.length) {
      const here = queue.pop();
      for (const [a, b] of EDGES) {
        const next = a === here ? b : b === here ? a : null;
        if (next && !reached.has(next)) (reached.add(next), queue.push(next));
      }
    }
    assert.equal(reached.size, Object.keys(NODES).length);
  });

  test("each charger is joined to the graph by one edge, to its nearest intersection", () => {
    for (const charger of CHARGERS) {
      assert.equal(NODES[charger].kind, "charger");
      const joins = EDGES.filter(([a, b]) => a === charger || b === charger).map(([a, b]) => (a === charger ? b : a));
      assert.deepEqual(joins, [nearestNode(NODES[charger], ["intersection"])], `${charger} joins at its nearest intersection`);
    }
    assert.equal(NODES[nearestNode(NODES["charger-001"], ["intersection"])].name, "Congress Ave & 6th St");
    assert.equal(NODES[nearestNode(NODES["charger-002"], ["intersection"])].name, "S Congress Ave & Gibson St");
    assert.equal(NODES[nearestNode(NODES["charger-003"], ["intersection"])].name, "E 6th St & Medina St");
  });

  test("the file is self-contained: no imports and no network calls, so routing works offline", () => {
    const source = readFileSync(new URL("./streets.js", import.meta.url), "utf8");
    assert.doesNotMatch(source, /^\s*import\s/m);
    assert.doesNotMatch(source, /fetch\(|require\(|https?:\/\/|XMLHttpRequest|WebSocket/);
  });
});

describe("routing (Dijkstra)", () => {
  test("a route only ever steps along graph edges", () => {
    const ids = Object.keys(NODES);
    for (let i = 0; i < ids.length; i += 3) {
      for (let j = 1; j < ids.length; j += 7) {
        const route = shortestPath(ids[i], ids[j]);
        assert.ok(route, `${ids[i]} -> ${ids[j]}`);
        route.nodes.slice(1).forEach((id, k) => assert.ok(isEdge(route.nodes[k], id), `${route.nodes[k]} -> ${id} is not an edge`));
        assert.equal(route.nodes[0], ids[i]);
        assert.equal(route.nodes.at(-1), ids[j]);
      }
    }
  });

  test("its length is the sum of its steps, and the same in both directions", () => {
    const there = shortestPath("lavaca-st-and-w-11th-st", "charger-003");
    const back = shortestPath("charger-003", "lavaca-st-and-w-11th-st");
    assert.ok(Math.abs(there.meters - stepLengths(there.nodes).reduce((sum, m) => sum + m, 0)) < 0.001);
    assert.ok(Math.abs(there.meters - back.meters) < 0.001);
  });

  test("it finds the shortest way: straight down an avenue, and never longer than any other route", () => {
    const route = shortestPath("congress-ave-and-9th-st", "congress-ave-and-6th-st");
    assert.deepEqual(route.nodes.map((id) => NODES[id].name), ["Congress Ave & 9th St", "Congress Ave & 8th St", "Congress Ave & 7th St", "Congress Ave & 6th St"]);

    // Check against a slow, obviously-correct search (Bellman-Ford) from one corner of the grid.
    const from = "trinity-st-and-e-11th-st";
    const best = Object.fromEntries(Object.keys(NODES).map((id) => [id, id === from ? 0 : Infinity]));
    for (let round = 0; round < Object.keys(NODES).length; round++) {
      for (const [a, b] of EDGES) {
        const meters = metersBetween(NODES[a], NODES[b]);
        // A charger is a dead end: nothing routes through it.
        if (NODES[a].kind !== "charger" || a === from) best[b] = Math.min(best[b], best[a] + meters);
        if (NODES[b].kind !== "charger" || b === from) best[a] = Math.min(best[a], best[b] + meters);
      }
    }
    for (const id of Object.keys(NODES)) assert.ok(Math.abs(shortestPath(from, id).meters - best[id]) < 0.01, id);
  });

  test("a route never passes through a charger on the way to somewhere else", () => {
    for (const from of DELIVERY_STOPS) {
      for (const to of DELIVERY_STOPS) {
        const middle = shortestPath(from, to).nodes.slice(1, -1);
        assert.ok(middle.every((id) => NODES[id].kind !== "charger"));
      }
    }
  });

  test("edge cases: a route to itself, and unknown nodes", () => {
    assert.deepEqual(shortestPath("congress-ave-and-6th-st", "congress-ave-and-6th-st"), { nodes: ["congress-ave-and-6th-st"], meters: 0 });
    assert.equal(shortestPath("congress-ave-and-6th-st", "no-such-corner"), null);
    assert.equal(shortestPath("no-such-corner", "congress-ave-and-6th-st"), null);
  });
});

describe("delivery loop and chargers", () => {
  const loop = deliveryLoopNodes();

  test("the loop has 8 stops, all intersections on the graph", () => {
    assert.equal(DELIVERY_STOPS.length, 8);
    for (const stop of DELIVERY_STOPS) assert.equal(NODES[stop]?.kind, "intersection", stop);
  });

  test("the loop follows the streets: every step is a graph edge, none longer than a block, and it closes", () => {
    loop.slice(1).forEach((id, i) => assert.ok(isEdge(loop[i], id), `${loop[i]} -> ${id}`));
    assert.ok(Math.max(...stepLengths(loop)) <= ONE_BLOCK);
    assert.equal(loop[0], loop.at(-1));
    for (const stop of DELIVERY_STOPS) assert.ok(loop.includes(stop), stop);
  });

  test("every charger can be reached from every point of the loop, along edges only", () => {
    for (const from of new Set(loop)) {
      for (const charger of CHARGERS) {
        const route = shortestPath(from, charger);
        assert.ok(route, `${from} -> ${charger}`);
        assert.equal(route.nodes.at(-1), charger);
        route.nodes.slice(1).forEach((id, i) => assert.ok(isEdge(route.nodes[i], id), `${route.nodes[i]} -> ${id}`));
      }
    }
  });

  test("on those routes no straight step between consecutive points is longer than one block", () => {
    let longest = 0;
    for (const from of new Set(loop)) {
      for (const charger of CHARGERS) longest = Math.max(longest, ...stepLengths(shortestPath(from, charger).nodes));
    }
    assert.ok(longest <= ONE_BLOCK, `longest step is ${Math.round(longest)} m`);
  });

  test("and every loop point can be reached back from every charger", () => {
    for (const charger of CHARGERS) for (const stop of DELIVERY_STOPS) assert.ok(shortestPath(charger, stop));
  });

  test("pointsOf gives the coordinates of a route", () => {
    assert.deepEqual(pointsOf(["charger-001"]), [{ lat: 30.2682, lng: -97.7429, node: "charger-001" }]);
  });
});
