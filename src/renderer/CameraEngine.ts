// src/renderer/CameraEngine.ts — 主渲染循环：HDR 场景 → 可组合后期链 → 显示/测光/直方图/拍摄
// P1/P2：加入果冻效应、防抖、胶片模拟/LUT、斑马纹，并支持包围曝光 / 多曝光 HDR / RAW 线性数据读出。

import * as THREE from 'three';
import { TestScene } from '../scene/TestScene';
import { Pass, makePingPong } from './post/Pass';
import {
  FRAG_WB_EXPOSURE, FRAG_TONEMAP, FRAG_DOF, FRAG_MOTION, FRAG_CHROMATIC,
  FRAG_VIGNETTE, FRAG_NOISE, FRAG_SHARPEN, FRAG_JELLY, FRAG_GRADE,
  FRAG_ZEBRA, FRAG_STABILIZE,
} from './shaders/chains';
import { whiteBalanceGain } from '../camera/whiteBalance';
import { exposureGain, clamp, COC_LIMIT } from '../camera/physics';
import { meterScene } from '../camera/metering';
import {
  jellyEffectStrength, zebraThreshold, flashExposureEV, effectiveShutter,
} from '../camera/advanced';
import { filmGrade, parseCubeLUT, BUILTIN_LUTS } from '../camera/film';
import { sensorNoiseScale, diffractionBlurForSensor, SENSOR_PROFILES } from '../camera/optics';
import type { CameraSettings, Photo, FileFormat, PhotoExif } from '../types/camera';
import { useCameraStore, makeExif } from '../store/useCameraStore';

const CALIBRATION_K = 1000; // 曝光标定常数：使默认 f/5.6、1/125、ISO400 接近正确曝光
const RAW_W = 256; // RAW/HDR 线性读出分辨率（降采样以控制回读开销）
const RAW_H = 160;

function glMaxTextureSize(renderer: THREE.WebGLRenderer): number {
  const gl = renderer.getContext();
  return Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 4096;
}

const FRAG_COPY = /* glsl */`
uniform sampler2D tDiffuse;
varying vec2 vUv;
void main(){ gl_FragColor = texture2D(tDiffuse, vUv); }
`;
const FRAG_ENCODE_LUMA = /* glsl */`
uniform sampler2D tDiffuse;
varying vec2 vUv;
void main(){
  vec3 c = texture2D(tDiffuse, vUv).rgb;
  float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float e = sqrt(clamp(lum / 16.0, 0.0, 1.0));
  gl_FragColor = vec4(e, e, e, 1.0);
}
`;
/** 把线性 HDR（曝光后、色调映射前）编码进 RGBA8：每通道 e=sqrt(c/16)，CPU 端 c=16e²。 */
const FRAG_ENCODE_LINEAR = /* glsl */`
uniform sampler2D tDiffuse;
varying vec2 vUv;
void main(){
  vec3 c = texture2D(tDiffuse, vUv).rgb;
  vec3 e = sqrt(clamp(c / 16.0, 0.0, 1.0));
  gl_FragColor = vec4(e, 1.0);
}
`;
const FRAG_FOCUS_PEAK = /* glsl */`
uniform sampler2D tDiffuse;
uniform sampler2D tDepth;
uniform vec2 uTexel;
uniform float uNear, uFar, uFocus, uFocal, uAperture;
varying vec2 vUv;
float linearDepth(float d){
  float z = d * 2.0 - 1.0;
  return (2.0 * uNear * uFar) / (uFar + uNear - z * (uFar - uNear));
}
void main(){
  float dist = linearDepth(texture2D(tDepth, vUv).x);
  float f = uFocal, s0 = max(uFocus*1000.0, f+1.0), s = max(dist*1000.0, f+1.0);
  float coc = abs(s-s0)*f*f / (uAperture*s0*max(s-f,1.0));
  if (coc > 0.035) discard;
  float l = dot(texture2D(tDiffuse, vUv).rgb, vec3(0.299,0.587,0.114));
  float lx = dot(texture2D(tDiffuse, vUv+vec2(uTexel.x,0.0)).rgb, vec3(0.299,0.587,0.114));
  float edge = clamp(abs(l-lx)*5.0, 0.0, 1.0);
  gl_FragColor = vec4(1.0, 0.0, 1.0, edge * 0.65);
}
`;

export interface FrameCapture {
  dataUrl: string;
  rawLinear: Uint8Array; // 编码后的线性数据，CPU 解码 c=16*(v/255)^2
  width: number;
  height: number;
}

export class CameraEngine {
  readonly canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private testScene: TestScene;
  private sceneRT!: THREE.WebGLRenderTarget;
  private maskRT!: THREE.WebGLRenderTarget;
  private finalRT!: THREE.WebGLRenderTarget;
  private meterRT!: THREE.WebGLRenderTarget;
  private histRT!: THREE.WebGLRenderTarget;
  private rawRT!: THREE.WebGLRenderTarget;
  private pp!: { a: THREE.WebGLRenderTarget; b: THREE.WebGLRenderTarget };

  private wbPass!: Pass;
  private dofPass!: Pass;
  private motionPass!: Pass;
  private chromaPass!: Pass;
  private vignettePass!: Pass;
  private noisePass!: Pass;
  private sharpenPass!: Pass;
  private jellyPass!: Pass;
  private stabilizePass!: Pass;
  private tonePass!: Pass;
  private gradePass!: Pass;
  private zebraPass!: Pass;
  private copyPass!: Pass;
  private lumaPass!: Pass;
  private encodeRawPass!: Pass;
  private peakPass!: Pass;

  private width = 1;
  private height = 1;
  private quality: 'high' | 'medium' | 'low' = 'high';
  private raf = 0;
  private lastTime = 0;
  private frameCount = 0;
  private fpsTimer = 0;
  private disposed = false;
  private evOverride: number | null = null; // 包围曝光的临时 EV 偏移
  private lutTexture: THREE.DataTexture | null = null;
  private lutStateName = '';

  // 相机轨道控制状态
  private orbitTarget = new THREE.Vector3(0, 1.35, -4);
  private theta = 0;
  private phi = Math.PI / 2 - 0.03;
  private radius = 9.6;
  private dragging = false;
  private moved = false;
  private startX = 0;
  private startY = 0;

  constructor(container: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'gl-canvas';
    container.appendChild(this.canvas);

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas, antialias: false, alpha: false,
      powerPreference: 'high-performance', preserveDrawingBuffer: true,
    });
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace; // 我们在 tonemap pass 手动做 sRGB
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.autoClear = false;

    const gl = this.renderer.getContext();
    if (!(gl instanceof WebGL2RenderingContext)) {
      throw new Error('需要 WebGL2 支持：当前浏览器/设备无法创建 WebGL2 上下文。');
    }
    if (!gl.getExtension('EXT_color_buffer_float')) {
      console.warn('[相机] 缺少 EXT_color_buffer_float，HDR 渲染可能受限。');
    }

    this.testScene = new TestScene(1);
    this.buildPasses();
    this.resize();
    this.attachControls();

    const off = this.testScene.camera.position.clone().sub(this.orbitTarget);
    this.radius = off.length();
    this.theta = Math.atan2(off.x, off.z);
    this.phi = Math.acos(clamp(off.y / this.radius, -1, 1));

    this.lastTime = performance.now();
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
  }

  private buildPasses(): void {
    this.wbPass = new Pass('白平衡+曝光', FRAG_WB_EXPOSURE, {
      uWbGain: { value: new THREE.Vector3(1, 1, 1) },
      uExposureGain: { value: 1 },
      uDofPreviewBoost: { value: 1 },
      uCameraNear: { value: 0.05 }, uCameraFar: { value: 200 },
      tDepth: { value: null },
    });
    this.dofPass = new Pass('景深', FRAG_DOF, {
      uTexel: { value: new THREE.Vector2(1, 1) },
      uNear: { value: 0.05 }, uFar: { value: 200 },
      uFocusDistance: { value: 3.5 }, uAperture: { value: 5.6 }, uFocal: { value: 50 },
      uCocLimit: { value: 0.03 }, uEnabled: { value: 1 }, tDepth: { value: null },
    });
    this.motionPass = new Pass('运动模糊', FRAG_MOTION, {
      uVelocity: { value: new THREE.Vector2() }, uShutter: { value: 1 / 125 },
      uTexel: { value: new THREE.Vector2(1, 1) }, tMask: { value: null },
    });
    this.chromaPass = new Pass('色差', FRAG_CHROMATIC, {
      uTexel: { value: new THREE.Vector2(1, 1) }, uStrength: { value: 0.3 },
    });
    this.vignettePass = new Pass('暗角+畸变', FRAG_VIGNETTE, {
      uStrength: { value: 0.3 }, uDistortion: { value: 0 },
    });
    this.noisePass = new Pass('噪点', FRAG_NOISE, {
      uIso: { value: 400 }, uSensorScale: { value: 1 }, uTime: { value: 0 },
    });
    this.sharpenPass = new Pass('锐化+衍射', FRAG_SHARPEN, {
      uTexel: { value: new THREE.Vector2(1, 1) }, uDiffraction: { value: 0 },
    });
    this.jellyPass = new Pass('果冻效应', FRAG_JELLY, {
      uStrength: { value: 0 }, uVelocity: { value: new THREE.Vector2() }, uReadout: { value: 0.04 },
    });
    this.stabilizePass = new Pass('防抖', FRAG_STABILIZE, {
      uTexel: { value: new THREE.Vector2(1, 1) }, uShake: { value: 0 }, uTime: { value: 0 },
    });
    this.tonePass = new Pass('高光滚降+色调映射', FRAG_TONEMAP, {
      uExposureGain: { value: 1 }, uWbEnabled: { value: 1 },
    });
    this.gradePass = new Pass('胶片模拟+LUT', FRAG_GRADE, {
      uLut: { value: null }, uLutEnabled: { value: 0 }, uLutSize: { value: 2 },
      uMatrix: { value: new THREE.Matrix3() },
      uLift: { value: new THREE.Vector3() }, uGamma: { value: new THREE.Vector3(1, 1, 1) },
      uGain: { value: new THREE.Vector3(1, 1, 1) },
      uContrast: { value: 1 }, uSaturation: { value: 1 },
    });
    this.zebraPass = new Pass('斑马纹警告', FRAG_ZEBRA, {
      uThreshold: { value: 0.95 }, uTime: { value: 0 },
      uResolution: { value: new THREE.Vector2(1, 1) },
    });
    this.copyPass = new Pass('复制', FRAG_COPY, {});
    this.lumaPass = new Pass('亮度编码', FRAG_ENCODE_LUMA, {});
    this.encodeRawPass = new Pass('RAW 线性编码', FRAG_ENCODE_LINEAR, {});
    this.peakPass = new Pass('对焦峰值', FRAG_FOCUS_PEAK, {
      uTexel: { value: new THREE.Vector2(1, 1) },
      uNear: { value: 0.05 }, uFar: { value: 200 },
      uFocus: { value: 3.5 }, uFocal: { value: 50 }, uAperture: { value: 5.6 },
      tDepth: { value: null },
    });
  }

  setQuality(q: 'high' | 'medium' | 'low'): void {
    this.quality = q;
    this.resize();
  }

  resize(): void {
    const parent = this.canvas.parentElement;
    const rect = parent?.getBoundingClientRect();
    // 只读父容器的布局尺寸；绝不写 canvas 的 inline 像素尺寸——
    // 否则会与 flex 父容器 + ResizeObserver 形成正反馈循环，把渲染目标撑到数十万像素。
    const cssW = Math.max(280, Math.floor(rect?.width ?? 960));
    const cssH = Math.max(200, Math.floor(rect?.height ?? 540));
    const scale = this.quality === 'high' ? Math.min(devicePixelRatio || 1, 2)
      : this.quality === 'medium' ? Math.min(devicePixelRatio || 1, 1.5) * 0.85 : 0.7;
    const maxDim = Math.min(glMaxTextureSize(this.renderer), 4096);
    const w = Math.max(280, Math.min(maxDim, Math.floor(cssW * scale)));
    const h = Math.max(200, Math.min(maxDim, Math.floor(cssH * scale)));
    if (w === this.width && h === this.height && this.sceneRT) return;
    this.width = w;
    this.height = h;
    this.canvas.width = w;
    this.canvas.height = h;

    this.testScene?.setAspect(cssW / cssH);

    const hdrOpts: THREE.RenderTargetOptions = {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false,
    };
    this.sceneRT?.dispose(); this.maskRT?.dispose(); this.finalRT?.dispose();
    this.pp?.a.dispose(); this.pp?.b.dispose();
    this.meterRT?.dispose(); this.histRT?.dispose(); this.rawRT?.dispose();

    const depth = new THREE.DepthTexture(w, h, THREE.UnsignedIntType);
    this.sceneRT = new THREE.WebGLRenderTarget(w, h, { ...hdrOpts, depthBuffer: true, depthTexture: depth });
    this.maskRT = new THREE.WebGLRenderTarget(w, h, hdrOpts);
    this.finalRT = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.UnsignedByteType, format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false,
    });
    this.pp = makePingPong(w, h);
    this.meterRT = new THREE.WebGLRenderTarget(64, 40, {
      type: THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: false,
    });
    this.histRT = new THREE.WebGLRenderTarget(160, 100, {
      type: THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: false,
    });
    this.rawRT = new THREE.WebGLRenderTarget(RAW_W, RAW_H, {
      type: THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: false,
    });

    const texel = new THREE.Vector2(1 / w, 1 / h);
    for (const p of [this.dofPass, this.motionPass, this.chromaPass, this.sharpenPass,
      this.peakPass, this.stabilizePass]) {
      if (p.material.uniforms.uTexel) p.material.uniforms.uTexel.value.copy(texel);
    }
    this.zebraPass.material.uniforms.uResolution.value.set(w, h);
    (this.wbPass.material.uniforms.tDepth.value as THREE.Texture | null) = depth;
    this.dofPass.material.uniforms.tDepth.value = depth;
    this.peakPass.material.uniforms.tDepth.value = depth;
  }

  private attachControls(): void {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      this.dragging = true; this.moved = false;
      this.startX = e.clientX; this.startY = e.clientY;
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      const dx = e.clientX - this.startX;
      const dy = e.clientY - this.startY;
      if (Math.abs(dx) + Math.abs(dy) > 4) this.moved = true;
      if (this.moved) {
        this.theta -= dx * 0.005;
        this.phi = clamp(this.phi - dy * 0.005, 0.15, Math.PI - 0.15);
        this.startX = e.clientX; this.startY = e.clientY;
      }
    });
    c.addEventListener('pointerup', (e) => {
      this.dragging = false;
      if (!this.moved) {
        const rect = c.getBoundingClientRect();
        const nx = (e.clientX - rect.left) / rect.width;
        const ny = (e.clientY - rect.top) / rect.height;
        const st = useCameraStore.getState();
        st.setFocusPoint(nx, ny);
        if (st.settings.focusMode === 'auto') {
          st.setFocusDistance(this.testScene.autoFocusAt(nx, ny));
        }
      }
      try { c.releasePointerCapture(e.pointerId); } catch { /* 已释放 */ }
    });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.radius = clamp(this.radius * (1 + Math.sign(e.deltaY) * 0.08), 1.2, 40);
    }, { passive: false });
  }

  /** 把球面轨道坐标应用到相机 */
  private applyOrbit(): void {
    const s = Math.sin(this.phi);
    this.testScene.camera.position.set(
      this.orbitTarget.x + this.radius * s * Math.sin(this.theta),
      this.orbitTarget.y + this.radius * Math.cos(this.phi),
      this.orbitTarget.z + this.radius * s * Math.cos(this.theta),
    );
    this.testScene.camera.lookAt(this.orbitTarget);
    this.testScene.camera.updateMatrixWorld(true);
  }

  /** 渲染场景与整条后期链到 finalRT（不含显示叠层与测光）。供主循环与拍摄复用。 */
  private renderPipeline(dt: number, time: number): void {
    const st = useCameraStore.getState();
    const s = st.settings;
    const sc = st.scene;
    this.applyOrbit();
    this.testScene.update(dt, s, sc);
    this.updateUniforms(s, time, dt);

    // 1. 场景与遮罩（线性 HDR）
    this.renderer.setRenderTarget(this.sceneRT);
    this.renderer.clear(true, true, true);
    this.renderer.render(this.testScene.scene, this.testScene.camera);
    this.renderer.setRenderTarget(this.maskRT);
    this.renderer.clear(true, true, true);
    this.renderer.render(this.testScene.maskScene, this.testScene.camera);

    // 2. 后期链（ping-pong）
    let src: THREE.Texture = this.sceneRT.texture;
    const chain: Array<[Pass, THREE.WebGLRenderTarget]> = [
      [this.wbPass, this.pp.a],
      [this.dofPass, this.pp.b],
      [this.motionPass, this.pp.a],
      [this.chromaPass, this.pp.b],
      [this.vignettePass, this.pp.a],
      [this.noisePass, this.pp.b],
      [this.sharpenPass, this.pp.a],
      [this.jellyPass, this.pp.b],
      [this.stabilizePass, this.pp.a],
      [this.tonePass, this.pp.b],
      [this.gradePass, this.finalRT],
    ];
    for (let i = 0; i < chain.length; i++) {
      const [pass, target] = chain[i];
      pass.render(this.renderer, src, target);
      src = target.texture;
      // 白平衡+曝光之后立刻抓取曝光后的线性 HDR，供 RAW / HDR 使用
      if (i === 0) this.encodeRawPass.render(this.renderer, this.pp.a.texture, this.rawRT);
    }
  }

  private loop(now: number): void {
    if (this.disposed) return;
    const dt = Math.min(0.1, (now - this.lastTime) / 1000);
    this.lastTime = now;
    this.frameCount++;
    this.fpsTimer += dt;
    if (this.fpsTimer > 0.5) {
      useCameraStore.getState().setFps(Math.round(this.frameCount / this.fpsTimer));
      this.frameCount = 0; this.fpsTimer = 0;
    }

    this.renderPipeline(dt, now / 1000);
    const s = useCameraStore.getState().settings;

    // 3. 显示：斑马纹为取景器辅助叠层，不写入照片
    this.renderer.setRenderTarget(null);
    if (s.zebra) {
      this.zebraPass.material.uniforms.uTime.value = now / 1000;
      this.zebraPass.render(this.renderer, this.finalRT.texture, null);
    } else {
      this.copyPass.render(this.renderer, this.finalRT.texture, null);
    }
    if (s.focusPeak) {
      this.peakPass.material.transparent = true;
      this.peakPass.material.blending = THREE.AdditiveBlending;
      this.peakPass.render(this.renderer, this.finalRT.texture, null);
      this.peakPass.material.transparent = false;
      this.peakPass.material.blending = THREE.NormalBlending;
    }

    // 4. 测光与直方图（每 4 帧回读一次，降低 GPU stall）
    if (this.frameCount % 4 === 0) this.measure(s);

    this.raf = requestAnimationFrame(this.loop);
  }

  /** 构建/更新 LUT 图集纹理（N 个 N×N 切片横向排布），返回当前是否启用。 */
  private updateLutTexture(s: CameraSettings): boolean {
    const st = useCameraStore.getState();
    const name = s.lutName;
    if (!s.lutEnabled || name === 'None') {
      this.lutStateName = '';
      this.gradePass.material.uniforms.uLutEnabled.value = 0;
      return false;
    }
    if (name !== this.lutStateName || !this.lutTexture) {
      const text = st.customLuts[name] ?? BUILTIN_LUTS[name] ?? null;
      const parsed = text ? parseCubeLUT(text) : null;
      if (parsed) {
        const N = parsed.size;
        const w = N * N, h = N;
        const data = new Uint8Array(w * h * 4);
        for (let bi = 0; bi < N; bi++) {
          for (let gi = 0; gi < N; gi++) {
            for (let ri = 0; ri < N; ri++) {
              const src = ((bi * N + gi) * N + ri) * 3;
              const dst = (gi * w + bi * N + ri) * 4;
              data[dst] = Math.round(clamp(parsed.data[src], 0, 1) * 255);
              data[dst + 1] = Math.round(clamp(parsed.data[src + 1], 0, 1) * 255);
              data[dst + 2] = Math.round(clamp(parsed.data[src + 2], 0, 1) * 255);
              data[dst + 3] = 255;
            }
          }
        }
        this.lutTexture?.dispose();
        this.lutTexture = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
        this.lutTexture.minFilter = THREE.NearestFilter;
        this.lutTexture.magFilter = THREE.NearestFilter;
        this.lutTexture.wrapS = THREE.ClampToEdgeWrapping;
        this.lutTexture.wrapT = THREE.ClampToEdgeWrapping;
        this.lutTexture.generateMipmaps = false;
        this.lutTexture.needsUpdate = true;
        this.gradePass.material.uniforms.uLut.value = this.lutTexture;
        this.gradePass.material.uniforms.uLutSize.value = N;
        this.gradePass.material.uniforms.uLutEnabled.value = 1;
        this.lutStateName = name;
      } else {
        console.warn(`[相机] LUT「${name}」解析失败，回退为无 LUT。`);
        this.gradePass.material.uniforms.uLutEnabled.value = 0;
        this.lutStateName = '';
      }
    }
    return this.gradePass.material.uniforms.uLutEnabled.value > 0.5;
  }

  private updateUniforms(s: CameraSettings, time: number, dt: number): void {
    const wbg = whiteBalanceGain(s.wbTemp, s.wbTint);
    const tEff = effectiveShutter(s.shutter, s.ndStops);
    let gain = exposureGain(s.aperture, s.shutter, s.iso, s.exposureComp)
      / Math.pow(2, s.ndStops) * CALIBRATION_K;
    // 包围曝光 EV 偏移
    if (this.evOverride !== null) gain *= Math.pow(2, this.evOverride);
    // 闪光（近似）：以对焦距离作为主体距离，反平方 + 输出功率折算为额外曝光增益
    if (s.flashEnabled) {
      const fev = flashExposureEV(s.flashPowerEV, s.focusDistance, s.iso, s.aperture);
      gain *= Math.pow(2, clamp(fev, -6, 6) * 0.5); // 0.5 权重避免闪光主导
    }

    this.wbPass.material.uniforms.uWbGain.value.set(wbg[0], wbg[1], wbg[2]);
    this.wbPass.material.uniforms.uExposureGain.value = gain;

    const d = this.dofPass.material.uniforms;
    d.uNear.value = this.testScene.camera.near; d.uFar.value = this.testScene.camera.far;
    d.uFocusDistance.value = s.focusDistance; d.uAperture.value = s.aperture; d.uFocal.value = s.focalLength;
    d.uEnabled.value = 1; // 景深是真实成像效果，始终开启；景深预览仅增强可视化
    d.uCocLimit.value = s.dofPreview ? COC_LIMIT / 1.6 : COC_LIMIT; // 景深预览放大模糊圈便于观察

    const m = this.motionPass.material.uniforms;
    const vel = this.testScene.getScreenVelocity(dt);
    m.uVelocity.value.set(vel.x, vel.y);
    m.uShutter.value = tEff;
    m.tMask.value = this.maskRT.texture;

    const c = this.chromaPass.material.uniforms;
    c.uStrength.value = clamp((s.focalLength - 24) / 46 * 0.55 + 0.05, 0.05, 0.6);

    const v = this.vignettePass.material.uniforms;
    // 大光圈暗角更强；焦距越短桶形畸变越明显，长焦轻微枕形
    v.uStrength.value = clamp(0.12 + (4 / s.aperture) * 0.22, 0.12, 0.55);
    v.uDistortion.value = clamp((50 - s.focalLength) / 50 * 0.06, -0.03, 0.06);

    const n = this.noisePass.material.uniforms;
    n.uIso.value = s.iso; n.uTime.value = time;
    n.uSensorScale.value = sensorNoiseScale(s.sensor); // P2：小传感器噪点更明显

    const sh = this.sharpenPass.material.uniforms;
    // 瑞利判据：2.44·λ·N（λ=0.55μm），按传感器裁切系数缩放（P2）
    sh.uDiffraction.value = clamp((diffractionBlurForSensor(s.aperture, s.sensor) - 6) / 48, 0, 1);

    const j = this.jellyPass.material.uniforms;
    j.uStrength.value = jellyEffectStrength(s.shutterType, tEff);
    j.uVelocity.value.set(vel.x, vel.y);
    j.uReadout.value = 0.04;

    const stb = this.stabilizePass.material.uniforms;
    // 手抖幅度：慢快门更大；防抖开启后大幅减小（近似）
    stb.uShake.value = s.stabilization ? 0.25 : clamp(tEff * 45, 0, 2.4);
    stb.uTime.value = time;

    this.zebraPass.material.uniforms.uThreshold.value = zebraThreshold();

    // 胶片模拟：把 CPU 端参数映射到 GLSL uniform
    const grade = filmGrade(s.filmSim);
    const g = this.gradePass.material.uniforms;
    const m3 = g.uMatrix.value as THREE.Matrix3;
    m3.set(grade.matrix[0], grade.matrix[1], grade.matrix[2],
      grade.matrix[3], grade.matrix[4], grade.matrix[5],
      grade.matrix[6], grade.matrix[7], grade.matrix[8]);
    (g.uLift.value as THREE.Vector3).setScalar(grade.lift);
    (g.uGamma.value as THREE.Vector3).set(grade.gamma, grade.gamma, grade.gamma);
    (g.uGain.value as THREE.Vector3).setScalar(grade.gain);
    g.uContrast.value = grade.contrast;
    g.uSaturation.value = grade.saturation;
    this.updateLutTexture(s);

    const p = this.peakPass.material.uniforms;
    p.uNear.value = this.testScene.camera.near; p.uFar.value = this.testScene.camera.far;
    p.uFocus.value = s.focusDistance; p.uFocal.value = s.focalLength; p.uAperture.value = s.aperture;
  }

  /** 从 HDR 场景（曝光前）读取测光亮度，从最终图像读取直方图 */
  private measure(s: CameraSettings): void {
    this.lumaPass.render(this.renderer, this.sceneRT.texture, this.meterRT);
    const meterBuf = new Uint8Array(64 * 40 * 4);
    this.renderer.readRenderTargetPixels(this.meterRT, 0, 0, 64, 40, meterBuf);
    const grid = new Float32Array(64 * 40);
    for (let i = 0; i < grid.length; i++) {
      const e = meterBuf[i * 4] / 255;
      grid[i] = 16 * e * e; // 解码回线性亮度
    }
    const result = meterScene(
      { width: 64, height: 40, data: grid }, s.metering, s.aperture, s.iso, s.focusPoint,
    );
    useCameraStore.getState().setMeter(result.ev, result.suggestedShutter);

    this.copyPass.render(this.renderer, this.finalRT.texture, this.histRT);
    const histBuf = new Uint8Array(160 * 100 * 4);
    this.renderer.readRenderTargetPixels(this.histRT, 0, 0, 160, 100, histBuf);
    const BINS = 64;
    const hist = { r: new Array(BINS).fill(0), g: new Array(BINS).fill(0), b: new Array(BINS).fill(0), luma: new Array(BINS).fill(0) };
    let over = 0, under = 0;
    const total = 160 * 100;
    for (let i = 0; i < total; i++) {
      const r = histBuf[i * 4], g = histBuf[i * 4 + 1], b = histBuf[i * 4 + 2];
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      hist.r[Math.min(BINS - 1, (r * BINS) >> 8)]++;
      hist.g[Math.min(BINS - 1, (g * BINS) >> 8)]++;
      hist.b[Math.min(BINS - 1, (b * BINS) >> 8)]++;
      hist.luma[Math.min(BINS - 1, (l * BINS) >> 8)]++;
      if (l >= 252) over++;
      if (l <= 4) under++;
    }
    useCameraStore.getState().setHistogram(hist, over / total, under / total);
  }

  /** 自动对焦画面中心，返回对焦距离（米） */
  autoFocusCenter(): number {
    return this.testScene.autoFocusAt(0.5, 0.5);
  }

  /** 读取 finalRT 显示为 dataURL（上下翻转修正 WebGL 原点）。 */
  private readDisplay(): string {
    const buf = new Uint8Array(this.width * this.height * 4);
    this.renderer.readRenderTargetPixels(this.finalRT, 0, 0, this.width, this.height, buf);
    const row = this.width * 4;
    const flipped = new Uint8ClampedArray(buf.length);
    for (let y = 0; y < this.height; y++) {
      flipped.set(buf.subarray((this.height - 1 - y) * row, (this.height - y) * row), y * row);
    }
    const cv = document.createElement('canvas');
    cv.width = this.width; cv.height = this.height;
    cv.getContext('2d')!.putImageData(new ImageData(flipped, this.width, this.height), 0, 0);
    const fmt: FileFormat = useCameraStore.getState().settings.fileFormat;
    return cv.toDataURL(fmt === 'raw' ? 'image/png' : 'image/jpeg', fmt === 'raw' ? 1 : 0.92);
  }

  /** 读取编码后的线性 HDR 数据（RAW / HDR 用）。 */
  private readRawEncoded(): Uint8Array {
    const buf = new Uint8Array(RAW_W * RAW_H * 4);
    this.renderer.readRenderTargetPixels(this.rawRT, 0, 0, RAW_W, RAW_H, buf);
    return buf;
  }

  /**
   * 带 EV 偏移抓取一帧：用于包围曝光与 HDR。
   * 临时改写曝光增益、同步重渲染管线，读取显示帧与线性帧，随后恢复。
   */
  captureWithEV(evOffset: number): FrameCapture {
    this.evOverride = evOffset;
    this.renderPipeline(0, performance.now() / 1000);
    this.evOverride = null;
    return {
      dataUrl: this.readDisplay(),
      rawLinear: this.readRawEncoded(),
      width: this.width,
      height: this.height,
    };
  }

  /** 拍摄：读取最终帧并生成带 EXIF 的照片对象（保留 P0 接口）。 */
  capture(extraExif: Partial<PhotoExif> = {}): Photo {
    const fmt = useCameraStore.getState().settings.fileFormat;
    const frame = this.captureWithEV(0);
    return {
      id: `photo-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      dataUrl: frame.dataUrl,
      exif: makeExif(useCameraStore.getState().settings, extraExif),
      width: frame.width,
      height: frame.height,
      format: fmt,
      rawLinear: fmt === 'raw' ? frame.rawLinear : undefined,
    };
  }

  /** 由线性编码数据构造 RAW/HDR 预览照片（CPU 端 ACES + sRGB）。 */
  makeLinearPhoto(
    linear: Uint8Array | Float32Array,
    encoded: boolean,
    exif: Partial<PhotoExif>,
  ): Photo {
    const cv = document.createElement('canvas');
    cv.width = RAW_W; cv.height = RAW_H;
    const ctx = cv.getContext('2d')!;
    const img = ctx.createImageData(RAW_W, RAW_H);
    for (let i = 0; i < RAW_W * RAW_H; i++) {
      const src = i * 4;
      const rgb = [0, 1, 2].map((ch) => {
        const v = encoded ? 16 * Math.pow((linear as Uint8Array)[src + ch] / 255, 2)
          : (linear as Float32Array)[src + ch];
        const x = clamp(v, 0, 16);
        const aces = clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0, 1);
        return Math.round(Math.pow(aces, 1 / 2.2) * 255);
      });
      img.data[i * 4] = rgb[0];
      img.data[i * 4 + 1] = rgb[1];
      img.data[i * 4 + 2] = rgb[2];
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return {
      id: `photo-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      dataUrl: cv.toDataURL('image/png'),
      exif: makeExif(useCameraStore.getState().settings, exif),
      width: RAW_W, height: RAW_H,
      format: 'raw',
      rawLinear: encoded ? new Uint8Array(linear as Uint8Array) : undefined,
    };
  }

  /** 供外部读取传感器裁切系数（水平仪/信息面板） */
  getCropFactor(): number {
    return SENSOR_PROFILES[useCameraStore.getState().settings.sensor]?.crop ?? 1;
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.sceneRT.dispose(); this.maskRT.dispose(); this.finalRT.dispose();
    this.pp.a.dispose(); this.pp.b.dispose();
    this.meterRT.dispose(); this.histRT.dispose(); this.rawRT.dispose();
    this.lutTexture?.dispose();
    for (const p of [this.wbPass, this.dofPass, this.motionPass, this.chromaPass,
      this.vignettePass, this.noisePass, this.sharpenPass, this.jellyPass, this.stabilizePass,
      this.tonePass, this.gradePass, this.zebraPass, this.copyPass, this.lumaPass,
      this.encodeRawPass, this.peakPass]) p.dispose();
    this.renderer.dispose();
  }
}
