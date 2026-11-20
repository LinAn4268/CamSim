# CamSim — 真实相机物理模拟器：需求规格与实现方案

> 目标：不是滤镜网页，而是用可计算的物理模型 + 实时 WebGL2 渲染管线，还原真实相机的操作逻辑、参数耦合与成像效果。

## 1. 需求理解与实现方案摘要

- **核心**：曝光三角、测光、对焦、白平衡、镜头、景深、运动模糊、噪点、高光滚降、镜头像差、色调映射等，全部由可解释模型/后期管线产生，参数实时联动。
- **场景**：Three.js 室内测试场景（近/中/远景、灰卡、高光板、彩色物体、运动物体），光照可调。
- **交付**：可运行网站 + 单元测试 + 浏览器自测 + README（区分物理模拟与近似效果）。

## 2. 技术选型与理由

| 领域 | 选择 | 理由 |
|---|---|---|
| 框架 | React 18 + TypeScript | 状态驱动 UI，类型安全 |
| 状态 | Zustand | 集中管理相机/场景状态，UI 与渲染解耦 |
| 渲染 | Three.js (WebGL2) | 成熟 3D 生态、ShaderMaterial 可扩展 |
| 后期 | 自写 GLSL ShaderPass 链 | 关键效果可解释、可调参，不用黑盒滤镜库 |
| 测试 | Vitest（纯函数）+ 浏览器控制台自测 + CDP 验收脚本 | 覆盖公式与端到端 |
| 后端预留 | WebGPU backend 接口预留（本阶段未实现） | 满足可替换后端要求 |

## 3. 文件结构与模块划分

```
src/
  types/camera.ts          参数与照片类型
  camera/physics.ts        关键物理公式（纯函数）
  camera/advanced.ts       P1：ND/闪光/防抖/果冻/包围/HDR/斑马纹
  camera/optics.ts         P2：传感器/镜头/裁切/预设序列化
  camera/film.ts           P1：胶片模拟矩阵/.cube LUT 解析与采样
  camera/whiteBalance.ts   色温→RGB 增益
  camera/metering.ts       评价/中央/点测光
  camera/selfTest.ts       浏览器控制台自测（汇总全部模块）
  camera/*.test.ts         单元测试
  store/useCameraStore.ts  集中状态
  scene/TestScene.ts       3D 测试场景 + 光照 + 运动物体 + 深度/掩码
  renderer/CameraEngine.ts 渲染主循环 + 后期链编排 + 测光/直方图 + 拍摄
  renderer/post/Pass.ts    ShaderPass + PingPong RT
  renderer/shaders/chains.ts 各后期 GLSL
  ui/                      ControlPanel/Viewfinder/Histogram/ExposureScale/Playback
  utils/format.ts          显示格式化
  main.tsx / App.tsx / styles.css
docs/PLAN.md              本文件
README.md                 启动/功能/单位/限制说明
scripts/                  验收辅助脚本（开发用）
```

## 4. P0 / P1 / P2 功能清单

### P0（已实现）
曝光三角（1/8000–30s、标准光圈档、ISO 100–25600）、EV/曝光补偿、三种测光、实时取景+直方图+过曝警告、手动/自动对焦+峰值+景深预览、白平衡（2000–10000K+色调）、变焦、景深/运动模糊、成像后期（曝光→WB→滚降→景深→运动模糊→色差→暗角→噪点→锐化/衍射→ACES 色调映射）、拍摄/回放/EXIF、键盘快捷键、场景光照调节、重置。

### P1（已实现）
机械/电子快门（果冻逐行剪切）、驱动模式（单张/连拍/定时）、包围曝光（对称 EV 序列）、多曝光 HDR（线性加权融合）、ND 滤镜、闪光灯（前/后帘、功率 EV、距离平方反比）、防抖（安全快门折算+抖动抑制）、斑马纹/辅助线/电子水平仪、5 种胶片模拟（矩阵+LGG+对比度+饱和度）、`.cube` LUT 导入与三线性插值。

### P2（已实现）
传感器尺寸切换（全画幅/APS-C/M4/3，联动视角/景深/衍射/噪点/裁切）、镜头切换（广角/标准/长焦，焦距自动钳制）、RAW/JPEG 格式（RAW 含线性 readback + 机内预览）、预设 JSON 导出/导入、带 EXIF 参数水印导出、包围序列条与 HDR 标记。

## 5. 关键物理模型与公式

- **EV**：`EV = log2(N²/t) - log2(ISO/100) + EVcomp`
- **曝光增益**：`gain = t · (ISO/100) / N² · 2^EVcomp`（乘 1000 校准常数映射到线性 HDR 场景）
- **超焦距**：`H = f²/(N·c) + f`，`c ≈ 0.03 mm`（全画幅）
- **景深**：`near = s(H−f)/(H+s−2f)`，`far = s(H−f)/(H−s)`（s>f）
- **弥散圆**：`CoC = |A·(s−s₀)|/(s·(s₀−F))`，A=f²/N，用于后期景深模糊半径
- **运动模糊**：`blur ≈ shutter × screenVelocity × scale`，沿运动方向 12-tap 卷积，掩码限定运动物体
- **噪点**：散粒噪声 `∝√signal`，读出噪声 `∝√ISO`，亮度/彩色噪声分离，随 ISO 增强
- **白平衡**：色温表插值得到光源 RGB，再取倒数并归一化 G=1 作为相机增益；tint 正负调绿/品红
- **高光/色调映射**：ACES (Narkowicz) + 自定义肩部滚降，避免硬 clamp
- **衍射**：艾里斑直径 `2.44·λ·N`（λ≈0.55μm），按传感器裁切折算，小光圈下混入模糊
- **ND**：透射率 `2^(−ND)`，等效快门 `t·2^ND`
- **闪光**：`EV_flash = P − 2·log₂(d) + log₂(ISO/100) − 2·log₂(N)`，按功率加权叠加到曝光
- **防抖**：安全快门 `t/2^stops`（开启补偿 4 档），果冻强度 `clamp(1−t/(2·t_readout),0,1)`
- **包围**：对称 EV 序列 `±step·k`；HDR 权重 `w = exp(−(log₂(L)−0.5)²)` 中调高斯，融合 `Σ(w·L·2^(−EV))/Σw`
- **传感器联动**：裁切系数 `crop = 36/sensorWidth`，等效焦距 `f·crop`，衍射/噪点/景深随裁切缩放
- **胶片模拟**：3×3 颜色矩阵 → LGG（L=lift、G=1/gamma、G=gain）→ 对比度（围绕 0.5）→ 饱和度插值；LUT 用 `.cube` 三线性插值

## 6. 分阶段实现计划

- **阶段一（P0，已实现）**：物理公式层 → 状态层 → 3D 场景 → 后期渲染管线 → UI → 自测与验收。
- **阶段二（P1，已实现）**：快门类型/驱动/包围/HDR/ND/闪光/防抖/斑马纹/胶片模拟/LUT。
- **阶段三（P2，已实现）**：多镜头/传感器切换/RAW-JPEG/预设/导出。

## 7. 验收标准
见 README「验收结果」章节：16 项（P0 12 项 + P1/P2 4 项），单元测试 43 项、浏览器自测 49 项全通过。

## 8. 已知近似与限制
见 README「物理模拟 vs 近似效果」与「已知限制」。

## 9. 风险与替代方案

| 风险 | 处理 |
|---|---|
| WebGL2 不可用 | 明确报错提示，不降级为滤镜 |
| 编辑器原子保存导致 Vite 监听 EBUSY | `server.watch.usePolling` 轮询 |
| ResizeObserver 与 canvas 内在尺寸正反馈 | canvas 绝对定位、resize 只读父容器、RT 尺寸钳制 |
| 标准光圈档为标称值（f/2.8 ≠ 2√2） | 测试容差按标称档调整 |
