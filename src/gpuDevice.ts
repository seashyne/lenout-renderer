export interface LenoutGpuDeviceOptions {
  powerPreference?: GPUPowerPreference;
}

export interface LenoutGpuDeviceLease {
  readonly adapter: GPUAdapter;
  readonly device: GPUDevice;
  readonly lost: Promise<GPUDeviceLostInfo>;
  release(): void;
}

export interface LenoutGpuDevicePoolStatus {
  activeLeases: number;
  available: boolean;
  /** Monotonically increasing device generation. */
  generation: number;
  /** Number of shared devices the browser has reported as lost. */
  deviceLosses: number;
  powerPreference: GPUPowerPreference | null;
}

export interface LenoutGpuDevicePool {
  acquire(options?: LenoutGpuDeviceOptions): Promise<LenoutGpuDeviceLease>;
  status(): LenoutGpuDevicePoolStatus;
}

export interface LenoutGpuProvider {
  requestAdapter(options?: GPURequestAdapterOptions): Promise<GPUAdapter | null>;
}

interface DeviceSession {
  activeLeases: number;
  adapter: GPUAdapter;
  device: GPUDevice;
  generation: number;
  powerPreference: GPUPowerPreference;
}

/**
 * Creates an app-lifetime GPUDevice pool. Each renderer owns its resources and
 * canvas context, while the device remains shared until the browser loses it.
 */
export const createLenoutGpuDevicePool = (gpu: LenoutGpuProvider): LenoutGpuDevicePool => {
  let current: DeviceSession | null = null;
  let pending: Promise<DeviceSession> | null = null;
  let generation = 0;
  let deviceLosses = 0;

  const createSession = async (options: LenoutGpuDeviceOptions): Promise<DeviceSession> => {
    const powerPreference = options.powerPreference ?? "high-performance";
    const adapter = await gpu.requestAdapter({ powerPreference });
    if (!adapter) throw new Error("Lenout Renderer: WebGPU adapter not available");
    const device = await adapter.requestDevice();
    const session: DeviceSession = {
      activeLeases: 0,
      adapter,
      device,
      generation: ++generation,
      powerPreference,
    };
    current = session;
    void device.lost.then(() => {
      if (current !== session) return;
      deviceLosses++;
      current = null;
      pending = null;
    }).catch(() => {
      if (current !== session) return;
      current = null;
      pending = null;
    });
    return session;
  };

  const getSession = (options: LenoutGpuDeviceOptions): Promise<DeviceSession> => {
    if (current) return Promise.resolve(current);
    if (pending) return pending;
    const request = createSession(options);
    pending = request;
    void request.catch(() => {
      if (pending === request) pending = null;
    });
    return request;
  };

  return {
    async acquire(options = {}) {
      const session = await getSession(options);
      session.activeLeases += 1;
      let released = false;
      return {
        adapter: session.adapter,
        device: session.device,
        lost: session.device.lost,
        release() {
          if (released) return;
          released = true;
          session.activeLeases = Math.max(0, session.activeLeases - 1);
        }
      };
    },
    status() {
      return {
        activeLeases: current?.activeLeases ?? 0,
        available: current !== null,
        generation: current?.generation ?? generation,
        deviceLosses,
        powerPreference: current?.powerPreference ?? null
      };
    }
  };
};

let defaultPool: LenoutGpuDevicePool | null = null;

const getDefaultPool = (): LenoutGpuDevicePool => {
  if (defaultPool) return defaultPool;
  if (typeof navigator === "undefined" || !("gpu" in navigator) || !navigator.gpu) {
    throw new Error("Lenout Renderer: WebGPU is not available");
  }
  defaultPool = createLenoutGpuDevicePool(navigator.gpu);
  return defaultPool;
};

export const acquireLenoutGpuDevice = (
  options: LenoutGpuDeviceOptions = {}
): Promise<LenoutGpuDeviceLease> => getDefaultPool().acquire(options);

export const getLenoutGpuDevicePoolStatus = (): LenoutGpuDevicePoolStatus =>
  defaultPool?.status() ?? {
    activeLeases: 0,
    available: false,
    generation: 0,
    deviceLosses: 0,
    powerPreference: null,
  };
