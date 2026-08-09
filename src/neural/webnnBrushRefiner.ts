import type { BrushDab } from "../types.js";
import { getWebNNRuntime, type MLContextLike, type NeuralBackend } from "./webnnTypes.js";

const BATCH_SIZE = 256;
const DAB_VALUES = 4;
const FEATURE_COUNT = DAB_VALUES * 3;
const WEBNN_THRESHOLD = 64;

export interface NeuralProbe {
  available: boolean;
  accelerated: boolean;
}

export interface BrushRefiner {
  readonly backend: NeuralBackend;
  refine(dabs: readonly BrushDab[], strength: number): Promise<BrushDab[]>;
  destroy(): void;
}

const clampUnit = (value: number): number => Math.max(0, Math.min(1, value));

const smoothDab = (dabs: readonly BrushDab[], index: number, strength: number): BrushDab => {
  const previous = dabs[Math.max(0, index - 1)]!;
  const current = dabs[index]!;
  const next = dabs[Math.min(dabs.length - 1, index + 1)]!;
  const blend = (before: number, value: number, after: number): number => (
    value + ((before * 0.2 + value * 0.6 + after * 0.2) - value) * strength
  );
  return {
    ...current,
    x: blend(previous.x, current.x, next.x),
    y: blend(previous.y, current.y, next.y),
    size: Math.max(0.01, blend(previous.size, current.size, next.size)),
    opacity: clampUnit(blend(previous.opacity, current.opacity, next.opacity)),
  };
};

const refineOnCPU = (dabs: readonly BrushDab[], strength: number): BrushDab[] => (
  dabs.map((_, index) => smoothDab(dabs, index, strength))
);

const makeWeights = (): Float32Array<ArrayBuffer> => {
  const weights = new Float32Array(FEATURE_COUNT * DAB_VALUES);
  for (let output = 0; output < DAB_VALUES; output++) {
    weights[output * DAB_VALUES + output] = 0.2;
    weights[(DAB_VALUES + output) * DAB_VALUES + output] = 0.6;
    weights[(DAB_VALUES * 2 + output) * DAB_VALUES + output] = 0.2;
  }
  return weights;
};

const writeFeature = (target: Float32Array, offset: number, dab: BrushDab): void => {
  target[offset] = dab.x;
  target[offset + 1] = dab.y;
  target[offset + 2] = dab.size;
  target[offset + 3] = dab.opacity;
};

const makeBatch = (dabs: readonly BrushDab[], start: number): Float32Array<ArrayBuffer> => {
  const features = new Float32Array(BATCH_SIZE * FEATURE_COUNT);
  for (let local = 0; local < BATCH_SIZE; local++) {
    const index = Math.min(dabs.length - 1, start + local);
    const previous = dabs[Math.max(0, index - 1)]!;
    const current = dabs[index]!;
    const next = dabs[Math.min(dabs.length - 1, index + 1)]!;
    const offset = local * FEATURE_COUNT;
    writeFeature(features, offset, previous);
    writeFeature(features, offset + DAB_VALUES, current);
    writeFeature(features, offset + DAB_VALUES * 2, next);
  }
  return features;
};

const mergeBatch = (
  output: Float32Array,
  dabs: readonly BrushDab[],
  start: number,
  strength: number,
  result: BrushDab[],
): void => {
  const count = Math.min(BATCH_SIZE, dabs.length - start);
  for (let local = 0; local < count; local++) {
    const current = dabs[start + local]!;
    const offset = local * DAB_VALUES;
    const blend = (value: number, smoothed: number): number => value + (smoothed - value) * strength;
    result.push({
      ...current,
      x: blend(current.x, output[offset]!),
      y: blend(current.y, output[offset + 1]!),
      size: Math.max(0.01, blend(current.size, output[offset + 2]!)),
      opacity: clampUnit(blend(current.opacity, output[offset + 3]!)),
    });
  }
};

export const probeWebNN = async (): Promise<NeuralProbe> => {
  const runtime = getWebNNRuntime();
  if (!runtime) return { available: false, accelerated: false };
  try {
    const context = await runtime.ml.createContext({ accelerated: true, powerPreference: "high-performance" });
    const accelerated = context.accelerated === true;
    context.destroy?.();
    return { available: true, accelerated };
  } catch {
    return { available: false, accelerated: false };
  }
};

const buildWebNNRefiner = async (): Promise<BrushRefiner | null> => {
  const runtime = getWebNNRuntime();
  if (!runtime) return null;

  let context: MLContextLike | undefined;
  try {
    context = await runtime.ml.createContext({ accelerated: true, powerPreference: "high-performance" });
    const builder = new runtime.GraphBuilder(context);
    const inputShape = [BATCH_SIZE, FEATURE_COUNT] as const;
    const outputShape = [BATCH_SIZE, DAB_VALUES] as const;
    const input = builder.input("dabs", { dataType: "float32", shape: inputShape });
    const weights = builder.constant(
      { dataType: "float32", shape: [FEATURE_COUNT, DAB_VALUES] },
      makeWeights(),
    );
    const refined = builder.matmul(input, weights);
    const graph = await builder.build({ refined });
    const [inputTensor, outputTensor] = await Promise.all([
      context.createTensor({ dataType: "float32", shape: inputShape, writable: true }),
      context.createTensor({ dataType: "float32", shape: outputShape, readable: true }),
    ]);
    let active = true;
    let queue = Promise.resolve();

    const run = async (dabs: readonly BrushDab[], strength: number): Promise<BrushDab[]> => {
      const result: BrushDab[] = [];
      for (let start = 0; start < dabs.length; start += BATCH_SIZE) {
        context!.writeTensor(inputTensor, makeBatch(dabs, start));
        context!.dispatch(graph, { dabs: inputTensor }, { refined: outputTensor });
        const output = new Float32Array(await context!.readTensor(outputTensor));
        mergeBatch(output, dabs, start, strength, result);
      }
      return result;
    };

    return {
      backend: context.accelerated === true ? "webnn-accelerated" : "webnn",
      refine(dabs, strength) {
        const amount = clampUnit(strength);
        if (!active || amount === 0 || dabs.length < 3) return Promise.resolve([...dabs]);
        if (dabs.length < WEBNN_THRESHOLD) return Promise.resolve(refineOnCPU(dabs, amount));
        const task = queue.then(() => run(dabs, amount));
        queue = task.then(() => undefined, () => undefined);
        return task.catch(() => refineOnCPU(dabs, amount));
      },
      destroy() {
        active = false;
        inputTensor.destroy?.();
        outputTensor.destroy?.();
        graph.destroy?.();
        context?.destroy?.();
      },
    };
  } catch {
    context?.destroy?.();
    return null;
  }
};

export const createBrushRefiner = async (enabled = true): Promise<BrushRefiner> => {
  if (!enabled) {
    return {
      backend: "none",
      refine(dabs) {
        return Promise.resolve([...dabs]);
      },
      destroy() {},
    };
  }
  const webnn = await buildWebNNRefiner();
  if (webnn) return webnn;
  return {
    backend: "cpu",
    refine(dabs, strength) {
      const amount = clampUnit(strength);
      return Promise.resolve(amount === 0 || dabs.length < 3 ? [...dabs] : refineOnCPU(dabs, amount));
    },
    destroy() {},
  };
};
