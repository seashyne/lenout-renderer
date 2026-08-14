import type { BlendMode, CompositeStyle, RenderCommand } from "./types.js";

export interface CompositeLayer {
  blendMode?: BlendMode;
  children?: readonly CompositeLayer[];
  commands?: readonly RenderCommand[];
  id?: string;
  opacity?: number;
  visible?: boolean;
}

const clampOpacity = (value: number | undefined): number =>
  value === undefined || !Number.isFinite(value) ? 1 : Math.max(0, Math.min(1, value));

export const resolveComposite = (style: CompositeStyle | undefined): Required<CompositeStyle> => ({
  blendMode: style?.blendMode ?? "normal",
  opacity: clampOpacity(style?.opacity),
});

/**
 * Flatten a retained layer tree without changing paint order. Opacity is
 * multiplied through ancestors; the nearest explicit blend mode wins.
 */
export const flattenCompositeLayers = (layers: readonly CompositeLayer[]): RenderCommand[] => {
  const output: RenderCommand[] = [];
  const visit = (layer: CompositeLayer, parentOpacity: number, parentBlendMode: BlendMode): void => {
    if (layer.visible === false) return;
    const opacity = parentOpacity * clampOpacity(layer.opacity);
    if (opacity <= 0) return;
    const blendMode = layer.blendMode ?? parentBlendMode;
    for (const command of layer.commands ?? []) {
      const commandComposite = resolveComposite(command.composite);
      output.push({
        ...command,
        composite: {
          blendMode: command.composite?.blendMode ?? blendMode,
          opacity: opacity * commandComposite.opacity,
        },
      });
    }
    for (const child of layer.children ?? []) visit(child, opacity, blendMode);
  };
  for (const layer of layers) visit(layer, 1, "normal");
  return output;
};
