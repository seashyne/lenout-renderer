// ---------------------------------------------------------------------------
// Scene Graph — Structure-of-Arrays (SoA) for cache-friendly batch ops.
//
// Flat typed arrays instead of object trees → CPU prefetcher works.
// All fields at index `i` belong to the same node.
// ---------------------------------------------------------------------------

export enum NodeKind {
  Canvas = 0,
  Image = 1,
  Vector = 2,
  Text = 3,
  Stroke = 4,
}

export interface SceneGraphInit {
  maxNodes?: number;
}

export interface SceneGraph {
  /** Add a node, returns its index */
  add(kind: NodeKind, x: number, y: number, w: number, h: number): number;
  /** Remove a node (marks its slot as free) */
  remove(index: number): void;
  /** Update world transform */
  setTransform(index: number, x: number, y: number, rotation: number, scaleX: number, scaleY: number): void;
  /** Mark node as dirty (needs re-render) */
  markDirty(index: number): void;
  /** Get all dirty node indices and clear the set */
  flushDirty(): number[];
  /** Raw data access for batch operations */
  readonly data: SceneData;
}

export interface SceneData {
  kinds: Uint8Array;
  visible: Uint8Array;
  worldX: Float32Array;
  worldY: Float32Array;
  width: Float32Array;
  height: Float32Array;
  rotation: Float32Array;
  scaleX: Float32Array;
  scaleY: Float32Array;
  opacity: Float32Array;
  zIndex: Int32Array;
  count: number;
}

const DEFAULT_MAX = 16_384;

export const createSceneGraph = (init: SceneGraphInit = {}): SceneGraph => {
  const max = init.maxNodes ?? DEFAULT_MAX;

  const data: SceneData = {
    kinds: new Uint8Array(max),
    visible: new Uint8Array(max).fill(1),
    worldX: new Float32Array(max),
    worldY: new Float32Array(max),
    width: new Float32Array(max),
    height: new Float32Array(max),
    rotation: new Float32Array(max),
    scaleX: new Float32Array(max).fill(1),
    scaleY: new Float32Array(max).fill(1),
    opacity: new Float32Array(max).fill(1),
    zIndex: new Int32Array(max),
    count: 0,
  };

  const dirty = new Set<number>();
  const freeSlots: number[] = [];

  return {
    data,

    add(kind, x, y, w, h): number {
      const i = freeSlots.pop() ?? data.count++;
      if (i >= max) throw new Error("Lenout Renderer: scene graph capacity exceeded");
      data.kinds[i] = kind;
      data.visible[i] = 1;
      data.worldX[i] = x;
      data.worldY[i] = y;
      data.width[i] = w;
      data.height[i] = h;
      dirty.add(i);
      return i;
    },

    remove(i): void {
      data.visible[i] = 0;
      freeSlots.push(i);
    },

    setTransform(i, x, y, rotation, scaleX, scaleY): void {
      data.worldX[i] = x;
      data.worldY[i] = y;
      data.rotation[i] = rotation;
      data.scaleX[i] = scaleX;
      data.scaleY[i] = scaleY;
      dirty.add(i);
    },

    markDirty(i): void {
      dirty.add(i);
    },

    flushDirty(): number[] {
      const ids = [...dirty];
      dirty.clear();
      return ids;
    },
  };
};
