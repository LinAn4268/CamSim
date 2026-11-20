// src/scene/TestScene.ts — 可交互的 3D 测试场景：近/中/远景、灰卡、高光、彩色物体、运动物体

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

export class TestScene {
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  maskScene = new THREE.Scene(); // 仅运动物体的白色遮罩，用于运动模糊

  private movingPivot = new THREE.Group();
  private maskPivot = new THREE.Group();
  private keyLight = new THREE.DirectionalLight(0xffffff, 3);
  private ambient = new THREE.HemisphereLight(0xffffff, 0x404040, 0.35);
  private highlightPanel: THREE.Mesh;
  private time = 0;
  private prevWorld = new THREE.Vector3();
  private currWorld = new THREE.Vector3();

  constructor(aspect: number) {
    this.scene.background = new THREE.Color(0x20242b);
    this.camera = new THREE.PerspectiveCamera(50, aspect, 0.05, 200);
    this.camera.position.set(0, 1.55, 5.5);
    this.camera.lookAt(0, 1.35, -4);

    // ---- 环境光与主光 ----
    this.scene.add(this.ambient);
    this.scene.add(this.keyLight);
    this.keyLight.position.set(4, 6, 4);

    // ---- 房间（地板 + 背墙 + 侧墙）----
    const roomMat = new THREE.MeshStandardMaterial({ color: 0x8a8f98, roughness: 0.95, metalness: 0 });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), roomMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);

    const backWall = new THREE.Mesh(new THREE.PlaneGeometry(40, 14), new THREE.MeshStandardMaterial({ color: 0x6f7681, roughness: 1 }));
    backWall.position.set(0, 6, -18);
    this.scene.add(backWall);

    // ---- 近景物体（z≈3.5）：验证浅景深 ----
    const nearSphere = new THREE.Mesh(new THREE.SphereGeometry(0.28, 32, 16), new THREE.MeshStandardMaterial({ color: 0xe0523a, roughness: 0.35, metalness: 0.1 }));
    nearSphere.position.set(-1.5, 1.0, 3.2);
    this.scene.add(nearSphere);

    // ---- 中景主体（z≈-1.5）：灰卡 + 彩色球 + 人类尺度参照 ----
    const grayCard = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 1.2), new THREE.MeshStandardMaterial({ color: 0x808080, roughness: 0.9 }));
    grayCard.position.set(0, 1.5, -1.5);
    this.scene.add(grayCard);

    const colors = [0x2e6fdb, 0x36a54b, 0xd9b52c, 0xb1359e, 0xd9d9d9, 0x1a1a1a];
    colors.forEach((c, i) => {
      const ball = new THREE.Mesh(new THREE.SphereGeometry(0.16, 24, 16), new THREE.MeshStandardMaterial({ color: c, roughness: 0.4 }));
      ball.position.set(-1.6 + i * 0.62, 1.05, -1.2);
      this.scene.add(ball);
    });

    // 中景人形参照物（圆柱+球头）
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.34, 1.2, 16), new THREE.MeshStandardMaterial({ color: 0x5a6b7d, roughness: 0.7 }));
    body.position.set(1.6, 1.05, -1.5);
    this.scene.add(body);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.22, 24, 16), new THREE.MeshStandardMaterial({ color: 0xc9a17a, roughness: 0.8 }));
    head.position.set(1.6, 1.85, -1.5);
    this.scene.add(head);

    // ---- 远景（z≈-10）：验证远景深 + 高光区域 ----
    const farBoxes = [
      { x: -3.2, y: 1.0, z: -9, c: 0x9a6b4f },
      { x: 0, y: 1.2, z: -11, c: 0x4f6f9a },
      { x: 3.0, y: 0.9, z: -8, c: 0x6f9a5a },
    ];
    farBoxes.forEach(b => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(1.4, 2, 1.4), new THREE.MeshStandardMaterial({ color: b.c, roughness: 0.8 }));
      mesh.position.set(b.x, b.y, b.z);
      this.scene.add(mesh);
    });

    // 高光板（自发光）：验证高光滚降与动态范围
    this.highlightPanel = new THREE.Mesh(
      new THREE.PlaneGeometry(1.6, 2.2),
      new THREE.MeshBasicMaterial({ color: 0xffffff }),
    );
    (this.highlightPanel.material as THREE.MeshBasicMaterial).color.setRGB(12, 12, 12); // HDR 自发光 > 1
    this.highlightPanel.position.set(-4.5, 2.2, -7);
    this.highlightPanel.rotation.y = 0.35;
    this.scene.add(this.highlightPanel);

    // ---- 运动物体：绕轴旋转的球，通过遮罩场景渲染白色版本 ----
    const orb = new THREE.Mesh(new THREE.SphereGeometry(0.3, 24, 16), new THREE.MeshStandardMaterial({ color: 0xffcc22, roughness: 0.3, metalness: 0.2 }));
    const arm = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.06, 0.06), new THREE.MeshStandardMaterial({ color: 0xdddddd }));
    arm.position.x = -0.9;
    this.movingPivot.add(arm);
    this.movingPivot.add(orb);
    orb.position.x = -2.2;
    this.movingPivot.position.set(0, 2.2, -2.5);
    this.scene.add(this.movingPivot);

    const maskOrb = new THREE.Mesh(new THREE.SphereGeometry(0.3, 24, 16), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    const maskArm = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.06, 0.06), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    maskArm.position.x = -0.9;
    this.maskPivot.add(maskArm);
    this.maskPivot.add(maskOrb);
    maskOrb.position.x = -2.2;
    this.maskPivot.position.copy(this.movingPivot.position);
    this.maskScene.background = new THREE.Color(0x000000);
    this.maskScene.add(this.maskPivot);
    this.maskScene.add(new THREE.AmbientLight(0xffffff, 1)); // MeshBasic 不受光，占位
  }

  /** 每帧更新：运动、灯光、相机 FOV（焦距映射） */
  update(dt: number, cam: CameraSettings, sc: SceneSettings): void {
    this.sceneSettings = sc;
    if (sc.motionEnabled) this.time += dt;
    const angle = this.time * sc.motionSpeed;
    // 更新矩阵后读取世界坐标，避免取到上一帧变换
    this.movingPivot.rotation.y = angle;
    this.maskPivot.rotation.y = angle;
    this.movingPivot.updateMatrixWorld(true);
    this.maskPivot.updateMatrixWorld(true);
    this.prevWorld.copy(this.currWorld);
    this.movingPivot.children[1].getWorldPosition(this.currWorld);
    if (this.prevWorld.lengthSq() === 0) this.prevWorld.copy(this.currWorld);

    // 主光：色温 → RGB，强度与方向
    const [r, g, b] = kelvinToRGB(sc.keyTemp);
    this.keyLight.color.setRGB(r, g, b);
    this.keyLight.intensity = sc.keyIntensity;
    this.keyLight.position.set(
      Math.sin(sc.keyAzimuth) * Math.cos(sc.keyElevation) * 10,
      Math.sin(sc.keyElevation) * 10 + 2,
      Math.cos(sc.keyAzimuth) * Math.cos(sc.keyElevation) * 10,
    );
    this.ambient.intensity = sc.ambientIntensity;

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
    const delta = new THREE.Vector3().subVectors(this.currWorld, this.prevWorld);
    if (!this.sceneSettings.motionEnabled || dt <= 0) return { x: 0, y: 0, active: false };
    const currNdc = this.currWorld.clone().project(this.camera);
    const prevNdc = this.prevWorld.clone().project(this.camera);
    // NDC→UV 缩放 0.5；除 dt 得 UV/秒
    const vx = (currNdc.x - prevNdc.x) * 0.5 / dt;
    const vy = (currNdc.y - prevNdc.y) * 0.5 / dt;
    return { x: vx, y: vy, active: delta.lengthSq() > 1e-10 };
  }

  private sceneSettings: SceneSettings = {
    keyIntensity: 3, keyTemp: 5500, keyAzimuth: 0.8, keyElevation: 0.9,
    ambientIntensity: 0.35, motionSpeed: 1.2, motionEnabled: true, cameraRoll: 0,
  };

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** 自动对焦：用 Raycaster 从焦点点击位置读取实际距离（米） */
  autoFocusAt(nx: number, ny: number): number {
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(nx * 2 - 1, -(ny * 2 - 1)), this.camera);
    const hits = ray.intersectObjects(this.scene.children, true);
    for (const hit of hits) {
      if ((hit.object as THREE.Mesh).isMesh && hit.object !== this.highlightPanel) {
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
