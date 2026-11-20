/* eslint-disable */
// src/renderer/shaders/chains.ts — 各后期处理阶段的 GLSL 片元着色器
// 管线顺序：WB/曝光 → 高光滚降 → 景深 → 运动模糊 → 色差 → 暗角 → 噪点 → 锐化/衍射 → 色调映射输出

export const FRAG_WB_EXPOSURE = /* glsl */`
uniform sampler2D tDiffuse;
uniform sampler2D tDepth;
uniform vec3 uWbGain;
uniform float uExposureGain;
uniform float uDofPreviewBoost;
uniform float uCameraNear;
uniform float uCameraFar;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tDiffuse, vUv).rgb;
  c *= uWbGain;          // 白平衡增益（色温→RGB）
  c *= uExposureGain;    // 曝光三角：t·ISO/N²·2^EVcomp
  gl_FragColor = vec4(c, 1.0);
}
`;

export const FRAG_TONEMAP = /* glsl */`
uniform sampler2D tDiffuse;
uniform float uExposureGain;
uniform float uWbEnabled;
varying vec2 vUv;
// ACES 近似色调映射（Narkowicz 2015），将 HDR 线性值映射到 0..1 显示域
vec3 aces(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}
void main() {
  vec3 c = texture2D(tDiffuse, vUv).rgb;
  // 高光滚降：ACES 肩部天然压缩高光，避免硬 clamp
  c = aces(c);
  // 线性→sRGB
  c = pow(c, vec3(1.0/2.2));
  gl_FragColor = vec4(c, 1.0);
}
`;

/** 景深：基于深度纹理的 CoC 可变半径模糊（简化的可分离泊松盘） */
export const FRAG_DOF = /* glsl */`
uniform sampler2D tDiffuse;
uniform sampler2D tDepth;
uniform vec2 uTexel;
uniform float uNear, uFar;
uniform float uFocusDistance;  // 米
uniform float uAperture;       // N
uniform float uFocal;          // mm
uniform float uCocLimit;       // mm
uniform float uEnabled;
varying vec2 vUv;

float linearDepth(float d) {
  float z = d * 2.0 - 1.0;
  return (2.0 * uNear * uFar) / (uFar + uNear - z * (uFar - uNear));
}
void main() {
  vec3 center = texture2D(tDiffuse, vUv).rgb;
  if (uEnabled < 0.5) { gl_FragColor = vec4(center,1.0); return; }
  float dist = linearDepth(texture2D(tDepth, vUv).x);
  // CoC(mm) = f²·|s−s0| / (N·s0·(s−f))；换算为屏幕像素半径
  float f = uFocal;
  float s0 = max(uFocusDistance * 1000.0, f + 1.0);
  float s = max(dist * 1000.0, f + 1.0);
  float coc = abs(s - s0) * f * f / (uAperture * s0 * max(s - f, 1.0));
  float radiusPx = clamp(coc / uCocLimit * 2.0, 0.0, 16.0);
  if (radiusPx < 0.5) { gl_FragColor = vec4(center,1.0); return; }
  vec3 sum = center;
  float total = 1.0;
  const int N = 12;
  for (int i = 0; i < N; i++) {
    float a = float(i) * 2.39996323; // 黄金角螺旋
    float r = sqrt(float(i) / float(N));
    vec2 offset = vec2(cos(a), sin(a)) * r * radiusPx * uTexel;
    sum += texture2D(tDiffuse, vUv + offset).rgb;
    total += 1.0;
  }
  gl_FragColor = vec4(sum / total, 1.0);
}
`;

/** 运动模糊：沿屏幕速度方向的多点采样，长度 = 速度(UV/s) × 快门(s) */
export const FRAG_MOTION = /* glsl */`
uniform sampler2D tDiffuse;
uniform sampler2D tMask;
uniform vec2 uVelocity;   // UV/s
uniform float uShutter;   // s
uniform vec2 uTexel;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tDiffuse, vUv).rgb;
  float len = length(uVelocity) * uShutter;
  if (len < 0.0005) { gl_FragColor = vec4(c,1.0); return; }
  vec2 dir = normalize(uVelocity);
  float mask = texture2D(tMask, vUv).r;
  float samples = 1.0;
  vec3 sum = c;
  const int N = 12;
  for (int i = 1; i <= N; i++) {
    float t = float(i) / float(N) - 0.5;
    vec2 uv = vUv + dir * (t * len);
    vec3 s = texture2D(tDiffuse, clamp(uv, 0.0, 1.0)).rgb;
    float m = texture2D(tMask, clamp(uv, 0.0, 1.0)).r;
    // 只对运动物体区域（mask 高）施加拖影，静态背景保留
    float w = max(mask, m);
    sum = mix(sum, s, w * 0.85);
    samples += 1.0;
  }
  gl_FragColor = vec4(mix(c, sum / samples, min(1.0, len * 8.0 + mask * 0.5)), 1.0);
}
`;

/** 色差：在高对比边缘沿径向偏移 R/B 通道（横向色差近似） */
export const FRAG_CHROMATIC = /* glsl */`
uniform sampler2D tDiffuse;
uniform vec2 uTexel;
uniform float uStrength; // 随焦距增加
varying vec2 vUv;
void main() {
  vec2 dir = vUv - 0.5;
  float edge = length(dir);
  float lum = dot(texture2D(tDiffuse, vUv).rgb, vec3(0.299,0.587,0.114));
  // 与邻域亮度差（对比边缘）决定色差强度
  float n = dot(texture2D(tDiffuse, vUv + vec2(uTexel.x*2.0,0.0)).rgb, vec3(0.299,0.587,0.114));
  float contrast = clamp(abs(lum - n) * 4.0, 0.0, 1.0);
  vec2 off = dir * uStrength * edge * (0.4 + contrast) * uTexel * 6.0;
  float r = texture2D(tDiffuse, vUv + off).r;
  float g = texture2D(tDiffuse, vUv).g;
  float b = texture2D(tDiffuse, vUv - off).b;
  gl_FragColor = vec4(r,g,b,1.0);
}
`;

/** 暗角 + 畸变（桶形）：随光圈与焦距变化 */
export const FRAG_VIGNETTE = /* glsl */`
uniform sampler2D tDiffuse;
uniform float uStrength; // 暗角强度（大光圈更强）
uniform float uDistortion; // 畸变系数（随焦距）
varying vec2 vUv;
void main() {
  vec2 uv = vUv - 0.5;
  float r2 = dot(uv, uv);
  // 桶形畸变：r' = r·(1 + k·r²)
  vec2 distorted = uv * (1.0 + uDistortion * r2);
  vec2 sampleUv = distorted + 0.5;
  if (sampleUv.x < 0.0 || sampleUv.x > 1.0 || sampleUv.y < 0.0 || sampleUv.y > 1.0) {
    gl_FragColor = vec4(0.0,0.0,0.0,1.0); return;
  }
  vec3 c = texture2D(tDiffuse, sampleUv).rgb;
  // 暗角：cos^4 近似，f/1.4 更强
  float vig = pow(max(0.0, 1.0 - r2 * uStrength), 2.0);
  gl_FragColor = vec4(c * vig, 1.0);
}
`;

/** 噪点：散粒噪声(∝√signal) + ISO 增益放大的读出噪声，暗部与高 ISO 更明显 */
export const FRAG_NOISE = /* glsl */`
uniform sampler2D tDiffuse;
uniform float uIso;
uniform float uSensorScale; // 传感器越小噪点越强（P2 接口预留，当前=1）
uniform float uTime;
varying vec2 vUv;
float rand(vec2 co){ return fract(sin(dot(co, vec2(12.9898,78.233))) * 43758.5453); }
void main() {
  vec3 c = texture2D(tDiffuse, vUv).rgb;
  float lum = dot(c, vec3(0.2126,0.7152,0.0722));
  // ISO 相对 100 的增益，噪声标准差 ∝ sqrt(ISO/100)
  float isoGain = uIso / 100.0;
  float shot = sqrt(max(lum, 0.0)) * 0.012;              // 散粒噪声
  float read = 0.006 * sqrt(isoGain) * uSensorScale;       // 读出噪声
  float sigma = (shot + read) * (0.5 + 0.5 * sqrt(isoGain));
  vec2 seed = vUv * vec2(1024.0, 768.0) + uTime;
  // 亮度噪点 + 彩色噪点（色度通道幅度更小）
  float nY = (rand(seed) - 0.5) * 2.0 * sigma;
  float nU = (rand(seed + 17.3) - 0.5) * sigma * 0.6;
  float nV = (rand(seed + 43.7) - 0.5) * sigma * 0.6;
  c.r += nY + nV; c.g += nY - nU * 0.5; c.b += nY - nV;
  gl_FragColor = vec4(max(c, 0.0), 1.0);
}
`;

/** 锐化 + 衍射模糊：小光圈（大 N）时出现衍射软化，抵消部分锐化 */
export const FRAG_SHARPEN = /* glsl */`
uniform sampler2D tDiffuse;
uniform vec2 uTexel;
uniform float uDiffraction; // 衍射强度（0..1）
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tDiffuse, vUv).rgb;
  vec3 blur = (
    texture2D(tDiffuse, vUv + vec2(uTexel.x,0.0)).rgb +
    texture2D(tDiffuse, vUv - vec2(uTexel.x,0.0)).rgb +
    texture2D(tDiffuse, vUv + vec2(0.0,uTexel.y)).rgb +
    texture2D(tDiffuse, vUv - vec2(0.0,uTexel.y)).rgb
  ) * 0.25;
  // 衍射：小光圈模糊；锐化：unsharp mask
  vec3 diffracted = mix(c, blur, uDiffraction * 0.8);
  vec3 sharpened = diffracted + (diffracted - blur) * (0.35 * (1.0 - uDiffraction));
  gl_FragColor = vec4(clamp(sharpened, 0.0, 8.0), 1.0);
}
`;

/**
 * P1 果冻效应（电子快门逐行读出）：
 * 传感器自上而下逐行曝光，快门关闭前物体已移动，导致运动物体水平倾斜。
 * 用行位置 (vUv.y-0.5) 与屏幕速度做水平剪切近似；机械快门 strength=0。
 */
export const FRAG_JELLY = /* glsl */`
uniform sampler2D tDiffuse;
uniform float uStrength;   // 0..1，由 jellyEffectStrength 计算
uniform vec2 uVelocity;    // 运动物体屏幕速度 UV/s
uniform float uReadout;    // 传感器读出时间占比
varying vec2 vUv;
void main() {
  if (uStrength < 0.001) { gl_FragColor = texture2D(tDiffuse, vUv); return; }
  float row = vUv.y - 0.5;
  // 每行相对延迟 uReadout*strength，位移 = 速度 × 延迟
  vec2 shift = uVelocity * (row * uReadout * uStrength);
  vec3 c = texture2D(tDiffuse, clamp(vUv + shift, 0.0, 1.0)).rgb;
  gl_FragColor = vec4(c, 1.0);
}
`;

/**
 * P1 胶片模拟 / LUT 色彩风格（色调映射之后，非物理效果）：
 * 3x3 颜色矩阵 + lift/gamma/gain + 对比度 + 饱和度；可选 3D LUT 覆盖。
 * 与 src/camera/film.ts 的 CPU 参考实现一致，便于单测。
 *
 * LUT 采用 slice 图集（GLSL1 兼容，避免 sampler3D 在 WebGL2 ShaderMaterial 下的兼容问题）：
 * N 个 N×N 切片横向排成 (N*N)×N 的 2D 纹理，切片号 = b 通道层。
 * 手工做三线性插值：先在 b 方向取相邻两层，每层内做 r/g 双线性。
 */
export const FRAG_GRADE = /* glsl */`
uniform sampler2D tDiffuse;
uniform sampler2D uLut;
uniform float uLutEnabled;
uniform float uLutSize;
uniform mat3 uMatrix;
uniform vec3 uLift, uGamma, uGain;
uniform float uContrast, uSaturation;
varying vec2 vUv;

// 取一个格点：切片按 b 层横向排布，每层 N×N，r 为 x、g 为 y。
// 使用 NearestFilter，显式做 8 角点三线性插值，避免跨切片采样串色。
vec3 lutTexel(float bSlice, vec2 ij) {
  float N = uLutSize;
  vec2 uv = vec2((bSlice + ij.x + 0.5) / (N * N), (ij.y + 0.5) / N);
  return texture2D(uLut, uv).rgb;
}
vec3 sampleLut(vec3 c) {
  float N = uLutSize;
  vec3 f = clamp(c, 0.0, 1.0) * (N - 1.0);
  vec3 i0 = floor(f);
  vec3 i1 = min(i0 + 1.0, N - 1.0);
  vec3 t = f - i0;
  vec3 c000 = lutTexel(i0.b, i0.rg);
  vec3 c100 = lutTexel(i0.b, vec2(i1.r, i0.g));
  vec3 c010 = lutTexel(i0.b, vec2(i0.r, i1.g));
  vec3 c110 = lutTexel(i0.b, i1.rg);
  vec3 c001 = lutTexel(i1.b, i0.rg);
  vec3 c101 = lutTexel(i1.b, vec2(i1.r, i0.g));
  vec3 c011 = lutTexel(i1.b, vec2(i0.r, i1.g));
  vec3 c111 = lutTexel(i1.b, i1.rg);
  vec3 c00 = mix(c000, c100, t.r);
  vec3 c10 = mix(c010, c110, t.r);
  vec3 c01 = mix(c001, c101, t.r);
  vec3 c11 = mix(c011, c111, t.r);
  return mix(mix(c00, c10, t.g), mix(c01, c11, t.g), t.b);
}
void main() {
  vec3 c = texture2D(tDiffuse, vUv).rgb;
  c = clamp(uMatrix * c, 0.0, 1.0);
  c = uLift + pow(max(c, 0.0), 1.0 / max(uGamma, 0.01)) * uGain;
  c = clamp((c - 0.5) * uContrast + 0.5, 0.0, 1.0);
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, uSaturation);
  if (uLutEnabled > 0.5) c = sampleLut(clamp(c, 0.0, 1.0));
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`;

/**
 * P1 斑马纹过曝警告：亮度超过阈值的区域叠加 45° 移动斜纹。
 * 这是取景器辅助显示，不写入照片。
 */
export const FRAG_ZEBRA = /* glsl */`
uniform sampler2D tDiffuse;
uniform float uThreshold;
uniform float uTime;
uniform vec2 uResolution;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tDiffuse, vUv).rgb;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  if (l > uThreshold) {
    float stripe = step(0.5, fract((vUv.x * uResolution.x + vUv.y * uResolution.y) / 12.0 - uTime * 2.0));
    c = mix(c, vec3(1.0, 0.85, 0.0), stripe * 0.55);
  }
  gl_FragColor = vec4(c, 1.0);
}
`;

/**
 * P1 防抖：抑制手抖造成的整体模糊（近似）。
 * 对全局（非运动物体）施加一个极小的反向抖动补偿，降低有效快门造成的拖影。
 * 真实 IBIS 是传感器位移，这里以整体锐化/模糊混合近似，效果在数据面板中标注为近似。
 */
export const FRAG_STABILIZE = /* glsl */`
uniform sampler2D tDiffuse;
uniform vec2 uTexel;
uniform float uShake;      // 抖动幅度（像素），开启防抖后显著减小
uniform float uTime;
varying vec2 vUv;
void main() {
  if (uShake < 0.01) { gl_FragColor = texture2D(tDiffuse, vUv); return; }
  vec2 jitter = vec2(sin(uTime * 13.0), cos(uTime * 9.7)) * uShake * uTexel;
  vec3 c = texture2D(tDiffuse, clamp(vUv + jitter, 0.0, 1.0)).rgb;
  gl_FragColor = vec4(c, 1.0);
}
`;
