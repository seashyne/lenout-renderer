import type { LenoutCapabilities, LenoutRenderer } from "../renderer.js";
import type { RenderCommand, RenderTile, Color } from "../types.js";

/**
 * Tier 1 — Canvas 2D renderer (CPU only).
 *
 * Tile-aware software rendering. Dirty tiles are cleared and re-rendered
 * with clipping; clean tiles are left untouched on the canvas.
 */

/** Convert a Color tuple to a CSS rgba string */
const colorToCSS = ([r, g, b, a]: Color): string =>
  `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${a})`;

/** Draw a rounded rectangle path (does not fill/stroke) */
const roundRect = (
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
): void => {
  const cr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + cr, y);
  ctx.lineTo(x + w - cr, y);
  ctx.arcTo(x + w, y, x + w, y + cr, cr);
  ctx.lineTo(x + w, y + h - cr);
  ctx.arcTo(x + w, y + h, x + w - cr, y + h, cr);
  ctx.lineTo(x + cr, y + h);
  ctx.arcTo(x, y + h, x, y + h - cr, cr);
  ctx.lineTo(x, y + cr);
  ctx.arcTo(x, y, x + cr, y, cr);
  ctx.closePath();
};

export const createCanvas2DRenderer = (
  canvas: HTMLCanvasElement,
  capabilities: LenoutCapabilities,
): LenoutRenderer => {
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("Lenout Renderer: Canvas 2D context not available");

  /** Execute a single render command relative to the tile origin */
  const executeCommand = (cmd: RenderCommand, tile: RenderTile): void => {
    switch (cmd.type) {
      case "clear": {
        ctx.fillStyle = colorToCSS(cmd.color);
        ctx.fillRect(tile.worldX, tile.worldY, tile.size, tile.size);
        break;
      }
      case "rect": {
        if (cmd.radius > 0) {
          roundRect(ctx, cmd.dst.x, cmd.dst.y, cmd.dst.width, cmd.dst.height, cmd.radius);
          ctx.fillStyle = colorToCSS(cmd.fill);
          ctx.fill();
        } else {
          ctx.fillStyle = colorToCSS(cmd.fill);
          ctx.fillRect(cmd.dst.x, cmd.dst.y, cmd.dst.width, cmd.dst.height);
        }
        break;
      }
      case "image": {
        ctx.globalAlpha = cmd.opacity;
        ctx.drawImage(cmd.src, cmd.dst.x, cmd.dst.y, cmd.dst.width, cmd.dst.height);
        ctx.globalAlpha = 1;
        break;
      }
      case "text": {
        ctx.font = cmd.font || "14px sans-serif";
        ctx.fillStyle = colorToCSS(cmd.color);
        ctx.textBaseline = "top";
        ctx.fillText(cmd.text, cmd.x, cmd.y);
        break;
      }
      case "brushDabs": {
        for (const dab of cmd.dabs) {
          ctx.save();
          ctx.globalAlpha = dab.opacity;
          ctx.translate(dab.x, dab.y);
          ctx.rotate(dab.rotation);

          const half = dab.size / 2;
          const grad = ctx.createRadialGradient(0, 0, half * dab.hardness, 0, 0, half);
          grad.addColorStop(0, colorToCSS(dab.color));
          grad.addColorStop(1, "rgba(0,0,0,0)");
          ctx.fillStyle = grad;
          ctx.fillRect(-half, -half, dab.size, dab.size);
          ctx.restore();
        }
        break;
      }
      case "circle": {
        ctx.beginPath();
        ctx.arc(cmd.cx, cmd.cy, cmd.radius, 0, Math.PI * 2);
        ctx.fillStyle = colorToCSS(cmd.fill);
        ctx.fill();
        if (cmd.stroke) {
          ctx.strokeStyle = colorToCSS(cmd.stroke.color);
          ctx.lineWidth = cmd.stroke.width;
          ctx.stroke();
        }
        break;
      }
      case "ellipse": {
        ctx.beginPath();
        ctx.ellipse(cmd.cx, cmd.cy, cmd.rx, cmd.ry, 0, 0, Math.PI * 2);
        ctx.fillStyle = colorToCSS(cmd.fill);
        ctx.fill();
        if (cmd.stroke) {
          ctx.strokeStyle = colorToCSS(cmd.stroke.color);
          ctx.lineWidth = cmd.stroke.width;
          ctx.stroke();
        }
        break;
      }
      case "line": {
        ctx.beginPath();
        ctx.moveTo(cmd.x1, cmd.y1);
        ctx.lineTo(cmd.x2, cmd.y2);
        ctx.strokeStyle = colorToCSS(cmd.color);
        ctx.lineWidth = cmd.width;
        ctx.stroke();
        break;
      }
      case "polygon": {
        if (cmd.points.length < 2) break;
        ctx.beginPath();
        ctx.moveTo(cmd.points[0]!.x, cmd.points[0]!.y);
        for (let i = 1; i < cmd.points.length; i++) {
          ctx.lineTo(cmd.points[i]!.x, cmd.points[i]!.y);
        }
        ctx.closePath();
        ctx.fillStyle = colorToCSS(cmd.fill);
        ctx.fill();
        if (cmd.stroke) {
          ctx.strokeStyle = colorToCSS(cmd.stroke.color);
          ctx.lineWidth = cmd.stroke.width;
          ctx.stroke();
        }
        break;
      }
      case "path": {
        const p = new Path2D(cmd.d);
        ctx.fillStyle = colorToCSS(cmd.fill);
        ctx.fill(p);
        if (cmd.stroke) {
          ctx.strokeStyle = colorToCSS(cmd.stroke.color);
          ctx.lineWidth = cmd.stroke.width;
          ctx.stroke(p);
        }
        break;
      }
    }
  };

  return {
    capabilities,

    initialize(): void {
      // Canvas 2D needs no GPU init
    },

    beginFrame(): void {
      // Don't clear — clean tiles retain their content
    },

    renderTile(tile: RenderTile, commands: RenderCommand[], isDirty: boolean): void {
      if (!isDirty) return; // Clean tile: canvas already has correct content

      // Clear only this tile
      ctx.clearRect(tile.worldX, tile.worldY, tile.size, tile.size);

      // Clip rendering to tile bounds
      ctx.save();
      ctx.beginPath();
      ctx.rect(tile.worldX, tile.worldY, tile.size, tile.size);
      ctx.clip();

      for (const cmd of commands) {
        executeCommand(cmd, tile);
      }

      ctx.restore();
    },

    endFrame(): void {
      // No-op for Canvas 2D
    },

    destroy(): void {
      // No GPU resources to release
    },
  };
};
