export type LenoutPixelRatio = number | "auto";

export interface LenoutDpiOptions {
  /** Backing-store pixels per logical CSS pixel. Defaults to the device ratio. */
  pixelRatio?: LenoutPixelRatio;
  /** Upper bound for automatic and explicit pixel ratios. Defaults to 2. */
  maxPixelRatio?: number;
  /** Keep the canvas CSS size in logical pixels when its backing store changes. */
  manageCssSize?: boolean;
}

export interface LenoutDisplayMetrics {
  logicalWidth: number;
  logicalHeight: number;
  physicalWidth: number;
  physicalHeight: number;
  pixelRatio: number;
  /** Changes whenever logical size, physical size, or pixel ratio changes. */
  revision: number;
}

export interface CanvasDpiController {
  readonly metrics: LenoutDisplayMetrics;
  resize(logicalWidth: number, logicalHeight: number, pixelRatio?: LenoutPixelRatio): boolean;
}

const MIN_PIXEL_RATIO = 0.5;
const MAX_PIXEL_RATIO = 4;
const DEFAULT_MAX_PIXEL_RATIO = 2;

const finitePositive = (value: number, fallback: number): number =>
  Number.isFinite(value) && value > 0 ? value : fallback;

const currentDevicePixelRatio = (): number =>
  typeof window === "undefined" ? 1 : finitePositive(window.devicePixelRatio, 1);

export const resolveLenoutPixelRatio = (
  requested: LenoutPixelRatio | undefined,
  maximum = DEFAULT_MAX_PIXEL_RATIO,
  devicePixelRatio = currentDevicePixelRatio(),
): number => {
  const safeMaximum = Math.min(
    MAX_PIXEL_RATIO,
    Math.max(MIN_PIXEL_RATIO, finitePositive(maximum, DEFAULT_MAX_PIXEL_RATIO)),
  );
  const candidate = requested === "auto" || requested === undefined
    ? finitePositive(devicePixelRatio, 1)
    : finitePositive(requested, 1);
  return Math.min(safeMaximum, Math.max(MIN_PIXEL_RATIO, candidate));
};

export const calculateLenoutDisplayMetrics = (
  logicalWidth: number,
  logicalHeight: number,
  pixelRatio: number,
  revision = 0,
): LenoutDisplayMetrics => {
  const width = Math.max(1, finitePositive(logicalWidth, 1));
  const height = Math.max(1, finitePositive(logicalHeight, 1));
  const ratio = Math.max(MIN_PIXEL_RATIO, finitePositive(pixelRatio, 1));
  return {
    logicalWidth: width,
    logicalHeight: height,
    physicalWidth: Math.max(1, Math.round(width * ratio)),
    physicalHeight: Math.max(1, Math.round(height * ratio)),
    pixelRatio: ratio,
    revision,
  };
};

export const createCanvasDpiController = (
  canvas: HTMLCanvasElement,
  options: LenoutDpiOptions = {},
): CanvasDpiController => {
  const bounds = canvas.getBoundingClientRect();
  const initialWidth = canvas.clientWidth || bounds.width || canvas.width || 1;
  const initialHeight = canvas.clientHeight || bounds.height || canvas.height || 1;
  let metrics = calculateLenoutDisplayMetrics(initialWidth, initialHeight, 1);

  const resize = (
    logicalWidth: number,
    logicalHeight: number,
    requestedRatio: LenoutPixelRatio = options.pixelRatio ?? "auto",
  ): boolean => {
    const next = calculateLenoutDisplayMetrics(
      logicalWidth,
      logicalHeight,
      resolveLenoutPixelRatio(requestedRatio, options.maxPixelRatio),
      metrics.revision,
    );
    const changed = next.logicalWidth !== metrics.logicalWidth
      || next.logicalHeight !== metrics.logicalHeight
      || next.physicalWidth !== metrics.physicalWidth
      || next.physicalHeight !== metrics.physicalHeight
      || next.pixelRatio !== metrics.pixelRatio;
    if (changed) next.revision++;
    metrics = next;

    if (options.manageCssSize !== false) {
      canvas.style.width = `${next.logicalWidth}px`;
      canvas.style.height = `${next.logicalHeight}px`;
    }
    if (canvas.width !== next.physicalWidth) canvas.width = next.physicalWidth;
    if (canvas.height !== next.physicalHeight) canvas.height = next.physicalHeight;
    return changed;
  };

  resize(initialWidth, initialHeight);
  return {
    get metrics() {
      return metrics;
    },
    resize,
  };
};
