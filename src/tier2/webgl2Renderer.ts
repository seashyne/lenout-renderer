import { createCanvasDpiController } from "../dpi.js";
import { resolveComposite } from "../compositor.js";
import type { LenoutCapabilities, LenoutRenderer, LenoutRendererOptions } from "../renderer.js";
import type { BlendMode, RenderCommand, RenderTile, Color, StrokeStyle, Vec2 } from "../types.js";
import { circlePoints, ellipsePoints } from "../pathParser.js";
import { triangulate, buildTriangleVertices, fanTriangulate } from "../triangulate.js";
import { sharedVectorPathCache } from "../vectorPath.js";
import { createTextBitmapCache } from "../tier3/textBitmapCache.js";

/**
 * Tier 2 — WebGL 2 renderer.
 *
 * GPU-accelerated 2D with scissor-based tile clipping.
 * Brush dabs rendered via instanced quads with a shared brush-tip texture.
 */

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------

const VERTEX_SHADER = `#version 300 es
in vec2 a_position;
in vec2 a_texCoord;
uniform mat3 u_transform;
out vec2 v_texCoord;
void main() {
  vec3 pos = u_transform * vec3(a_position, 1.0);
  gl_Position = vec4(pos.xy, 0.0, 1.0);
  v_texCoord = a_texCoord;
}`;

const RECT_FRAGMENT = `#version 300 es
precision highp float;
uniform vec4 u_color;
out vec4 fragColor;
void main() {
  fragColor = u_color;
}`;

const IMAGE_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_texCoord;
uniform sampler2D u_texture;
uniform float u_opacity;
out vec4 fragColor;
void main() {
  fragColor = texture(u_texture, v_texCoord) * u_opacity;
}`;

const BRUSH_VERTEX = `#version 300 es
in vec2 a_position;
in vec2 a_texCoord;
// Per-instance attributes
in vec2 a_offset;
in float a_size;
in vec4 a_color;
in float a_opacity;
in float a_rotation;
uniform vec2 u_canvasSize;
out vec2 v_texCoord;
out vec4 v_color;
out float v_opacity;
void main() {
  // Rotate and scale the unit quad, then translate to world position
  float c = cos(a_rotation);
  float s = sin(a_rotation);
  vec2 scaled = a_position * a_size;
  vec2 rotated = vec2(scaled.x * c - scaled.y * s, scaled.x * s + scaled.y * c);
  vec2 worldPos = rotated + a_offset;
  // Convert world-space to NDC
  vec2 ndc = vec2(
    (worldPos.x / u_canvasSize.x) * 2.0 - 1.0,
    1.0 - (worldPos.y / u_canvasSize.y) * 2.0
  );
  gl_Position = vec4(ndc, 0.0, 1.0);
  v_texCoord = a_texCoord;
  v_color = a_color;
  v_opacity = a_opacity;
}`;

const BRUSH_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_texCoord;
in vec4 v_color;
in float v_opacity;
uniform sampler2D u_brushTip;
out vec4 fragColor;
void main() {
  float alpha = texture(u_brushTip, v_texCoord).a;
  fragColor = v_color * (alpha * v_opacity);
}`;

/** Fullscreen blit: copies accumulation texture to main canvas */
const BLIT_VERTEX = `#version 300 es
in vec2 a_position;
in vec2 a_texCoord;
out vec2 v_texCoord;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
  v_texCoord = a_texCoord;
}`;

const BLIT_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_texCoord;
uniform sampler2D u_source;
out vec4 fragColor;
void main() {
  fragColor = texture(u_source, v_texCoord);
}`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const colorToFloats = ([r, g, b, a]: Color): Float32Array =>
  new Float32Array([r, g, b, a]);

const withOpacity = (color: Color, opacity: number): Color => [color[0], color[1], color[2], color[3] * opacity];

const QUAD_POSITIONS = new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]);
const QUAD_TEXCOORDS = new Float32Array([0, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 0]);

const rectTransform = (
  dstX: number, dstY: number, dstW: number, dstH: number,
  canvasW: number, canvasH: number,
): Float32Array => {
  const sx = dstW / canvasW;
  const sy = dstH / canvasH;
  const tx = (2 * dstX + dstW) / canvasW - 1;
  const ty = 1 - (2 * dstY + dstH) / canvasH;
  return new Float32Array([sx, 0, 0, 0, sy, 0, tx, ty, 1]);
};

const compileShader = (gl: WebGL2RenderingContext, type: number, source: string): WebGLShader => {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Lenout Renderer: shader compile failed — ${info}`);
  }
  return shader;
};

const linkProgram = (gl: WebGL2RenderingContext, vs: WebGLShader, fs: WebGLShader): WebGLProgram => {
  const program = gl.createProgram()!;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`Lenout Renderer: program link failed — ${info}`);
  }
  return program;
};

/** Generate a soft circular brush tip texture */
const createBrushTipTexture = (gl: WebGL2RenderingContext, size: number): WebGLTexture => {
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const tctx = c.getContext("2d")!;
  const half = size / 2;
  const grad = tctx.createRadialGradient(half, half, 0, half, half, half);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.5, "rgba(255,255,255,0.9)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  tctx.fillStyle = grad;
  tctx.fillRect(0, 0, size, size);

  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
  return tex;
};

// ---------------------------------------------------------------------------
// Renderer factory
// ---------------------------------------------------------------------------

export const createWebGL2Renderer = (
  canvas: HTMLCanvasElement,
  capabilities: LenoutCapabilities,
  options: LenoutRendererOptions = {},
): LenoutRenderer => {
  const display = createCanvasDpiController(canvas, options);
  const runtime = {
    state: "ready" as const,
    resourceRevision: 0,
    deviceLosses: 0,
    lastDeviceLoss: null,
    ai: { backend: capabilities.neuralBackend, completedTasks: 0, failedTasks: 0, pendingTasks: 0 },
  };
  const gl = canvas.getContext("webgl2", {
    alpha: false,
    antialias: false,
    premultipliedAlpha: true,
  });
  if (!gl) throw new Error("Lenout Renderer: WebGL 2 context not available");

  // Shared geometry buffers
  const posBuffer = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, QUAD_POSITIONS, gl.STATIC_DRAW);

  const texCoordBuffer = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, QUAD_TEXCOORDS, gl.STATIC_DRAW);

  // Shader programs (lazy-init in initialize())
  let rectProgram: WebGLProgram;
  let imageProgram: WebGLProgram;
  let brushProgram: WebGLProgram;
  let blitProgram: WebGLProgram;
  let brushTipTexture: WebGLTexture;

  // Uniform locations
  let rectUColor: WebGLUniformLocation;
  let rectUTransform: WebGLUniformLocation;
  let imgUTransform: WebGLUniformLocation;
  let imgUTexture: WebGLUniformLocation;
  let imgUOpacity: WebGLUniformLocation;
  let brushUCanvasSize: WebGLUniformLocation;
  let brushUBrushTip: WebGLUniformLocation;

  // VAOs
  let rectVAO: WebGLVertexArrayObject;
  let imageVAO: WebGLVertexArrayObject;
  let brushVAO: WebGLVertexArrayObject;
  let blitVAO: WebGLVertexArrayObject;

  // Accumulation: offscreen framebuffer + texture
  let accumFB: WebGLFramebuffer;
  let accumTexture: WebGLTexture;
  let accumW = 0;
  let accumH = 0;

  // Instance buffer for brush dabs
  let instanceBuffer: WebGLBuffer;
  const MAX_INSTANCES = 4096;

  // Texture cache for images
  const textureCache = new Map<ImageBitmap, WebGLTexture>();

  const getTexture = (src: ImageBitmap): WebGLTexture => {
    const existing = textureCache.get(src);
    if (existing) return existing;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    textureCache.set(src, tex);
    return tex;
  };
  const textCache = createTextBitmapCache(128, (source) => {
    const texture = textureCache.get(source);
    if (texture) gl.deleteTexture(texture);
    textureCache.delete(source);
  }, () => display.metrics.pixelRatio);

  const applyBlendMode = (mode: BlendMode): void => {
    gl.blendEquation(gl.FUNC_ADD);
    if (mode === "add") gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    else if (mode === "multiply") gl.blendFunc(gl.DST_COLOR, gl.ONE_MINUS_SRC_ALPHA);
    else if (mode === "screen") gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_COLOR);
    else gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  };

  const setupVAOs = (): void => {
    rectVAO = gl.createVertexArray()!;
    gl.bindVertexArray(rectVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    imageVAO = gl.createVertexArray()!;
    gl.bindVertexArray(imageVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);

    brushVAO = gl.createVertexArray()!;
    gl.bindVertexArray(brushVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);
    // Instance attributes (bound to instanceBuffer later)
    const stride = 10 * 4; // 10 floats per instance
    gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
    // a_offset (vec2) at location 2
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, stride, 0);
    gl.vertexAttribDivisor(2, 1);
    // a_size (float) at location 3
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 1, gl.FLOAT, false, stride, 8);
    gl.vertexAttribDivisor(3, 1);
    // a_color (vec4) at location 4
    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(4, 4, gl.FLOAT, false, stride, 12);
    gl.vertexAttribDivisor(4, 1);
    // a_opacity (float) at location 5
    gl.enableVertexAttribArray(5);
    gl.vertexAttribPointer(5, 1, gl.FLOAT, false, stride, 28);
    gl.vertexAttribDivisor(5, 1);
    // a_rotation (float) at location 6
    gl.enableVertexAttribArray(6);
    gl.vertexAttribPointer(6, 1, gl.FLOAT, false, stride, 32);
    gl.vertexAttribDivisor(6, 1);
  };

  /** Upload brush dab data to instance buffer and draw instanced */
  const drawBrushDabs = (dabs: { x: number; y: number; size: number; color: Color; opacity: number; rotation: number }[], opacity: number): void => {
    if (dabs.length === 0) return;
    const count = Math.min(dabs.length, MAX_INSTANCES);
    const data = new Float32Array(count * 10);
    for (let i = 0; i < count; i++) {
      const d = dabs[i]!;
      const off = i * 10;
      data[off] = d.x;
      data[off + 1] = d.y;
      data[off + 2] = d.size;
      data[off + 3] = d.color[0];
      data[off + 4] = d.color[1];
      data[off + 5] = d.color[2];
      data[off + 6] = d.color[3];
      data[off + 7] = d.opacity * opacity;
      data[off + 8] = d.rotation;
      data[off + 9] = 0; // padding
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);

    gl.useProgram(brushProgram);
    gl.bindVertexArray(brushVAO);
    gl.uniform2f(brushUCanvasSize, display.metrics.logicalWidth, display.metrics.logicalHeight);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, brushTipTexture);
    gl.uniform1i(brushUBrushTip, 0);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);
  };

  return {
    capabilities,
    runtime,
    get display() {
      return display.metrics;
    },
    resize(width, height, pixelRatio) {
      return display.resize(width, height, pixelRatio);
    },

    initialize(): void {
      const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
      rectProgram = linkProgram(gl, vs, compileShader(gl, gl.FRAGMENT_SHADER, RECT_FRAGMENT));
      imageProgram = linkProgram(gl, vs, compileShader(gl, gl.FRAGMENT_SHADER, IMAGE_FRAGMENT));
      const bvs = compileShader(gl, gl.VERTEX_SHADER, BRUSH_VERTEX);
      brushProgram = linkProgram(gl, bvs, compileShader(gl, gl.FRAGMENT_SHADER, BRUSH_FRAGMENT));
      const blitVS = compileShader(gl, gl.VERTEX_SHADER, BLIT_VERTEX);
      blitProgram = linkProgram(gl, blitVS, compileShader(gl, gl.FRAGMENT_SHADER, BLIT_FRAGMENT));

      rectUColor = gl.getUniformLocation(rectProgram, "u_color")!;
      rectUTransform = gl.getUniformLocation(rectProgram, "u_transform")!;
      imgUTransform = gl.getUniformLocation(imageProgram, "u_transform")!;
      imgUTexture = gl.getUniformLocation(imageProgram, "u_texture")!;
      imgUOpacity = gl.getUniformLocation(imageProgram, "u_opacity")!;
      brushUCanvasSize = gl.getUniformLocation(brushProgram, "u_canvasSize")!;
      brushUBrushTip = gl.getUniformLocation(brushProgram, "u_brushTip")!;

      instanceBuffer = gl.createBuffer()!;
      brushTipTexture = createBrushTipTexture(gl, 128);
      setupVAOs();

      // Blit VAO
      blitVAO = gl.createVertexArray()!;
      gl.bindVertexArray(blitVAO);
      gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);

      // Accumulation framebuffer
      accumFB = gl.createFramebuffer()!;
      accumTexture = gl.createTexture()!;
    },

    beginFrame(): void {
      // Resize accumulation surface if canvas changed
      const w = canvas.width;
      const h = canvas.height;
      if (w !== accumW || h !== accumH) {
        gl.bindTexture(gl.TEXTURE_2D, accumTexture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, accumFB);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, accumTexture, 0);
        accumW = w;
        accumH = h;
      }

      // Bind accumulation framebuffer — all tile rendering goes here
      gl.bindFramebuffer(gl.FRAMEBUFFER, accumFB);
      gl.viewport(0, 0, w, h);
    },

    renderTile(tile: RenderTile, commands: RenderCommand[], isDirty: boolean): void {
      if (!isDirty) return; // Clean tile: accumulation already has correct content

      const w = display.metrics.logicalWidth;
      const h = display.metrics.logicalHeight;
      const ratio = display.metrics.pixelRatio;

      // Scissor to tile bounds (WebGL Y is bottom-up)
      gl.enable(gl.SCISSOR_TEST);
      const left = Math.max(0, Math.floor(tile.worldX * ratio));
      const top = Math.max(0, Math.floor(tile.worldY * ratio));
      const right = Math.min(canvas.width, Math.ceil((tile.worldX + tile.size) * ratio));
      const bottom = Math.min(canvas.height, Math.ceil((tile.worldY + tile.size) * ratio));
      gl.scissor(left, canvas.height - bottom, Math.max(0, right - left), Math.max(0, bottom - top));

      // Clear tile area
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);

      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

      /** Convert world-space vertices to NDC + draw as triangles with color */
      const drawShapeFill = (verts: Float32Array, color: Color): void => {
        const ndc = new Float32Array(verts.length);
        for (let i = 0; i < verts.length; i += 2) {
          ndc[i] = (verts[i]! / w) * 2 - 1;
          ndc[i + 1] = 1 - (verts[i + 1]! / h) * 2;
        }
        const buf = gl.createBuffer()!;
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, ndc, gl.DYNAMIC_DRAW);
        gl.useProgram(rectProgram);
        gl.bindVertexArray(rectVAO);
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        gl.uniform4fv(rectUColor, colorToFloats(color));
        gl.uniformMatrix3fv(rectUTransform, false, new Float32Array([1,0,0,0,1,0,0,0,1]));
        gl.drawArrays(gl.TRIANGLES, 0, ndc.length / 2);
        gl.deleteBuffer(buf);
      };

      const drawPolyline = (points: readonly Vec2[], stroke: StrokeStyle, closed: boolean, opacity: number): void => {
        if (points.length < 2 || stroke.width <= 0) return;
        const ndc = new Float32Array(points.length * 2);
        for (let index = 0; index < points.length; index++) {
          ndc[index * 2] = (points[index]!.x / w) * 2 - 1;
          ndc[index * 2 + 1] = 1 - (points[index]!.y / h) * 2;
        }
        const buffer = gl.createBuffer()!;
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, ndc, gl.DYNAMIC_DRAW);
        gl.lineWidth(stroke.width * ratio);
        gl.useProgram(rectProgram);
        gl.bindVertexArray(rectVAO);
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        gl.uniform4fv(rectUColor, colorToFloats(withOpacity(stroke.color, opacity)));
        gl.uniformMatrix3fv(rectUTransform, false, new Float32Array([1,0,0,0,1,0,0,0,1]));
        gl.drawArrays(closed ? gl.LINE_LOOP : gl.LINE_STRIP, 0, points.length);
        gl.deleteBuffer(buffer);
      };

      for (const cmd of commands) {
        const composite = resolveComposite(cmd.composite);
        if (composite.opacity <= 0) continue;
        applyBlendMode(composite.blendMode);
        switch (cmd.type) {
          case "clear": {
            gl.clearColor(cmd.color[0], cmd.color[1], cmd.color[2], cmd.color[3] * composite.opacity);
            gl.clear(gl.COLOR_BUFFER_BIT);
            break;
          }
          case "rect": {
            if (cmd.fill) {
              gl.useProgram(rectProgram);
              gl.bindVertexArray(rectVAO);
              gl.uniform4fv(rectUColor, colorToFloats(withOpacity(cmd.fill, composite.opacity)));
              gl.uniformMatrix3fv(rectUTransform, false, rectTransform(cmd.dst.x, cmd.dst.y, cmd.dst.width, cmd.dst.height, w, h));
              gl.drawArrays(gl.TRIANGLES, 0, 6);
            }
            if (cmd.stroke) drawPolyline([
              { x: cmd.dst.x, y: cmd.dst.y },
              { x: cmd.dst.x + cmd.dst.width, y: cmd.dst.y },
              { x: cmd.dst.x + cmd.dst.width, y: cmd.dst.y + cmd.dst.height },
              { x: cmd.dst.x, y: cmd.dst.y + cmd.dst.height },
            ], cmd.stroke, true, composite.opacity);
            break;
          }
          case "circle": {
            const outline = circlePoints(cmd.cx, cmd.cy, cmd.radius, 48);
            if (cmd.fill) {
              const points = [{ x: cmd.cx, y: cmd.cy }, ...outline];
              drawShapeFill(buildTriangleVertices(points, fanTriangulate(points[0]!, outline)), withOpacity(cmd.fill, composite.opacity));
            }
            if (cmd.stroke) drawPolyline(outline, cmd.stroke, true, composite.opacity);
            break;
          }
          case "ellipse": {
            const outline = ellipsePoints(cmd.cx, cmd.cy, cmd.rx, cmd.ry, 48);
            if (cmd.fill) {
              const points = [{ x: cmd.cx, y: cmd.cy }, ...outline];
              drawShapeFill(buildTriangleVertices(points, fanTriangulate(points[0]!, outline)), withOpacity(cmd.fill, composite.opacity));
            }
            if (cmd.stroke) drawPolyline(outline, cmd.stroke, true, composite.opacity);
            break;
          }
          case "line": {
            drawPolyline([{ x: cmd.x1, y: cmd.y1 }, { x: cmd.x2, y: cmd.y2 }], { color: cmd.color, width: cmd.width }, false, composite.opacity);
            break;
          }
          case "polyline":
            drawPolyline(cmd.points, cmd.stroke, false, composite.opacity);
            break;
          case "polygon": {
            if (cmd.fill && cmd.points.length >= 3) {
              drawShapeFill(buildTriangleVertices(cmd.points, triangulate(cmd.points)), withOpacity(cmd.fill, composite.opacity));
            }
            if (cmd.stroke) drawPolyline(cmd.points, cmd.stroke, true, composite.opacity);
            break;
          }
          case "path": {
            for (const contour of sharedVectorPathCache.get(cmd.d).contours) {
              if (cmd.fill && contour.points.length >= 3) {
                drawShapeFill(buildTriangleVertices(contour.points, triangulate(contour.points)), withOpacity(cmd.fill, composite.opacity));
              }
              if (cmd.stroke) drawPolyline(contour.points, cmd.stroke, contour.closed, composite.opacity);
            }
            break;
          }
          case "image": {
            gl.useProgram(imageProgram);
            gl.bindVertexArray(imageVAO);
            gl.uniformMatrix3fv(imgUTransform, false, rectTransform(cmd.dst.x, cmd.dst.y, cmd.dst.width, cmd.dst.height, w, h));
            gl.uniform1i(imgUTexture, 0);
            gl.uniform1f(imgUOpacity, cmd.opacity * composite.opacity);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, getTexture(cmd.src));
            gl.drawArrays(gl.TRIANGLES, 0, 6);
            break;
          }
          case "text": {
            const text = textCache.get(cmd);
            if (!text) break;
            gl.useProgram(imageProgram);
            gl.bindVertexArray(imageVAO);
            gl.uniformMatrix3fv(imgUTransform, false, rectTransform(text.destination.x, text.destination.y, text.destination.width, text.destination.height, w, h));
            gl.uniform1i(imgUTexture, 0);
            gl.uniform1f(imgUOpacity, composite.opacity);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, getTexture(text.source));
            gl.drawArrays(gl.TRIANGLES, 0, 6);
            break;
          }
          case "brushDabs": {
            drawBrushDabs(cmd.dabs, composite.opacity);
            break;
          }
        }
      }

      gl.disable(gl.SCISSOR_TEST);
    },

    endFrame(): void {
      // Blit accumulation texture to main canvas
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.disable(gl.SCISSOR_TEST);
      gl.disable(gl.BLEND);

      gl.useProgram(blitProgram);
      gl.bindVertexArray(blitVAO);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, accumTexture);
      gl.uniform1i(gl.getUniformLocation(blitProgram, "u_source")!, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      textCache.sweep();
    },

    destroy(): void {
      textCache.destroy();
      for (const tex of textureCache.values()) gl.deleteTexture(tex);
      textureCache.clear();
      gl.deleteTexture(brushTipTexture);
      gl.deleteTexture(accumTexture);
      gl.deleteFramebuffer(accumFB);
      gl.deleteProgram(rectProgram);
      gl.deleteProgram(imageProgram);
      gl.deleteProgram(brushProgram);
      gl.deleteProgram(blitProgram);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
};
