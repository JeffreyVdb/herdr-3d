import * as THREE from 'three/webgpu';
import { BRDF_Lambert, diffuseColor, float, mix, normalView, smoothstep } from 'three/tsl';

/**
 * #86: toon shading that keeps faces turned away from the sun out of the sun's
 * shadow map.
 *
 * three's toon model (`ToonLightingModel`, for both backends: the WebGL2
 * fallback runs the same node materials) maps `N·L * 0.5 + 0.5` to a 0.7 / 1.0
 * step, so a face with N·L <= 0 still gets 70 % of the sun and still samples
 * the shadow map. A box mounted on a wall (whiteboard, partition, sofa) is
 * occluded there by its own lit far side: the depth test lands on the edge and
 * the face stripes, or goes uniformly grey next to the lit wall around it.
 *
 * Here the shadow term fades in over the first `FACING` of N·L: a back face
 * takes the flat 0.7 tone of the *unshadowed* light (`baseColorNode`, the
 * light before `ShadowNode` multiplied it), a facing one the shadowed light as
 * before. The tone steps themselves are three's own.
 */
const FACING = 0.08;

/** TSL's types follow each node's value type; this model mixes them freely, as three's own ToonLightingModel does in JS. */
type Dyn = any;

class SunToonLightingModel extends THREE.LightingModel {
  override direct({ lightDirection, lightColor, lightNode, reflectedLight }: THREE.LightingModelDirectInput): void {
    const dotNL: Dyn = normalView.dot(lightDirection as Dyn);
    const coord: Dyn = dotNL.mul(0.5).add(0.5);
    const fw: Dyn = coord.fwidth().mul(0.5);
    const tone: Dyn = mix(float(0.7), float(1), smoothstep(float(0.7).sub(fw), float(0.7).add(fw), coord));
    // Lights without a shadow (or on a material that receives none) have no base: their colour is it.
    const unshadowed: Dyn = (lightNode as { baseColorNode?: THREE.Node | null }).baseColorNode ?? lightColor;
    const light: Dyn = mix(unshadowed, lightColor as Dyn, smoothstep(float(0), float(FACING), dotNL));
    (reflectedLight.directDiffuse as Dyn).addAssign(tone.mul(light).mul(BRDF_Lambert({ diffuseColor: diffuseColor.rgb })));
  }

  override indirect(builder: THREE.NodeBuilder): void {
    const { ambientOcclusion, irradiance, reflectedLight } = builder.context as Record<string, Dyn>;
    reflectedLight.indirectDiffuse.addAssign(irradiance.mul(BRDF_Lambert({ diffuseColor })));
    reflectedLight.indirectDiffuse.mulAssign(ambientOcclusion);
  }
}

/** The suns' shadow maps, texels a side. */
export const SHADOW_MAP = 2048;

/**
 * `shadow.normalBias` for an orthographic sun frustum `2 * half` across: a
 * receiver is pushed out along its normal by a couple of texels before the
 * lookup, so a surface at a shallow angle to the sun doesn't land inside its
 * own texel's depth.
 */
export function normalBiasFor(half: number): number {
  return (2 * 2 * half) / SHADOW_MAP;
}

/** Every `MeshToonMaterial` the renderer turns into a `MeshToonNodeMaterial` lights with this model. Idempotent. */
export function installSunToon(): void {
  (THREE.MeshToonNodeMaterial.prototype as { setupLightingModel(): unknown }).setupLightingModel = () => new SunToonLightingModel();
}

installSunToon();
