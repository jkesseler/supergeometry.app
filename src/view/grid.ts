import { DoubleSide, Matrix4, Mesh, PlaneGeometry, ShaderMaterial, Vector3 } from 'three';
import { planeY } from '../geom';
import type { PlaneDef } from '../doc/types';

/**
 * Infinite-looking grid that adapts its spacing to the zoom level, or stays at a locked step. It lies on the ground,
 * or on the active sketch plane while sketching.
 *
 * Its smallest squares are what a sketch snaps to: 1, 5 or 10 (times a power of ten), the smallest of them at least
 * ten pixels wide. (They were powers of ten only, up to a hundred pixels wide, and the snap went to a
 * finer lattice nothing showed: a line's end "did not snap to the grid" - it had, to one that was not drawn.)
 */

/** The smallest of 1, 5, 10 (times a power of ten) that is at least `raw`. */
export function squareFor(raw: number): number {
  const power = Math.pow(10, Math.floor(Math.log10(raw)));
  const mantissa = raw / power;

  return (mantissa <= 1 + 1e-9 ? 1 : mantissa <= 5 ? 5 : 10) * power;
}

export class AdaptiveGrid {
  readonly mesh: Mesh;
  /** Current minor step in mm (also used for grid snapping). */
  step = 1;
  locked = false;
  lockedStep = 1;
  private plane: PlaneDef = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] };
  private material: ShaderMaterial;

  constructor() {
    this.material = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      uniforms: {
        uStep: { value: 1 },
        uMid: { value: 10 },
        uFade: { value: 0 },
        uCenter: { value: [0, 0] },
        uRadius: { value: 100 },
        // Quad centre (u, v) on the plane and its size: turns quad coords into plane coords.
        uLocal: { value: [0, 0, 1] }
      },
      vertexShader: /* glsl */ `
        uniform vec3 uLocal;
        varying vec2 vUv;
        void main() {
          vUv = uLocal.xy + position.xy * uLocal.z;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform float uStep;
        uniform float uMid;
        uniform float uFade;
        uniform vec2 uCenter;
        uniform float uRadius;
        varying vec2 vUv;
        float lines(vec2 p, float s) {
          vec2 g = abs(fract(p / s - 0.5) - 0.5) / fwidth(p / s);
          return 1.0 - min(min(g.x, g.y), 1.0);
        }
        void main() {
          vec2 p = vUv;
          float minor = lines(p, uStep) * (1.0 - uFade);
          float mid = lines(p, uMid);
          float major = lines(p, uMid * 10.0);
          float a = max(max(minor * 0.2, mid * 0.38), major * 0.55);
          float d = length(p - uCenter) / uRadius;
          a *= 1.0 - smoothstep(0.55, 1.0, d);
          if (a < 0.01) discard;
          gl_FragColor = vec4(vec3(0.78), a);
        }`
    });
    this.mesh = new Mesh(new PlaneGeometry(1, 1), this.material);
    this.mesh.renderOrder = -1;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.frustumCulled = false;
  }

  setPlane(plane: PlaneDef): void {
    this.plane = plane;
  }

  /** Recompute spacing and placement for the current view. */
  update(worldPerPixel: number, target: Vector3, distance: number, eye?: Vector3): void {
    let fade = 0;
    if (this.locked) {
      this.step = this.lockedStep;
    } else {
      // The smallest squares at least 10 px wide; a little fainter while they are that small.
      this.step = squareFor(worldPerPixel * 10);
      fade = Math.max(0, Math.min(0.5, ((18 - this.step / worldPerPixel) / 8) * 0.5));
    }
    // The stronger lines: every ten of them (every 10 where the squares are 5).
    const decade = Math.pow(10, Math.round(Math.log10(this.step)));
    const mid = Math.abs(decade - this.step) < this.step * 1e-6 ? this.step * 10 : Math.pow(10, Math.ceil(Math.log10(this.step)));
    const vector = new Vector3(...this.plane.normal);
    const x = new Vector3(...this.plane.xDir);
    const y = new Vector3(...planeY(this.plane));
    const origin = new Vector3(...this.plane.origin);
    // Centre the quad under the camera target (projected on the plane).
    const rel = target.clone().sub(origin);
    const cu = rel.dot(x);
    const cv = rel.dot(y);
    // Big enough to reach the horizon from where the camera is (it can sit far
    // above the plane while its target is close, after zooming towards a point).
    const height = eye ? Math.abs(eye.clone().sub(origin).dot(vector)) : 0;
    const size = Math.max(distance * 6, height * 12, this.step * 400);
    // The quad spans local coords [cu ± size/2]; vUv carries plane coordinates.
    const matrix = new Matrix4().makeBasis(x, y, vector).setPosition(origin);
    const local = new Matrix4().makeScale(size, size, 1).setPosition(cu, cv, 0);
    this.mesh.matrix.copy(matrix.multiply(local));
    this.mesh.matrixWorldNeedsUpdate = true;
    this.material.uniforms.uStep.value = this.step;
    this.material.uniforms.uMid.value = mid;
    this.material.uniforms.uFade.value = fade;
    this.material.uniforms.uCenter.value = [cu, cv];
    this.material.uniforms.uRadius.value = size / 2;
    this.material.uniforms.uLocal.value = [cu, cv, size];
  }
}
