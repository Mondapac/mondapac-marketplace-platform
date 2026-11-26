// Pure geometry for build-boundaries.mjs: no I/O, no dependencies. Coordinates are [lng, lat]
// pairs already rounded to a fixed precision, so a border two postal areas share has the same
// vertices in both and can be dropped by comparing text keys.

const key = ([x, y]) => `${x},${y}`;

/** Twice the signed area of a closed ring (positive = counter-clockwise). */
export function ringArea(ring) {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  }
  return sum;
}

/** Whether a point lies inside a closed ring (ray casting). */
export function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * The outline of the union of polygons that tile without overlap (postal areas): every edge two
 * polygons share is dropped, the rest is chained into closed rings, and each ring becomes an
 * outer ring or a hole of the ring that holds it. Returns GeoJSON MultiPolygon coordinates.
 */
export function dissolve(polygons) {
  const count = new Map();
  const edges = [];
  for (const polygon of polygons) {
    for (const ring of polygon) {
      for (let i = 0; i + 1 < ring.length; i++) {
        const a = ring[i];
        const b = ring[i + 1];
        if (key(a) === key(b)) continue;
        const undirected = [key(a), key(b)].sort().join('|');
        count.set(undirected, (count.get(undirected) ?? 0) + 1);
        edges.push({ a, b, undirected });
      }
    }
  }
  const outline = edges.filter((edge) => count.get(edge.undirected) === 1);
  const from = new Map();
  for (const edge of outline) {
    const list = from.get(key(edge.a)) ?? [];
    list.push(edge);
    from.set(key(edge.a), list);
  }
  const used = new Set();
  const rings = [];
  for (const start of outline) {
    if (used.has(start)) continue;
    const ring = [start.a];
    let edge = start;
    while (edge !== undefined && !used.has(edge)) {
      used.add(edge);
      ring.push(edge.b);
      if (key(edge.b) === key(start.a)) break;
      edge = (from.get(key(edge.b)) ?? []).find((next) => !used.has(next));
    }
    if (ring.length >= 4 && key(ring[0]) === key(ring[ring.length - 1])) rings.push(ring);
  }
  // A ring inside an odd number of others is a hole; it belongs to the smallest one holding it.
  const depth = rings.map(
    (ring, i) => rings.filter((other, j) => j !== i && pointInRing(ring[0], other)).length,
  );
  const outers = rings
    .map((ring, i) => ({ ring, i }))
    .filter(({ i }) => depth[i] % 2 === 0)
    .map(({ ring }) => [ccw(ring)]);
  rings.forEach((ring, i) => {
    if (depth[i] % 2 === 0) return;
    const holders = outers
      .filter((polygon) => pointInRing(ring[0], polygon[0]))
      .sort((p, q) => Math.abs(ringArea(p[0])) - Math.abs(ringArea(q[0])));
    holders[0]?.push(cw(ring));
  });
  return outers;
}

const ccw = (ring) => (ringArea(ring) < 0 ? [...ring].reverse() : ring);
const cw = (ring) => (ringArea(ring) > 0 ? [...ring].reverse() : ring);

function perpendicular(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = Math.hypot(dx, dy);
  if (length === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  return Math.abs(dy * p[0] - dx * p[1] + b[0] * a[1] - b[1] * a[0]) / length;
}

/** Douglas-Peucker on an open line, keeping both ends. */
function simplifyLine(points, tolerance) {
  if (points.length < 3) return points;
  let worst = 0;
  let at = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpendicular(points[i], points[0], points[points.length - 1]);
    if (d > worst) {
      worst = d;
      at = i;
    }
  }
  if (worst <= tolerance) return [points[0], points[points.length - 1]];
  const left = simplifyLine(points.slice(0, at + 1), tolerance);
  const right = simplifyLine(points.slice(at), tolerance);
  return [...left.slice(0, -1), ...right];
}

/** A closed ring simplified, split at its farthest point so both halves keep their shape. */
export function simplifyRing(ring, tolerance) {
  let far = 0;
  let distance = 0;
  for (let i = 1; i < ring.length - 1; i++) {
    const d = Math.hypot(ring[i][0] - ring[0][0], ring[i][1] - ring[0][1]);
    if (d > distance) {
      distance = d;
      far = i;
    }
  }
  if (far === 0) return ring;
  const first = simplifyLine(ring.slice(0, far + 1), tolerance);
  const second = simplifyLine(ring.slice(far), tolerance);
  return [...first.slice(0, -1), ...second];
}

/**
 * The MultiPolygon simplified: rings within `tolerance` degrees of the original, rings whose
 * area is below `minArea` square degrees (slivers, rocks) dropped, coordinates rounded.
 */
export function simplify(multiPolygon, tolerance, minArea, decimals) {
  const round = (n) => Number(n.toFixed(decimals));
  const clean = (ring) => {
    const out = simplifyRing(ring, tolerance).map(([x, y]) => [round(x), round(y)]);
    return out.length >= 4 && Math.abs(ringArea(out)) / 2 >= minArea ? out : undefined;
  };
  const result = [];
  for (const [outer, ...holes] of multiPolygon) {
    const shell = clean(outer);
    // A dropped outer ring takes its holes with it.
    if (shell === undefined) continue;
    result.push([shell, ...holes.map(clean).filter((ring) => ring !== undefined)]);
  }
  return result;
}
