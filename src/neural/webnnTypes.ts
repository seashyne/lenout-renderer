export type NeuralBackend = "none" | "cpu" | "webnn" | "webnn-accelerated";

export interface MLOperandLike {
  readonly dataType: string;
  readonly shape: readonly number[];
}

export interface MLTensorLike {
  destroy?(): void;
}

export interface MLGraphLike {
  destroy?(): void;
}

export interface MLContextLike {
  readonly accelerated?: boolean;
  createTensor(descriptor: {
    dataType: "float32";
    shape: readonly number[];
    readable?: boolean;
    writable?: boolean;
  }): Promise<MLTensorLike>;
  writeTensor(tensor: MLTensorLike, data: Float32Array<ArrayBuffer>): void;
  dispatch(
    graph: MLGraphLike,
    inputs: Record<string, MLTensorLike>,
    outputs: Record<string, MLTensorLike>,
  ): void;
  readTensor(tensor: MLTensorLike): Promise<ArrayBuffer>;
  destroy?(): void;
}

export interface MLGraphBuilderLike {
  input(name: string, descriptor: { dataType: "float32"; shape: readonly number[] }): MLOperandLike;
  constant(
    descriptor: { dataType: "float32"; shape: readonly number[] },
    data: Float32Array<ArrayBuffer>,
  ): MLOperandLike;
  matmul(a: MLOperandLike, b: MLOperandLike): MLOperandLike;
  build(outputs: Record<string, MLOperandLike>): Promise<MLGraphLike>;
}

export interface WebNNRuntime {
  ml: {
    createContext(options?: {
      accelerated?: boolean;
      powerPreference?: "default" | "high-performance" | "low-power";
    }): Promise<MLContextLike>;
  };
  GraphBuilder: new (context: MLContextLike) => MLGraphBuilderLike;
}

export const getWebNNRuntime = (): WebNNRuntime | null => {
  if (typeof navigator === "undefined") return null;
  const ml = (navigator as Navigator & { ml?: WebNNRuntime["ml"] }).ml;
  const GraphBuilder = (globalThis as typeof globalThis & {
    MLGraphBuilder?: WebNNRuntime["GraphBuilder"];
  }).MLGraphBuilder;
  return ml && GraphBuilder ? { ml, GraphBuilder } : null;
};
