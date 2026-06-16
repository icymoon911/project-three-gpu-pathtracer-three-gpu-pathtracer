import { GradientEquirectTexture } from '../textures/GradientEquirectTexture.js';
import { CubeToEquirectGenerator } from '../utils/CubeToEquirectGenerator.js';
import { getLights, getTextures } from './utils/sceneUpdateUtils.js';

/**
 * SceneDataManager
 *
 * Owns all scene-data update logic (materials, lights, environment/background) that was
 * previously embedded in WebGLPathTracer. It writes directly into the path-tracing
 * material's uniforms but does NOT trigger a sample reset — the caller (WebGLPathTracer)
 * is responsible for calling reset() at the appropriate time. This makes it possible to
 * batch several updates (e.g. during setScene) and reset only once at the end.
 *
 * Extending the system with a new scene-data type (e.g. volumetric fog configuration)
 * only requires adding a new update method here; WebGLPathTracer does not need to change.
 */
export class SceneDataManager {

	constructor( renderer, pathTracer, lowResPathTracer ) {

		this._renderer = renderer;
		this._pathTracer = pathTracer;
		this._lowResPathTracer = lowResPathTracer;

		this._materials = null;
		this._previousEnvironment = null;
		this._previousBackground = null;
		this._internalBackground = null;
		this._colorBackground = null;

	}

	setMaterials( materials ) {

		this._materials = materials;

	}

	/**
	 * Update material textures and property data on the path-tracing material.
	 * Does not call reset — caller is responsible for that.
	 *
	 * @param {Vector2} textureSize - The texture atlas size (x = width, y = height).
	 */
	updateMaterials( textureSize ) {

		const material = this._pathTracer.material;
		const renderer = this._renderer;
		const materials = this._materials;

		// reduce texture sources here - we don't want to do this in the
		// textures array because we need to pass the textures array into the
		// material target
		const textures = getTextures( materials );
		material.textures.setTextures( renderer, textures, textureSize.x, textureSize.y );
		material.materials.updateFrom( materials, textures );

	}

	/**
	 * Update light information on the path-tracing material from the given scene.
	 * Does not call reset — caller is responsible for that.
	 *
	 * @param {Scene|Object3D} scene - The scene (or root object) whose visible lights are collected.
	 */
	updateLights( scene ) {

		const renderer = this._renderer;
		const material = this._pathTracer.material;

		const { lights, iesTextures } = getLights( scene );
		material.lights.updateFrom( lights, iesTextures );
		material.iesProfiles.setTextures( renderer, iesTextures );

	}

	/**
	 * Update environment map and background on the path-tracing material from the given scene.
	 * Handles color backgrounds, cube-texture conversion, equirect maps, and intensity/rotation.
	 * Does not call reset — caller is responsible for that.
	 *
	 * @param {Scene} scene - The three.js Scene whose .background and .environment are used.
	 */
	updateEnvironment( scene ) {

		const renderer = this._renderer;
		const material = this._pathTracer.material;

		if ( this._internalBackground ) {

			this._internalBackground.dispose();
			this._internalBackground = null;

		}

		// update scene background
		material.backgroundBlur = scene.backgroundBlurriness;
		material.backgroundIntensity = scene.backgroundIntensity ?? 1;
		material.backgroundRotation.makeRotationFromEuler( scene.backgroundRotation ).invert();
		if ( scene.background === null ) {

			material.backgroundMap = null;
			material.backgroundAlpha = 0;

		} else if ( scene.background.isColor ) {

			this._colorBackground = this._colorBackground || new GradientEquirectTexture( 16 );

			const colorBackground = this._colorBackground;
			if ( ! colorBackground.topColor.equals( scene.background ) ) {

				// set the texture color
				colorBackground.topColor.set( scene.background );
				colorBackground.bottomColor.set( scene.background );
				colorBackground.update();

			}

			// assign to material
			material.backgroundMap = colorBackground;
			material.backgroundAlpha = 1;

		} else if ( scene.background.isCubeTexture ) {

			if ( scene.background !== this._previousBackground ) {

				const background = new CubeToEquirectGenerator( renderer ).generate( scene.background );
				this._internalBackground = background;
				material.backgroundMap = background;
				material.backgroundAlpha = 1;

			}

		} else {

			material.backgroundMap = scene.background;
			material.backgroundAlpha = 1;

		}

		// update scene environment
		material.environmentIntensity = scene.environment !== null ? ( scene.environmentIntensity ?? 1 ) : 0;
		material.environmentRotation.makeRotationFromEuler( scene.environmentRotation ).invert();
		if ( this._previousEnvironment !== scene.environment ) {

			if ( scene.environment !== null ) {

				if ( scene.environment.isCubeTexture ) {

					const environment = new CubeToEquirectGenerator( renderer ).generate( scene.environment );
					material.envMapInfo.updateFrom( environment );

				} else {

					// TODO: Consider setting this to the highest supported bit depth by checking for
					// OES_texture_float_linear or OES_texture_half_float_linear. Requires changes to
					// the equirect uniform
					material.envMapInfo.updateFrom( scene.environment );

				}

			}

		}

		this._previousEnvironment = scene.environment;
		this._previousBackground = scene.background;

	}

	/**
	 * Dispose any internally-created resources (e.g. converted equirect backgrounds).
	 */
	dispose() {

		if ( this._internalBackground ) {

			this._internalBackground.dispose();
			this._internalBackground = null;

		}

	}

}
