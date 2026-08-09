export const SOLID_SHADER = /* wgsl */ `
struct CanvasUniforms {
  size: vec2<f32>,
  inverseSize: vec2<f32>,
}
@group(0) @binding(0) var<uniform> canvas: CanvasUniforms;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
}

@vertex
fn vertexMain(
  @location(0) position: vec2<f32>,
  @location(1) color: vec4<f32>,
) -> VertexOutput {
  var output: VertexOutput;
  output.position = vec4<f32>(
    position.x * canvas.inverseSize.x * 2.0 - 1.0,
    1.0 - position.y * canvas.inverseSize.y * 2.0,
    0.0,
    1.0,
  );
  output.color = color;
  return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  return vec4<f32>(input.color.rgb * input.color.a, input.color.a);
}
`;

export const IMAGE_SHADER = /* wgsl */ `
struct CanvasUniforms {
  size: vec2<f32>,
  inverseSize: vec2<f32>,
}
@group(0) @binding(0) var<uniform> canvas: CanvasUniforms;
@group(1) @binding(0) var sourceTexture: texture_2d<f32>;
@group(1) @binding(1) var sourceSampler: sampler;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) opacity: f32,
}

@vertex
fn vertexMain(
  @location(0) position: vec2<f32>,
  @location(1) uv: vec2<f32>,
  @location(2) opacity: f32,
) -> VertexOutput {
  var output: VertexOutput;
  output.position = vec4<f32>(
    position.x * canvas.inverseSize.x * 2.0 - 1.0,
    1.0 - position.y * canvas.inverseSize.y * 2.0,
    0.0,
    1.0,
  );
  output.uv = uv;
  output.opacity = opacity;
  return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  let sampled = textureSample(sourceTexture, sourceSampler, input.uv);
  let alpha = sampled.a * input.opacity;
  return vec4<f32>(sampled.rgb * alpha, alpha);
}
`;

export const BRUSH_SHADER = /* wgsl */ `
struct CanvasUniforms {
  size: vec2<f32>,
  inverseSize: vec2<f32>,
}
@group(0) @binding(0) var<uniform> canvas: CanvasUniforms;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) localPosition: vec2<f32>,
  @location(1) color: vec4<f32>,
  @location(2) hardness: f32,
  @location(3) opacity: f32,
}

@vertex
fn vertexMain(
  @location(0) quadPosition: vec2<f32>,
  @location(1) center: vec2<f32>,
  @location(2) size: f32,
  @location(3) hardness: f32,
  @location(4) color: vec4<f32>,
  @location(5) opacity: f32,
  @location(6) rotation: f32,
) -> VertexOutput {
  let cosine = cos(rotation);
  let sine = sin(rotation);
  let local = quadPosition * size * 0.5;
  let rotated = vec2<f32>(
    local.x * cosine - local.y * sine,
    local.x * sine + local.y * cosine,
  );
  let position = center + rotated;
  var output: VertexOutput;
  output.position = vec4<f32>(
    position.x * canvas.inverseSize.x * 2.0 - 1.0,
    1.0 - position.y * canvas.inverseSize.y * 2.0,
    0.0,
    1.0,
  );
  output.localPosition = quadPosition;
  output.color = color;
  output.hardness = hardness;
  output.opacity = opacity;
  return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  let distanceFromCenter = length(input.localPosition);
  let antialias = max(fwidth(distanceFromCenter), 0.001);
  let hardEdge = clamp(input.hardness, 0.0, 0.999);
  let coverage = 1.0 - smoothstep(max(0.0, hardEdge - antialias), 1.0 + antialias, distanceFromCenter);
  let alpha = coverage * clamp(input.opacity, 0.0, 1.0) * input.color.a;
  return vec4<f32>(input.color.rgb * alpha, alpha);
}
`;
