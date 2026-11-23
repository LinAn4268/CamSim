// src/scene/TestScene.ts — 贴近真实拍摄的室内场景：窗光、静物台、人像主体、背景书墙与远处门洞
//
// 设计目标（与“几个彩色球摆一排”的测试场景不同）：
//   1. 具备真实影棚/居家布光的层次 —— 主光来自侧窗，补光来自环境与台灯，远处有暖色门洞形成轮廓光；
//   2. 材质有真实粗糙度/金属度差异（木地板、乳胶漆墙、陶瓷、玻璃、纸、织物），而不是纯色塑料；
//   3. 近 / 中 / 远三段都有内容，便于验证浅景深、景深预览、对焦与运动模糊；
//   4. 颜色标板 + 灰卡是真实的摄影参照物，用于检验白平衡与测光；
//   5. 唯一的运动物体是摆动的吊灯（高光强、易观察拖影），且其白色版本渲染到 maskScene 供运动模糊使用。

import * as THREE from 'three';
import type { SceneSettings, CameraSettings } from '../types/camera';
import { kelvinToRGB } from '../camera/whiteBalance';
import { fieldOfView, SENSOR } from '../camera/physics';
import { SENSOR_PROFILES } from '../camera/optics';

/** P2：按传感器 id 取裁切系数（全画幅=1）。 */
function cropFactor(sensor: CameraSettings['sensor']): number {
  return SENSOR_PROFILES[sensor]?.crop ?? 1;
}

export interface ScreenVelocity { x: number; y: number; active: boolean }

/** 确定性伪随机：同一个场景每次加载纹理完全一致，便于比对截图。 */
function makeRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 用 Canvas 画一张程序化纹理（不依赖任何外部图片资源）。服务端/无 document 时返回 null。 */
function proceduralTexture(
  draw: (ctx: CanvasRenderingContext2D, size: number) => void,
  size = 256,
): THREE.Texture | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  draw(ctx, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

/** 木地板：深色橡木，板缝 + 木纹。 */
function woodTexture(): THREE.Texture | null {
  return proceduralTexture((ctx, size) => {
    const rnd = makeRandom(20240501);
    ctx.fillStyle = '#6b4a32';
    ctx.fillRect(0, 0, size, size);
    const planks = 6;
    const ph = size / planks;
    for (let i = 0; i < planks; i++) {
      const shade = 0.82 + rnd() * 0.3;
      const r = Math.round(107 * shade);
      const g = Math.round(74 * shade);
      const b = Math.round(50 * shade);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(0, i * ph, size, ph - 1);
      // 木纹丝
      ctx.strokeStyle = `rgba(40,26,16,${0.10 + rnd() * 0.12})`;
      ctx.lineWidth = 1;
      for (let k = 0; k < 26; k++) {
        const y = i * ph + rnd() * ph;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.bezierCurveTo(size * 0.3, y + (rnd() - 0.5) * 6, size * 0.7, y + (rnd() - 0.5) * 6, size, y + (rnd() - 0.5) * 4);
        ctx.stroke();
      }
      // 板缝
      ctx.fillStyle = 'rgba(24,16,10,0.75)';
      ctx.fillRect(0, i * ph + ph - 2, size, 2);
    }
  }, 512);
}

/** 乳胶漆墙面：极细噪点，避免纯色带来的塑料感。 */
function plasterTexture(): THREE.Texture | null {
  return proceduralTexture((ctx, size) => {
    const rnd = makeRandom(77123);
    ctx.fillStyle = '#c9c3b8';
    ctx.fillRect(0, 0, size, size);
    for (let i = 0; i < 5200; i++) {
      const a = 0.03 + rnd() * 0.05;
      ctx.fillStyle = rnd() > 0.5 ? `rgba(255,255,255,${a})` : `rgba(90,84,76,${a})`;
      ctx.fillRect(rnd() * size, rnd() * size, 1, 1);
    }
  }, 256);
}

/** 织物（桌布/沙发）：经纬交叉的细微明暗。 */
function fabricTexture(): THREE.Texture | null {
  return proceduralTexture((ctx, size) => {
    const rnd = makeRandom(424242);
    ctx.fillStyle = '#9a958c';
    ctx.fillRect(0, 0, size, size);
    for (let y = 0; y < size; y += 3) {
      ctx.fillStyle = `rgba(255,255,255,${0.04 + rnd() * 0.03})`;
      ctx.fillRect(0, y, size, 1);
    }
    for (let x = 0; x < size; x += 3) {
      ctx.fillStyle = `rgba(60,58,54,${0.04 + rnd() * 0.03})`;
      ctx.fillRect(x, 0, 1, size);
    }
  }, 128);
}

/** 24 色标准色卡（近似 ColorChecker 的 4×6 排列），真实摄影参照物。 */
function colorChartTexture(): THREE.Texture | null {
  return proceduralTexture((ctx, size) => {
    const patches = [
      '#735244', '#c29682', '#627a9d', '#576c43', '#8580b1', '#67bdaa',
      '#d67e2c', '#505ba6', '#c15a63', '#5e3c6c', '#9dbc40', '#e0a32e',
      '#383d96', '#469449', '#af363c', '#e7c71f', '#bb5695', '#0885a1',
      '#f3f3f2', '#c8c8c8', '#a0a0a0', '#7a7a79', '#555555', '#343434',
    ];
    const cols = 6;
    const rows = 4;
    const pad = size * 0.03;
    const cw = (size - pad * 2) / cols;
    const ch = (size - pad * 2) / rows;
    ctx.fillStyle = '#2b2b2b';
    ctx.fillRect(0, 0, size, size);
    patches.forEach((c, i) => {
      const cx = pad + (i % cols) * cw;
      const cy = pad + Math.floor(i / cols) * ch;
      ctx.fillStyle = c;
      ctx.fillRect(cx + 2, cy + 2, cw - 4, ch - 4);
    });
  }, 384);
}

/** 窗外的天空/远景：上亮下暗的渐变色块，作为窗玻璃的自发光颜色。 */
function skyTexture(): THREE.Texture | null {
  return proceduralTexture((ctx, size) => {
    const g = ctx.createLinearGradient(0, 0, 0, size);
    g.addColorStop(0, '#eaf1f7');
    g.addColorStop(0.55, '#cfdde8');
    g.addColorStop(1, '#9fb0a4');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    // 远景楼体/树影的模糊剪影，避免窗户是一块死白
    const rnd = makeRandom(90210);
    for (let i = 0; i < 14; i++) {
      const w = size * (0.06 + rnd() * 0.16);
      const h = size * (0.08 + rnd() * 0.34);
      ctx.fillStyle = `rgba(110,122,118,${0.12 + rnd() * 0.12})`;
      ctx.fillRect(rnd() * size, size - h, w, h);
    }
  }, 256);
}

export class TestScene {
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  maskScene = new THREE.Scene(); // 仅运动物体的白色遮罩，用于运动模糊

  private movingPivot = new THREE.Group();
  private maskPivot = new THREE.Group();
  private keyLight = new THREE.DirectionalLight(0xffffff, 3);
  private ambient = new THREE.HemisphereLight(0xe8eef7, 0xaa9f92, 0.35);
  private windowLight = new THREE.DirectionalLight(0xdce9f5, 0);
  private lampLight = new THREE.PointLight(0xffb173, 0, 9, 2);
  private lampShade: THREE.Mesh;
  /** 所有「天空自发光」平面（左墙侧窗 + 背墙小窗）：只提供亮度，不参与自动对焦 */
  private skyPanels: THREE.Mesh[] = [];
  private time = 0;
  private prevWorld = new THREE.Vector3();
  private currWorld = new THREE.Vector3();
  // 复用临时对象，避免每帧在渲染循环里产生垃圾（运动速度可达 60 次/秒）
  private tmpDelta = new THREE.Vector3();
  private tmpNdcCurr = new THREE.Vector3();
  private tmpNdcPrev = new THREE.Vector3();
  private focusRay = new THREE.Raycaster();
  private focusNdc = new THREE.Vector2();

  constructor(aspect: number) {
    this.scene.background = new THREE.Color(0x15171a);
    this.camera = new THREE.PerspectiveCamera(50, aspect, 0.05, 200);
    this.camera.position.set(0, 1.55, 5.5);
    this.camera.lookAt(0, 1.35, -4);

    // ================= 光照骨架 =================
    // 主光：侧窗（方向光，色温由场景设置驱动），从左前方斜射入室
    this.scene.add(this.ambient);
    this.scene.add(this.keyLight);
    this.keyLight.position.set(4, 6, 4);
    // 窗光作为“轮廓/冷调补光”，默认关闭强度，随主光联动一点点，避免过平
    this.windowLight.position.set(-6, 4.4, -1);
    this.scene.add(this.windowLight);
    // 台灯（实用光源）：暖色点光，形成背景暖调与高光
    this.lampLight.position.set(2.35, 1.45, -3.2);
    this.scene.add(this.lampLight);
    this.lampShade = new THREE.Mesh(
      new THREE.SphereGeometry(0.17, 20, 12),
      new THREE.MeshStandardMaterial({ color: 0xfff0d6, emissive: 0xffb46b, emissiveIntensity: 2.2, roughness: 0.9 }),
    );
    this.lampShade.position.copy(this.lampLight.position);
    this.scene.add(this.lampShade);

    // ================= 房间：地板 / 墙 / 天花 =================
    const wood = woodTexture();
    if (wood) wood.repeat.set(3, 5);
    const floorMat = new THREE.MeshStandardMaterial({
      color: wood ? 0xffffff : 0x6b4a32, map: wood ?? undefined, roughness: 0.62, metalness: 0.02,
    });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(9, 13), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, 0, -1.5);
    this.scene.add(floor);

    const plaster = plasterTexture();
    if (plaster) plaster.repeat.set(2, 1);
    const wallMat = new THREE.MeshStandardMaterial({
      color: plaster ? 0xffffff : 0xc9c3b8, map: plaster ?? undefined, roughness: 0.94, metalness: 0,
    });
    // 背墙（z=-7.2）：挂画与门洞都在这面墙上
    const backWall = new THREE.Mesh(new THREE.PlaneGeometry(9, 3.4), wallMat);
    backWall.position.set(0, 1.7, -7.2);
    this.scene.add(backWall);
    // 左墙（窗）
    const leftWall = new THREE.Mesh(new THREE.PlaneGeometry(13, 3.4), wallMat.clone());
    leftWall.position.set(-4.2, 1.7, -1.5);
    leftWall.rotation.y = Math.PI / 2;
    this.scene.add(leftWall);
    // 右墙
    const rightWall = new THREE.Mesh(new THREE.PlaneGeometry(13, 3.4), wallMat.clone());
    rightWall.position.set(4.2, 1.7, -1.5);
    rightWall.rotation.y = -Math.PI / 2;
    this.scene.add(rightWall);
    // 天花
    // 注意：天花板法线朝下，方向光只能照到上表面，穹顶/半球光的「地面色」才是它的主要光源。
    // 纯材质反照率下它会比墙面暗 2~3 档，因此给一点点自发光模拟室内墙面/地面的漫反射回弹，
    // 否则画面顶部会压成一条接近全黑的色带（看起来像天花缺失）。
    const ceiling = new THREE.Mesh(
      new THREE.PlaneGeometry(9, 13),
      new THREE.MeshStandardMaterial({ color: 0xd6d2ca, roughness: 1, emissive: 0x5a544c, emissiveIntensity: 1 }),
    );
    ceiling.rotation.x = Math.PI / 2;
    ceiling.position.set(0, 3.4, -1.5);
    this.scene.add(ceiling);
    // 踢脚线
    const skirtMat = new THREE.MeshStandardMaterial({ color: 0xe8e4da, roughness: 0.7 });
    const skirt = new THREE.Mesh(new THREE.BoxGeometry(9, 0.12, 0.04), skirtMat);
    skirt.position.set(0, 0.06, -7.18);
    this.scene.add(skirt);

    // ================= 左墙侧窗（真实光源入口 + 高光参照）=================
    // 窗洞：内凹的窗框 + 自发光玻璃。玻璃亮度 > 1，用来检验高光滚降。
    const frameMat = new THREE.MeshStandardMaterial({ color: 0xf2efe8, roughness: 0.55, metalness: 0.02 });
    const windowX = -4.16;
    const winW = 2.1;
    const winH = 1.55;
    const winY = 1.85;
    const winZ = -2.2;
    const glassMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(winW - 0.1, winH - 0.1), glassMat);
    const sky = skyTexture();
    if (sky) {
      glassMat.map = sky;
      glassMat.color.setRGB(2.6, 2.7, 2.9); // HDR 自发光：窗外比室内亮得多
    } else {
      glassMat.color.setRGB(2.6, 2.7, 2.9);
    }
    glass.position.set(windowX + 0.02, winY, winZ);
    glass.rotation.y = Math.PI / 2;
    this.scene.add(glass);
    this.skyPanels.push(glass);
    // 窗棂
    const mullionV = new THREE.Mesh(new THREE.BoxGeometry(0.05, winH, 0.06), frameMat);
    mullionV.position.set(windowX, winY, winZ);
    this.scene.add(mullionV);
    const mullionH = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.06, winW), frameMat);
    mullionH.position.set(windowX, winY, winZ);
    this.scene.add(mullionH);
    // 窗框（上下左右四根）
    const frameParts: Array<[number, number, number, number, number, number]> = [
      [0.06, winH + 0.16, 0.1, windowX + 0.02, winY, winZ - winW / 2 - 0.05],
      [0.06, winH + 0.16, 0.1, windowX + 0.02, winY, winZ + winW / 2 + 0.05],
      [0.06, 0.1, winW + 0.2, windowX + 0.02, winY + winH / 2 + 0.05, winZ],
      [0.06, 0.1, winW + 0.2, windowX + 0.02, winY - winH / 2 - 0.05, winZ],
    ];
    frameParts.forEach(([sx, sy, sz, px, py, pz]) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), frameMat);
      m.position.set(px, py, pz);
      this.scene.add(m);
    });
    // 窗台板
    const sill = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.05, winW + 0.3), frameMat);
    sill.position.set(windowX + 0.1, winY - winH / 2 - 0.14, winZ);
    this.scene.add(sill);
    // 窗帘（半透织物，垂在窗两侧）
    const drapeMat = new THREE.MeshStandardMaterial({ color: 0xd7cdbc, roughness: 0.95, side: THREE.DoubleSide });
    for (const dz of [winZ - winW / 2 - 0.42, winZ + winW / 2 + 0.36]) {
      const drape = new THREE.Mesh(new THREE.PlaneGeometry(0.55, winH + 0.75, 6, 1), drapeMat);
      // 用顶点位移做褶皱，比纯平面自然
      const pos = drape.geometry.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        pos.setZ(i, Math.sin((x / 0.55) * Math.PI * 3) * 0.035);
      }
      pos.needsUpdate = true;
      drape.geometry.computeVertexNormals();
      drape.position.set(windowX + 0.22, winY - 0.12, dz);
      drape.rotation.y = Math.PI / 2;
      this.scene.add(drape);
    }

    // ================= 背墙小窗（50mm 默认视角下也在画面内）=================
    // 左墙那扇窗在 50mm 时落在视野之外，只承担「提供侧光」的作用；
    // 这扇小窗放在书墙左侧的空白墙面，让画面里真的能看到窗外的高亮天空，
    // 用来检验高光滚降、逆光轮廓与动态范围（亮部远高于室内 2~3 档）。
    const backWinW = 1.0;
    const backWinH = 1.45;
    const backWinX = -3.58;
    const backWinY = 1.95;
    const backGlassMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    if (sky) backGlassMat.map = sky;
    backGlassMat.color.setRGB(3.4, 3.5, 3.8);
    const backGlass = new THREE.Mesh(new THREE.PlaneGeometry(backWinW, backWinH), backGlassMat);
    backGlass.position.set(backWinX, backWinY, -7.18);
    this.scene.add(backGlass);
    this.skyPanels.push(backGlass);
    // 窗框四根 + 中竖棂
    const backFrame: Array<[number, number, number, number]> = [
      [backWinW + 0.1, 0.07, backWinX, backWinY + backWinH / 2 + 0.035],
      [backWinW + 0.1, 0.07, backWinX, backWinY - backWinH / 2 - 0.035],
      [0.07, backWinH + 0.14, backWinX - backWinW / 2 - 0.035, backWinY],
      [0.07, backWinH + 0.14, backWinX + backWinW / 2 + 0.035, backWinY],
    ];
    backFrame.forEach(([w, h, x, y]) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.06), frameMat);
      m.position.set(x, y, -7.17);
      this.scene.add(m);
    });
    const backMullion = new THREE.Mesh(new THREE.BoxGeometry(0.045, backWinH, 0.06), frameMat);
    backMullion.position.set(backWinX, backWinY, -7.17);
    this.scene.add(backMullion);

    // ================= 中景：餐桌 + 静物（主拍摄对象）=================
    // 桌子：实木台面 + 四条腿
    const tableMat = new THREE.MeshStandardMaterial({ color: 0x7a5636, roughness: 0.55, metalness: 0.03 });
    const tableTopY = 0.74;
    const table = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.06, 1.15), tableMat);
    table.position.set(0, tableTopY, -1.45);
    this.scene.add(table);
    const legMat = new THREE.MeshStandardMaterial({ color: 0x5e4128, roughness: 0.6 });
    for (const lx of [-1.2, 1.2]) {
      for (const lz of [-1.95, -0.95]) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.07, tableTopY, 0.07), legMat);
        leg.position.set(lx, tableTopY / 2, lz);
        this.scene.add(leg);
      }
    }
    // 织物桌旗（增加材质层次）
    const cloth = fabricTexture();
    if (cloth) cloth.repeat.set(1, 1);
    const runner = new THREE.Mesh(
      new THREE.PlaneGeometry(2.2, 0.62),
      new THREE.MeshStandardMaterial({ color: cloth ? 0xffffff : 0x9a958c, map: cloth ?? undefined, roughness: 1 }),
    );
    runner.rotation.x = -Math.PI / 2;
    runner.position.set(0, tableTopY + 0.032, -1.45);
    this.scene.add(runner);

    const shelfY = tableTopY + 0.035;

    // --- 陶杯（带把手）---
    const ceramic = new THREE.MeshStandardMaterial({ color: 0xe9e4dc, roughness: 0.42, metalness: 0.02 });
    const mug = new THREE.Mesh(new THREE.CylinderGeometry(0.052, 0.045, 0.095, 28, 1, true), ceramic);
    mug.position.set(-0.62, shelfY + 0.0475, -1.3);
    this.scene.add(mug);
    const mugBottom = new THREE.Mesh(new THREE.CircleGeometry(0.045, 24), ceramic);
    mugBottom.rotation.x = -Math.PI / 2;
    mugBottom.position.set(-0.62, shelfY + 0.002, -1.3);
    this.scene.add(mugBottom);
    const handle = new THREE.Mesh(new THREE.TorusGeometry(0.032, 0.008, 10, 20, Math.PI * 1.2), ceramic);
    handle.position.set(-0.566, shelfY + 0.05, -1.3);
    handle.rotation.y = Math.PI / 2;
    handle.rotation.z = -0.35;
    this.scene.add(handle);
    // 杯中液体（深色咖啡，几乎镜面）
    const coffee = new THREE.Mesh(
      new THREE.CircleGeometry(0.047, 24),
      new THREE.MeshStandardMaterial({ color: 0x2a1508, roughness: 0.08, metalness: 0.1 }),
    );
    coffee.rotation.x = -Math.PI / 2;
    coffee.position.set(-0.62, shelfY + 0.082, -1.3);
    this.scene.add(coffee);

    // --- 玻璃瓶（透明 + 高光，检验镜面高光与色散）---
    const glassMat2 = new THREE.MeshPhysicalMaterial({
      color: 0xd8e7dd, roughness: 0.06, metalness: 0, transparent: true, opacity: 0.34,
      clearcoat: 1, clearcoatRoughness: 0.06, ior: 1.5,
    });
    const bottle = new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.046, 0.24, 24), glassMat2);
    bottle.position.set(-0.34, shelfY + 0.12, -1.62);
    this.scene.add(bottle);
    const bottleNeck = new THREE.Mesh(new THREE.CylinderGeometry(0.017, 0.03, 0.09, 20), glassMat2);
    bottleNeck.position.set(-0.34, shelfY + 0.285, -1.62);
    this.scene.add(bottleNeck);
    const cork = new THREE.Mesh(
      new THREE.CylinderGeometry(0.017, 0.017, 0.03, 16),
      new THREE.MeshStandardMaterial({ color: 0xb08a5c, roughness: 0.9 }),
    );
    cork.position.set(-0.34, shelfY + 0.335, -1.62);
    this.scene.add(cork);

    // --- 水果盘 + 三种水果（色彩还原与高光）---
    const fruitBowlMat = new THREE.MeshStandardMaterial({ color: 0xd9d2c4, roughness: 0.5, side: THREE.DoubleSide });
    const bowl = new THREE.Mesh(new THREE.SphereGeometry(0.16, 32, 16, 0, Math.PI * 2, Math.PI * 0.55, Math.PI * 0.45), fruitBowlMat);
    bowl.position.set(0.12, shelfY + 0.139, -1.42);
    this.scene.add(bowl);
    const fruits: Array<[number, number, number, number, number]> = [
      [0.06, shelfY + 0.075, -1.46, 0.045, 0xd8531f], // 橙
      [0.18, shelfY + 0.072, -1.4, 0.042, 0xb52a26],  // 苹果
      [0.13, shelfY + 0.118, -1.36, 0.038, 0xd9b62c], // 柠檬
    ];
    fruits.forEach(([x, y, z, r, c]) => {
      const f = new THREE.Mesh(
        new THREE.SphereGeometry(r, 24, 16),
        new THREE.MeshStandardMaterial({ color: c, roughness: 0.52, metalness: 0 }),
      );
      f.position.set(x, y, z);
      f.scale.y = 0.92;
      this.scene.add(f);
    });

    // --- 三本书（纸的漫反射 + 书脊跳色）---
    const bookColors = [0x2f4156, 0x8a3b2e, 0x3f5b47];
    bookColors.forEach((c, i) => {
      const book = new THREE.Mesh(
        new THREE.BoxGeometry(0.3 - i * 0.012, 0.032, 0.21),
        new THREE.MeshStandardMaterial({ color: c, roughness: 0.86 }),
      );
      book.position.set(0.52 + i * 0.006, shelfY + 0.016 + i * 0.033, -1.4);
      book.rotation.y = 0.08 * (i - 1);
      this.scene.add(book);
    });

    // --- 灰卡（测光基准，18% 中性灰）---
    const grayCard = new THREE.Mesh(
      new THREE.PlaneGeometry(0.2, 0.14),
      new THREE.MeshStandardMaterial({ color: 0x808080, roughness: 0.95 }),
    );
    grayCard.position.set(0.88, shelfY + 0.071, -1.36);
    grayCard.rotation.x = -Math.PI / 2 + 0.28;
    this.scene.add(grayCard);

    // --- 24 色标板（白平衡 / 色彩还原参照，斜靠在书堆上）---
    const chartTex = colorChartTexture();
    const chart = new THREE.Mesh(
      new THREE.PlaneGeometry(0.3, 0.2),
      new THREE.MeshStandardMaterial({ color: 0xffffff, map: chartTex ?? undefined, roughness: 0.75 }),
    );
    chart.position.set(0.52, shelfY + 0.14, -1.62);
    chart.rotation.x = -0.42;
    chart.rotation.y = 0.12;
    this.scene.add(chart);

    // ================= 人像主体：半身人体模型（z≈-2.8）=================
    const skinMat = new THREE.MeshStandardMaterial({ color: 0xc99a78, roughness: 0.62, metalness: 0 });
    const shirtMat = new THREE.MeshStandardMaterial({ color: 0x2f4a63, roughness: 0.88 });
    const bust = new THREE.Group();
    // 躯干（用缩放的球体做肩线，比圆柱自然）
    const torso = new THREE.Mesh(new THREE.SphereGeometry(0.28, 32, 24), shirtMat);
    torso.scale.set(1, 1.15, 0.62);
    torso.position.y = 0.82;
    bust.add(torso);
    // 脖子
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.062, 0.075, 0.14, 20), skinMat);
    neck.position.y = 1.06;
    bust.add(neck);
    // 头
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.115, 32, 24), skinMat);
    head.scale.set(0.9, 1.1, 0.95);
    head.position.y = 1.23;
    bust.add(head);
    // 发型
    const hair = new THREE.Mesh(
      new THREE.SphereGeometry(0.121, 28, 20, 0, Math.PI * 2, 0, Math.PI * 0.62),
      new THREE.MeshStandardMaterial({ color: 0x241a14, roughness: 0.72 }),
    );
    hair.scale.set(0.93, 1.05, 0.98);
    hair.position.y = 1.245;
    hair.rotation.x = -0.16;
    bust.add(hair);
    // 鼻子（一点点起伏就足以让侧光读出立体感）
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.018, 0.05, 12), skinMat);
    nose.rotation.x = Math.PI / 2;
    nose.position.set(0, 1.222, 0.108);
    bust.add(nose);
    // 座椅（被身体挡住大半，但轮廓在线）
    const chairMat = new THREE.MeshStandardMaterial({ color: 0x4a3a2c, roughness: 0.8 });
    const seat = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.05, 0.42), chairMat);
    seat.position.y = 0.46;
    bust.add(seat);
    const backRest = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.5, 0.05), chairMat);
    backRest.position.set(0, 0.71, -0.2);
    bust.add(backRest);
    bust.position.set(0.98, 0, -2.9);
    bust.rotation.y = -0.34;
    this.scene.add(bust);

    // ================= 近景：边几 + 花瓶（浅景深前景）=================
    // 位置经过取景范围核算：默认 50mm 全画幅水平半视角约 19.8°，
    // 边几必须落在 atan(1.45/4.95)≈16° 以内，否则会整个掉到画框外
    // （初版放在 x=-1.85 / z=1.15，实测 23° 直接被裁掉）。
    const sideTableMat = new THREE.MeshStandardMaterial({ color: 0x6f4d30, roughness: 0.6 });
    const sideTop = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.045, 32), sideTableMat);
    sideTop.position.set(-1.45, 0.56, 0.55);
    this.scene.add(sideTop);
    const sideLeg = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.05, 0.56, 16), sideTableMat);
    sideLeg.position.set(-1.45, 0.28, 0.55);
    this.scene.add(sideLeg);
    // 陶瓶
    const vase = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.12, 0.3, 28, 1, true), ceramic);
    vase.position.set(-1.45, 0.73, 0.55);
    this.scene.add(vase);
    const vaseBottom = new THREE.Mesh(new THREE.CircleGeometry(0.12, 24), ceramic);
    vaseBottom.rotation.x = -Math.PI / 2;
    vaseBottom.position.set(-1.45, 0.585, 0.55);
    this.scene.add(vaseBottom);
    // 干枝（细长枝条，靠近镜头会明显虚化）
    const branchMat = new THREE.MeshStandardMaterial({ color: 0x6b5a44, roughness: 0.95 });
    for (let i = 0; i < 5; i++) {
      const len = 0.5 + i * 0.09;
      const branch = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.008, len, 6), branchMat);
      branch.position.set(-1.45 + (i - 2) * 0.03, 0.88 + len / 2, 0.55 + (i % 2) * 0.03);
      branch.rotation.z = (i - 2) * 0.13;
      branch.rotation.x = (i % 3 - 1) * 0.1;
      this.scene.add(branch);
    }
    // 瓶插绿植：叶片用 Shape 画成「尖头椭圆」再双面渲染，
    // 而不是窄长方形——长方形在虚化后会被看成贴在画面上的绿纸片。
    const leafGeom = (() => {
      const s = new THREE.Shape();
      s.moveTo(0, 0);
      s.bezierCurveTo(0.055, 0.05, 0.06, 0.17, 0, 0.26);
      s.bezierCurveTo(-0.06, 0.17, -0.055, 0.05, 0, 0);
      return new THREE.ShapeGeometry(s, 16);
    })();
    const leafMat = new THREE.MeshStandardMaterial({
      color: 0x35683c, roughness: 0.72, metalness: 0, side: THREE.DoubleSide,
    });
    const leafRnd = makeRandom(7331);
    // 叶片从瓶口散出，逐片给出不同朝向与倾斜，避免排成一条直线
    for (let i = 0; i < 7; i++) {
      const leaf = new THREE.Mesh(leafGeom, leafMat);
      const a = (i / 7) * Math.PI * 2 + 0.4;
      const tilt = 0.55 + leafRnd() * 0.5;
      const scale = 0.75 + leafRnd() * 0.6;
      leaf.position.set(-1.45 + Math.cos(a) * 0.06, 0.9, 0.55 + Math.sin(a) * 0.06);
      leaf.rotation.set(-Math.PI / 2 + tilt, 0, a);
      leaf.scale.setScalar(scale);
      this.scene.add(leaf);
    }

    // ================= 远景：书墙 / 挂画 / 门洞暖光（z≈-7）=================
    const shelfWood = new THREE.MeshStandardMaterial({ color: 0x5a4128, roughness: 0.7 });
    const bookWall = new THREE.Group();
    const shelfRnd = makeRandom(13579);
    for (let row = 0; row < 4; row++) {
      const board = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.04, 0.3), shelfWood);
      board.position.set(0, 0.55 + row * 0.52, 0);
      bookWall.add(board);
      // 每层的书：随机高度/颜色/厚度，形成真实的书脊节奏
      let cursor = -1.1;
      while (cursor < 1.05) {
        const w = 0.03 + shelfRnd() * 0.045;
        const h = 0.26 + shelfRnd() * 0.16;
        const shade = 0.25 + shelfRnd() * 0.5;
        const book = new THREE.Mesh(
          new THREE.BoxGeometry(w, h, 0.22),
          new THREE.MeshStandardMaterial({
            color: new THREE.Color().setHSL(0.03 + shelfRnd() * 0.55, 0.28 + shelfRnd() * 0.35, shade * 0.55),
            roughness: 0.88,
          }),
        );
        book.position.set(cursor + w / 2, 0.57 + row * 0.52 + h / 2, 0);
        bookWall.add(book);
        cursor += w + 0.004 + shelfRnd() * 0.012;
      }
    }
    // 立框
    const side1 = new THREE.Mesh(new THREE.BoxGeometry(0.05, 2.2, 0.32), shelfWood);
    side1.position.set(-1.22, 1.6, 0);
    bookWall.add(side1);
    const side2 = side1.clone();
    side2.position.x = 1.22;
    bookWall.add(side2);
    bookWall.position.set(-1.75, 0, -7.05);
    this.scene.add(bookWall);

    // 挂画（大块低对比色面，检验远景细节与噪点）
    const artTex = proceduralTexture((ctx, size) => {
      const g = ctx.createLinearGradient(0, 0, size, size);
      g.addColorStop(0, '#e4dccb');
      g.addColorStop(1, '#8f9aa6');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, size, size);
      ctx.fillStyle = 'rgba(180,92,58,0.55)';
      ctx.beginPath();
      ctx.arc(size * 0.62, size * 0.42, size * 0.22, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(46,68,88,0.45)';
      ctx.fillRect(size * 0.14, size * 0.55, size * 0.36, size * 0.3);
    }, 256);
    const art = new THREE.Mesh(
      new THREE.PlaneGeometry(1.05, 0.72),
      new THREE.MeshStandardMaterial({ color: 0xffffff, map: artTex ?? undefined, roughness: 0.82 }),
    );
    art.position.set(1.35, 2.0, -7.16);
    this.scene.add(art);
    const artFrame = new THREE.Mesh(
      new THREE.BoxGeometry(1.13, 0.8, 0.04),
      new THREE.MeshStandardMaterial({ color: 0x2b2620, roughness: 0.6 }),
    );
    artFrame.position.set(1.35, 2.0, -7.19);
    this.scene.add(artFrame);

    // 门洞：门框 + 深处暖色自发光，作为背景高光点
    const doorFrameMat = new THREE.MeshStandardMaterial({ color: 0xe9e5dc, roughness: 0.7 });
    const doorWay = new THREE.Mesh(
      new THREE.PlaneGeometry(0.95, 2.1),
      new THREE.MeshBasicMaterial({ color: 0xffffff }),
    );
    (doorWay.material as THREE.MeshBasicMaterial).color.setRGB(1.5, 1.05, 0.62);
    doorWay.position.set(3.0, 1.05, -7.15);
    this.scene.add(doorWay);
    const dTop = new THREE.Mesh(new THREE.BoxGeometry(1.08, 0.08, 0.1), doorFrameMat);
    dTop.position.set(3.0, 2.14, -7.1);
    this.scene.add(dTop);
    for (const dx of [2.46, 3.54]) {
      const dSide = new THREE.Mesh(new THREE.BoxGeometry(0.08, 2.14, 0.1), doorFrameMat);
      dSide.position.set(dx, 1.07, -7.1);
      this.scene.add(dSide);
    }

    // 地毯（增加地面层次）
    const rugMat = new THREE.MeshStandardMaterial({ color: 0x7d6f60, roughness: 1 });
    const rug = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 1.9), rugMat);
    rug.rotation.x = -Math.PI / 2;
    rug.position.set(0.15, 0.006, -0.35);
    this.scene.add(rug);

    // ================= 运动物体：摆动的吊灯（唯一动态元素）=================
    // 结构固定为 [吊绳, 灯罩组]，引擎读取 children[1] 的世界坐标做速度估计。
    this.movingPivot.position.set(1.75, 3.4, -2.35);
    const cord = new THREE.Mesh(
      new THREE.CylinderGeometry(0.008, 0.008, 0.62, 8),
      new THREE.MeshStandardMaterial({ color: 0x1c1c1c, roughness: 0.9 }),
    );
    cord.position.y = -0.31;
    this.movingPivot.add(cord);

    const shadeGroup = new THREE.Group();
    shadeGroup.position.y = -0.72;
    const shadeOuter = new THREE.Mesh(
      new THREE.ConeGeometry(0.22, 0.24, 28, 1, true),
      new THREE.MeshStandardMaterial({ color: 0x3d4046, roughness: 0.42, metalness: 0.55, side: THREE.DoubleSide }),
    );
    shadeOuter.position.y = 0.06;
    shadeGroup.add(shadeOuter);
    // 灯罩内壁自发光（视线角度上会看到一圈暖光，也提供运动高光）
    const bulb = new THREE.Mesh(
      new THREE.SphereGeometry(0.062, 18, 12, 0, Math.PI * 2, 0, Math.PI),
      new THREE.MeshBasicMaterial({ color: 0xffffff }),
    );
    (bulb.material as THREE.MeshBasicMaterial).color.setRGB(3.2, 2.2, 1.35);
    bulb.position.y = -0.03;
    shadeGroup.add(bulb);
    this.movingPivot.add(shadeGroup);
    this.scene.add(this.movingPivot);

    const maskCord = new THREE.Mesh(
      new THREE.CylinderGeometry(0.008, 0.008, 0.62, 8),
      new THREE.MeshBasicMaterial({ color: 0xffffff }),
    );
    maskCord.position.y = -0.31;
    this.maskPivot.add(maskCord);
    const maskShade = new THREE.Group();
    maskShade.position.y = -0.72;
    const maskCone = new THREE.Mesh(
      new THREE.ConeGeometry(0.22, 0.24, 20, 1, true),
      new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide }),
    );
    maskCone.position.y = 0.06;
    maskShade.add(maskCone);
    // 占位子物体，保持与真实结构相同的 children 索引
    const maskBulb = new THREE.Mesh(new THREE.SphereGeometry(0.062, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    maskBulb.position.y = -0.03;
    maskShade.add(maskBulb);
    this.maskPivot.add(maskShade);
    this.maskPivot.position.copy(this.movingPivot.position);
    this.maskScene.background = new THREE.Color(0x000000);
    this.maskScene.add(this.maskPivot);
    this.maskScene.add(new THREE.AmbientLight(0xffffff, 1)); // MeshBasic 不受光，占位
  }

  private sceneSettings: SceneSettings = {
    keyIntensity: 3, keyTemp: 5500, keyAzimuth: 0.8, keyElevation: 0.9,
    ambientIntensity: 0.35, motionSpeed: 1.2, motionEnabled: true, cameraRoll: 0,
  };

  /** 每帧更新：运动、灯光、相机 FOV（焦距映射） */
  update(dt: number, cam: CameraSettings, sc: SceneSettings): void {
    this.sceneSettings = sc;
    if (sc.motionEnabled) this.time += dt;

    // 吊灯摆动：绕吊点做小幅摆动（±0.22 rad），比整圈旋转更像真实室内
    const sway = Math.sin(this.time * sc.motionSpeed) * 0.22;
    this.movingPivot.rotation.z = sway;
    this.movingPivot.rotation.x = Math.cos(this.time * sc.motionSpeed * 0.7) * 0.06;
    this.maskPivot.rotation.z = this.movingPivot.rotation.z;
    this.maskPivot.rotation.x = this.movingPivot.rotation.x;

    // 更新矩阵后读取世界坐标，避免取到上一帧变换
    this.movingPivot.updateMatrixWorld(true);
    this.maskPivot.updateMatrixWorld(true);
    this.prevWorld.copy(this.currWorld);
    this.movingPivot.children[1].getWorldPosition(this.currWorld);
    if (this.prevWorld.lengthSq() === 0) this.prevWorld.copy(this.currWorld);

    // 主光：色温 → RGB，强度与方向由场景设置驱动
    const [r, g, b] = kelvinToRGB(sc.keyTemp);
    this.keyLight.color.setRGB(r, g, b);
    this.keyLight.intensity = sc.keyIntensity;
    this.keyLight.position.set(
      Math.sin(sc.keyAzimuth) * Math.cos(sc.keyElevation) * 10,
      Math.sin(sc.keyElevation) * 10 + 2,
      Math.cos(sc.keyAzimuth) * Math.cos(sc.keyElevation) * 10,
    );
    // 窗光：偏冷、强度随主光联动（真实场景里窗与室内灯是两套色温）
    // 注意：三盏灯会叠加，窗光与台灯只做「层次补光」，量级必须远小于主光，
    // 否则室内中景会整体过曝发白（新场景初版就是以 0.35 / 1.6 直接叠爆的）。
    this.windowLight.color.setRGB(0.72, 0.84, 1.0);
    this.windowLight.intensity = sc.keyIntensity * 0.12;
    this.ambient.intensity = sc.ambientIntensity;
    // 台灯：暖色实用光源，同样随主光强度缩放，保持整体曝光关系稳定
    this.lampLight.intensity = sc.keyIntensity * 0.45;
    const [lr, lg, lb] = kelvinToRGB(Math.min(sc.keyTemp, 3200));
    this.lampLight.color.setRGB(lr, lg, lb);

    // 焦距 → 视角（水平 FOV，考虑全画幅宽度）。P2：按传感器裁切系数换算等效焦距。
    const crop = cropFactor(cam.sensor);
    const vfov = fieldOfView(cam.focalLength / crop, SENSOR.width) * (SENSOR.height / SENSOR.width);
    this.camera.fov = THREE.MathUtils.clamp(vfov, 8, 120);
    this.camera.updateProjectionMatrix();
    // P1：相机倾斜（水平仪验证）—— roll 施加在相机局部光轴上
    this.camera.rotation.z = THREE.MathUtils.degToRad(sc.cameraRoll);
  }

  /** 运动物体在屏幕上的速度（UV/秒），由真实世界位移投影得到。运动模糊长度 = 速度 × 快门时间。 */
  getScreenVelocity(dt: number): ScreenVelocity {
    if (!this.sceneSettings.motionEnabled || dt <= 0) return { x: 0, y: 0, active: false };
    this.tmpDelta.subVectors(this.currWorld, this.prevWorld);
    this.tmpNdcCurr.copy(this.currWorld).project(this.camera);
    this.tmpNdcPrev.copy(this.prevWorld).project(this.camera);
    // NDC→UV 缩放 0.5；除 dt 得 UV/秒
    const vx = (this.tmpNdcCurr.x - this.tmpNdcPrev.x) * 0.5 / dt;
    const vy = (this.tmpNdcCurr.y - this.tmpNdcPrev.y) * 0.5 / dt;
    return { x: vx, y: vy, active: this.tmpDelta.lengthSq() > 1e-10 };
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** 自动对焦：用 Raycaster 从焦点点击位置读取实际距离（米） */
  autoFocusAt(nx: number, ny: number): number {
    this.focusNdc.set(nx * 2 - 1, -(ny * 2 - 1));
    this.focusRay.setFromCamera(this.focusNdc, this.camera);
    const hits = this.focusRay.intersectObjects(this.scene.children, true);
    for (const hit of hits) {
      // 跳过窗玻璃：它只是「远处天空」的自发光平面，对焦到它没有意义
      if ((hit.object as THREE.Mesh).isMesh && !this.skyPanels.includes(hit.object as THREE.Mesh)) {
        return hit.distance;
      }
    }
    return 3.5;
  }

  /** 深度纹理转线性距离（米）所需参数 */
  getDepthParams() {
    return { near: this.camera.near, far: this.camera.far };
  }
}
