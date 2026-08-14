import { describe, expect, it, vi } from "vitest";
import {
  createLenoutGpuDevicePool,
  type LenoutGpuProvider
} from "../src/gpuDevice.js";

const createGpuHarness = () => {
  const devices: Array<GPUDevice & { resolveLost: (info: GPUDeviceLostInfo) => void }> = [];
  const requestDevice = vi.fn(async () => {
    let resolveLost = (_info: GPUDeviceLostInfo): void => undefined;
    const lost = new Promise<GPUDeviceLostInfo>((resolve) => { resolveLost = resolve; });
    const device = {
      lost,
      resolveLost
    } as GPUDevice & { resolveLost: (info: GPUDeviceLostInfo) => void };
    devices.push(device);
    return device;
  });
  const adapter = { requestDevice } as unknown as GPUAdapter;
  const requestAdapter = vi.fn(async () => adapter);
  return {
    devices,
    gpu: { requestAdapter } satisfies LenoutGpuProvider,
    requestAdapter,
    requestDevice
  };
};

describe("Lenout GPUDevice pool", () => {
  it("shares one device across concurrent renderer leases", async () => {
    const harness = createGpuHarness();
    const pool = createLenoutGpuDevicePool(harness.gpu);
    const [drawing, video, scene3d] = await Promise.all([
      pool.acquire(),
      pool.acquire(),
      pool.acquire()
    ]);

    expect(drawing.device).toBe(video.device);
    expect(video.device).toBe(scene3d.device);
    expect(harness.requestAdapter).toHaveBeenCalledOnce();
    expect(harness.requestDevice).toHaveBeenCalledOnce();
    expect(pool.status()).toMatchObject({ activeLeases: 3, available: true, generation: 1 });

    drawing.release();
    drawing.release();
    video.release();
    scene3d.release();
    expect(pool.status()).toMatchObject({ activeLeases: 0, available: true });
  });

  it("creates a new shared device after the browser loses the current one", async () => {
    const harness = createGpuHarness();
    const pool = createLenoutGpuDevicePool(harness.gpu);
    const first = await pool.acquire({ powerPreference: "high-performance" });
    harness.devices[0]!.resolveLost({ message: "reset", reason: "unknown" } as GPUDeviceLostInfo);
    await first.lost;
    await Promise.resolve();

    const second = await pool.acquire();
    expect(second.device).not.toBe(first.device);
    expect(pool.status()).toMatchObject({ deviceLosses: 1, generation: 2 });
    expect(harness.requestAdapter).toHaveBeenCalledTimes(2);
    expect(harness.requestDevice).toHaveBeenCalledTimes(2);
  });
});
