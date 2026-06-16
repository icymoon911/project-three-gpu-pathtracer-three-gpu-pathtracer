import { NoBlending } from 'three';
import { MaterialBase } from '../MaterialBase.js';

// Internal material used to linearly interpolate between a raw path-traced
// texture and its denoised counterpart.  Outputs linear HDR data so the
// downstream ClampedInterpolationMaterial can still perform tone-mapping and
// colour-space conversion during the final display pass.
export class DenoiseLerpMaterial extends MaterialBase {

	constructor( parameters ) {

		super( {

			blending: NoBlending,
			transparent: false,
			depthWrite: false,
			depthTest: false,
			toneMapped: false,

			uniforms: {

				rawMap: { value: null },
				denoisedMap: { value: null },
				blendFactor: { value: 1.0 },

			},

			vertexShader: /* glsl */`

				varying vec2 vUv;

				void main() {

					vUv = uv;
					gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );

				}

			`,

			fragmentShader: /* glsl */`

				uniform sampler2D rawMap;
				uniform sampler2D denoisedMap;
				uniform float blendFactor;

				varying vec2 vUv;

				void main() {

					vec4 raw = texture2D( rawMap, vUv );
					vec4 denoised = texture2D( denoisedMap, vUv );
					gl_FragColor = mix( raw, denoised, blendFactor );

				}

			`,

		} );

		this.setValues( parameters );

	}

}
