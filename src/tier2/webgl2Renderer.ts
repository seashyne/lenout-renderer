import { createCanvasDpiController } from "../dpi.js";
import type { LenoutCapabilities, LenoutRenderer, LenoutRendererOptions } from "../renderer.js";
import type { RenderCommand, RenderTile, Color, Vec2 } from "../types.js";
import { circlePoints, ellipsePoints, tessellatePath, parsePath } from "../pathParser.js";
import { triangulate, buildTriangleVertices, fanTriangulate } from "../triangulate.js";

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
  const drawBrushDabs = (dabs: { x: number; y: number; size: number; color: Color; opacity: number; rotation: number }[]): void => {
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
      data[off + 7] = d.opacity;
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

      for (const cmd of commands) {
        switch (cmd.type) {
          case "clear": {
            gl.clearColor(cmd.color[0], cmd.color[1], cmd.color[2], cmd.color[3]);
            gl.clear(gl.COLOR_BUFFER_BIT);
            break;
          }
          case "rect": {
            gl.useProgram(rectProgram);
            gl.bindVertexArray(rectVAO);
            gl.uniform4fv(rectUColor, colorToFloats(cmd.fill));
            gl.uniformMatrix3fv(rectUTransform, false, rectTransform(cmd.dst.x, cmd.dst.y, cmd.dst.width, cmd.dst.height, w, h));
            gl.drawArrays(gl.TRIANGLES, 0, 6);
            break;
          }
          case "circle": {
            const pts = [
              { x: cmd.cx, y: cmd.cy },
              ...circlePoints(cmd.cx, cmd.cy, cmd.radius, 32),
            ];
            const idx = fanTriangulate(pts[0]!, pts.slice(1));
            drawShapeFill(buildTriangleVertices(pts, idx), cmd.fill);
            break;
          }
          case "ellipse": {
            const pts = [
              { x: cmd.cx, y: cmd.cy },
              ...ellipsePoints(cmd.cx, cmd.cy, cmd.rx, cmd.ry, 32),
            ];
            const idx = fanTriangulate(pts[0]!, pts.slice(1));
            drawShapeFill(buildTriangleVertices(pts, idx), cmd.fill);
            break;
          }
          case "line": {
            const lineVerts = new Float32Array([cmd.x1, cmd.y1, cmd.x2, cmd.y2]);
            const ndc = new Float32Array(4);
            for (let i = 0; i < 4; i += 2) {
              ndc[i] = (lineVerts[i]! / w) * 2 - 1;
              ndc[i + 1] = 1 - (lineVerts[i + 1]! / h) * 2;
            }
            const buf = gl.createBuffer()!;
            gl.bindBuffer(gl.ARRAY_BUFFER, buf);
            gl.bufferData(gl.ARRAY_BUFFER, ndc, gl.DYNAMIC_DRAW);
            gl.lineWidth(cmd.width * ratio);
            gl.useProgram(rectProgram);
            gl.bindVertexArray(rectVAO);
            gl.bindBuffer(gl.ARRAY_BUFFER, buf);
            gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
            gl.uniform4fv(rectUColor, colorToFloats(cmd.color));
            gl.uniformMatrix3fv(rectUTransform, false, new Float32Array([1,0,0,0,1,0,0,0,1]));
            gl.drawArrays(gl.LINES, 0, 2);
            gl.deleteBuffer(buf);
            break;
          }
          case "polygon":
          case "path": {
            const points: Vec2[] = cmd.type === "polygon"
              ? cmd.points
              : tessellatePath(parsePath(cmd.d), 16).flat();
            if (points.length < 3) break;
            const idx = triangulate(points);
            drawShapeFill(buildTriangleVertices(points, idx), cmd.fill);
            break;
          }
          case "image": {
            gl.useProgram(imageProgram);
            gl.bindVertexArray(imageVAO);
            gl.uniformMatrix3fv(imgUTransform, false, rectTransform(cmd.dst.x, cmd.dst.y, cmd.dst.width, cmd.dst.height, w, h));
            gl.uniform1i(imgUTexture, 0);
            gl.uniform1f(imgUOpacity, cmd.opacity);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, getTexture(cmd.src));
            gl.drawArrays(gl.TRIANGLES, 0, 6);
            break;
          }
          case "text": {
            // Fallback: render text via Canvas 2D, then draw as image
            const c = document.createElement("canvas");
            const textWidth = 512;
            const textHeight = 64;
            c.width = Math.ceil(textWidth * ratio);
            c.height = Math.ceil(textHeight * ratio);
            const tctx = c.getContext("2d")!;
            tctx.setTransform(ratio, 0, 0, ratio, 0, 0);
            tctx.font = cmd.font || "24px sans-serif";
            tctx.fillStyle = `rgba(${Math.round(cmd.color[0] * 255)},${Math.round(cmd.color[1] * 255)},${Math.round(cmd.color[2] * 255)},${cmd.color[3]})`;
            tctx.textBaseline = "top";
            tctx.fillText(cmd.text, 4, 4);

            const tex = gl.createTexture()!;
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);

            gl.useProgram(imageProgram);
            gl.bindVertexArray(imageVAO);
            gl.uniformMatrix3fv(imgUTransform, false, rectTransform(cmd.x, cmd.y, textWidth, textHeight, w, h));
            gl.uniform1i(imgUTexture, 0);
            gl.uniform1f(imgUOpacity, 1);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.drawArrays(gl.TRIANGLES, 0, 6);
            gl.deleteTexture(tex);
            break;
          }
          case "brushDabs": {
            drawBrushDabs(cmd.dabs);
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
    },

    destroy(): void {
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
