// Layout of the black_origin_face model on screen. The model draws its
// expression icons above the face, so fitting the whole canvas left the face
// small. The icons are moved beside the face instead (vertices remapped every
// frame; the model files are untouched) and the view fits the face band.
// Model units: y up, canvas height = 1, origin at the canvas centre.

// Everything drawn across all expressions, speech and eye/brow wander, with
// the icons moved (checked offline against the model; Background excluded)
export const FACE_BOUNDS = { x0: -0.70, x1: 0.70, y0: -0.41, y1: 0.40 };

const FACE_CENTER = { x: 0, y: 0.06 };

// Icon drawables: move by (dx, dy) and scale about their rest centre (cx, cy)
const MOVES = {
  ArtMesh7: { cx: 0.38, cy: 0.353, dx: 0.19, dy: -0.17, scale: 0.85 }, // Joy sun
  ArtMesh3: { cx: 0.34, cy: 0.32, dx: 0.22, dy: -0.15, scale: 1 }, // Question mark
  ArtMesh5: { cx: 0.386, cy: 0.359, dx: 0.17, dy: -0.18, scale: 1 }, // Sweat drop
  ArtMesh4: { cx: -0.38, cy: 0.34, dx: -0.18, dy: -0.16, scale: 1 }, // Anger mark
};
// Focus dashes surround the head: each dash keeps its shape, and its position
// around the face centre is folded towards the horizontal so the dashes above
// the head end up beside it
const FOCUS_ID = "ArtMesh2";
const FOCUS_ANGLE_KEEP = 0.45; // fraction of the angle from the horizontal kept
const FOCUS_RADIUS_X = 1.3;
const FOCUS_RADIUS_Y = 0.8;

// Vertex groups of each separate piece of a mesh (from its triangles), by drawable id
const pieceCache = new Map();

function meshPieces(id, indices, vertexCount) {
  let pieces = pieceCache.get(id);
  if (pieces) return pieces;
  const parent = Array.from({ length: vertexCount }, (_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let t = 0; t < indices.length; t += 3) {
    const a = find(indices[t]);
    parent[find(indices[t + 1])] = a;
    parent[find(indices[t + 2])] = a;
  }
  const groups = new Map();
  for (let i = 0; i < vertexCount; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(i);
  }
  pieces = [...groups.values()];
  pieceCache.set(id, pieces);
  return pieces;
}

function foldAroundFace(x, y) {
  const dx = x - FACE_CENTER.x;
  const dy = y - FACE_CENTER.y;
  const r = Math.hypot(dx, dy);
  const a = Math.atan2(dy, dx);
  // Fold the angle measured from the nearer horizontal (0 = right, PI = left)
  const side = Math.abs(a) <= Math.PI / 2 ? 0 : Math.PI;
  const fromSide = side === 0 ? a : a > 0 ? a - Math.PI : a + Math.PI;
  const folded = side + fromSide * FOCUS_ANGLE_KEEP;
  return [FACE_CENTER.x + r * Math.cos(folded) * FOCUS_RADIUS_X, FACE_CENTER.y + r * Math.sin(folded) * FOCUS_RADIUS_Y];
}

/**
 * Returns the remapped vertex positions of an icon drawable in out (same
 * length as src), or null to draw it as is. indices = the drawable's triangles.
 */
export function layoutVertices(id, src, out, indices) {
  const move = MOVES[id];
  if (move) {
    for (let i = 0; i < src.length; i += 2) {
      out[i] = move.cx + move.dx + (src[i] - move.cx) * move.scale;
      out[i + 1] = move.cy + move.dy + (src[i + 1] - move.cy) * move.scale;
    }
    return out;
  }
  if (id === FOCUS_ID && indices) {
    for (const piece of meshPieces(id, indices, src.length / 2)) {
      let cx = 0;
      let cy = 0;
      for (const v of piece) {
        cx += src[2 * v];
        cy += src[2 * v + 1];
      }
      cx /= piece.length;
      cy /= piece.length;
      const [nx, ny] = foldAroundFace(cx, cy);
      for (const v of piece) {
        out[2 * v] = src[2 * v] + nx - cx;
        out[2 * v + 1] = src[2 * v + 1] + ny - cy;
      }
    }
    return out;
  }
  return null;
}
