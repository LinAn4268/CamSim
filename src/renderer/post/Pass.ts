// src/renderer/post/Pass.ts — 可组合后期处理 Pass 抽象 + 全屏四边形

import * as THREE from 'three';

export const FULLSCREEN_VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/** 单个全屏 Pass：持有 ShaderMaterial，render() 把 input 纹理渲染到 output 目标。 */
export class Pass {
  material: THREE.ShaderMaterial;
  private mesh: THREE.Mesh;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  name: string;

  constructor(name: string, fragmentShader: string, uniforms: Record<string, THREE.IUniform>) {
    this.name = name;
    this.material = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, ...uniforms },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader,
      depthTest: false,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.scene.add(this.mesh);
  }

  render(renderer: THREE.WebGLRenderer, input: THREE.Texture, output: THREE.WebGLRenderTarget | null): void {
    this.material.uniforms.tDiffuse.value = input;
    renderer.setRenderTarget(output);
    renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.material.dispose();
    this.mesh.geometry.dispose();
  }
}

/** 创建 Ping-pong 渲染目标对 */
export function makePingPong(w: number, h: number): { a: THREE.WebGLRenderTarget; b: THREE.WebGLRenderTarget } {
  const opts: THREE.RenderTargetOptions = {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
  };
  return {
    a: new THREE.WebGLRenderTarget(w, h, opts),
    b: new THREE.WebGLRenderTarget(w, h, opts),
  };
}
