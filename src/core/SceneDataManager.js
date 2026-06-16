import { GradientEquirectTexture } from '../textures/GradientEquirectTexture.js';
import { CubeToEquirectGenerator } from '../utils/CubeToEquirectGenerator.js';
import { getIesTextures, getLights, getTextures } from './utils/sceneUpdateUtils.js';

/**
 * SceneDataManager
 *
 * Owns all scene-data synchronization between the three.js scene graph and the
 * path-tracing material uniforms: materials/textures, lights, and environment /
 * background maps. WebGLPathTracer delegates to this class instead of holding
 * the logic inline.
 *
 * Batch mode
 * ----------
 * Each public `update*()` method normally fires the `onDirty` callback (which
 * the owner wires to `reset()`) so the path-tracing sample buffer is cleared
 * whenever scene data changes. When several updates happen together — e.g.
 * during `_updateFromResults` after `setScene` — that would reset the buffer
 * once per update, throwing away accumulated samples needlessly.
 *
 * Call `beginBatch()` before the first update and `endBatch()` after the last
 * to collapse all dirty notifications into a single callback at the end.
 */
export class SceneDataManager {

	constructor( renderer, pathTracer, options = {} ) {

		this._renderer = renderer;
		this._pathTracer = pathTracer;

		// Reference to the owner's textureSize Vector2 so we always read the
		// latest value without the owner having to push it to us.
		this._textureSize = options.textureSize;

		// Called when scene data changes (wired to WebGLPathTracer.reset).
		this._onDirty = options.onDirty || ( () => {} );

		this._materials = null;
		this._previousEnvironment = null;
		this._previousBackground = null;
		this._internalBackground = null;
		this._colorBackground = null;

		// The scene currently being managed. Set by the owner before calling
		// updateLights / updateEnvironment.
		this.scene = null;

		// When true, update methods suppress the onDirty callback so a series
		// of updates can be batched into a single reset.
		this._batchMode = false;
		this._batchDirty = false;

	}

	get materials() {

		return this._materials;

	}

	set materials( v ) {

		this._materials = v;

	}

	// --- batch API ---------------------------------------------------------

	beginBatch() {

		this._batchMode = true;
		this._batchDirty = false;

	}

	endBatch() {

		const wasDirty = this._batchDirty;
		this._batchMode = false;
		this._batchDirty = false;

		if ( wasDirty ) {

			this._onDirty();

		}

	}

	_markDirty() {

		if ( this._batchMode ) {

			this._batchDirty = true;

		} else {

			this._onDirty();

		}

	}

	// --- update methods ----------------------------------------------------

	updateMaterials() {

		const material = this._pathTracer.material;
		const renderer = this._renderer;
		const materials = this._materials;
		const textureSize = this._textureSize;

		// reduce texture sources here - we don't want to do this in the
		// textures array because we need to pass the textures array into the
		// material target
		const textures = getTextures( materials );
		material.textures.setTextures( renderer, textures, textureSize.x, textureSize.y );
		material.materials.updateFrom( materials, textures );

		this._markDirty();

	}

	updateLights() {

		const scene = this.scene;
		const renderer = this._renderer;
		const material = this._pathTracer.material;

		const lights = getLights( scene );
		const iesTextures = getIesTextures( lights );
		material.lights.updateFrom( lights, iesTextures );
		material.iesProfiles.setTextures( renderer, iesTextures );

		this._markDirty();

	}

	updateEnvironment() {

		const scene = this.scene;
		const material = this._pathTracer.material;
		const renderer = this._renderer;

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

		this._markDirty();

	}

	dispose() {

		if ( this._internalBackground ) {

			this._internalBackground.dispose();
			this._internalBackground = null;

		}

	}

}
