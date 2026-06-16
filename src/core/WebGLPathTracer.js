import { PerspectiveCamera, Scene, Vector2, Clock, NormalBlending, NoBlending, AdditiveBlending, WebGLRenderTarget, RGBAFormat, FloatType, LinearFilter, NearestFilter } from 'three';
import { PathTracingSceneGenerator } from './PathTracingSceneGenerator.js';
import { PathTracingRenderer } from './PathTracingRenderer.js';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { GradientEquirectTexture } from '../textures/GradientEquirectTexture.js';
import { getIesTextures, getLights, getTextures } from './utils/sceneUpdateUtils.js';
import { ClampedInterpolationMaterial } from '../materials/fullscreen/ClampedInterpolationMaterial.js';
import { CubeToEquirectGenerator } from '../utils/CubeToEquirectGenerator.js';
import { DenoiseMaterial } from '../materials/fullscreen/DenoiseMaterial.js';
import { DenoiseLerpMaterial } from '../materials/fullscreen/DenoiseLerpMaterial.js';

function supportsFloatBlending( renderer ) {

	return renderer.extensions.get( 'EXT_float_blend' );

}

const _resolution = new Vector2();
export class WebGLPathTracer {

	get multipleImportanceSampling() {

		return Boolean( this._pathTracer.material.defines.FEATURE_MIS );

	}

	set multipleImportanceSampling( v ) {

		this._pathTracer.material.setDefine( 'FEATURE_MIS', v ? 1 : 0 );

	}

	get transmissiveBounces() {

		return this._pathTracer.material.transmissiveBounces;

	}

	set transmissiveBounces( v ) {

		this._pathTracer.material.transmissiveBounces = v;

	}

	get bounces() {

		return this._pathTracer.material.bounces;

	}

	set bounces( v ) {

		this._pathTracer.material.bounces = v;

	}

	get filterGlossyFactor() {

		return this._pathTracer.material.filterGlossyFactor;

	}

	set filterGlossyFactor( v ) {

		this._pathTracer.material.filterGlossyFactor = v;

	}

	get samples() {

		return this._pathTracer.samples;

	}

	get target() {

		return this._pathTracer.target;

	}

	get tiles() {

		return this._pathTracer.tiles;

	}

	get stableNoise() {

		return this._pathTracer.stableNoise;

	}

	set stableNoise( v ) {

		this._pathTracer.stableNoise = v;

	}

	get isCompiling() {

		return Boolean( this._pathTracer.isCompiling );

	}

	// Whether the denoise pass is currently producing a visible effect on the
	// displayed output (i.e. enableDenoise is true and the blend factor > 0).
	get isDenoiseActive() {

		return this.enableDenoise && this._getDenoiseBlendFactor( this.samples ) > 0;

	}

	constructor( renderer ) {

		// members
		this._renderer = renderer;
		this._generator = new PathTracingSceneGenerator();
		this._pathTracer = new PathTracingRenderer( renderer );
		this._queueReset = false;
		this._clock = new Clock();
		this._compilePromise = null;

		this._lowResPathTracer = new PathTracingRenderer( renderer );
		this._lowResPathTracer.tiles.set( 1, 1 );
		this._quad = new FullScreenQuad( new ClampedInterpolationMaterial( {
			map: null,
			transparent: true,
			blending: NoBlending,

			premultipliedAlpha: renderer.getContextAttributes().premultipliedAlpha,
		} ) );
		this._materials = null;

		this._previousEnvironment = null;
		this._previousBackground = null;
		this._internalBackground = null;

		// --- Denoise pass internals -----------------------------------------
		// DenoiseMaterial used for the bilateral-filter pass.  toneMapped is
		// disabled so the intermediate render target stays in linear HDR.
		this._denoiseMaterial = new DenoiseMaterial( { toneMapped: false } );
		this._denoiseQuad = new FullScreenQuad( this._denoiseMaterial );

		// Lerp material used to blend between raw and denoised output.
		this._denoiseLerpMaterial = new DenoiseLerpMaterial();
		this._denoiseLerpQuad = new FullScreenQuad( this._denoiseLerpMaterial );

		// Full-resolution denoise output (may be at reduced resolution when
		// denoiseResolution < 1).  LinearFilter gives smooth upsampling.
		this._denoiseTarget = new WebGLRenderTarget( 1, 1, {
			format: RGBAFormat,
			type: FloatType,
			magFilter: LinearFilter,
			minFilter: LinearFilter,
		} );

		// Full-resolution blend target – the lerp between raw and denoised.
		this._denoiseBlendTarget = new WebGLRenderTarget( 1, 1, {
			format: RGBAFormat,
			type: FloatType,
			magFilter: NearestFilter,
			minFilter: NearestFilter,
		} );

		// Low-resolution counterparts (same layout, smaller dimensions).
		this._denoiseLowResTarget = new WebGLRenderTarget( 1, 1, {
			format: RGBAFormat,
			type: FloatType,
			magFilter: LinearFilter,
			minFilter: LinearFilter,
		} );

		this._denoiseLowResBlendTarget = new WebGLRenderTarget( 1, 1, {
			format: RGBAFormat,
			type: FloatType,
			magFilter: NearestFilter,
			minFilter: NearestFilter,
		} );

		// Tracks whether the targetSamples callback has already fired for the
		// current accumulation run.
		this._denoiseFired = false;

		// options
		this.renderDelay = 100;
		this.minSamples = 5;
		this.fadeDuration = 500;
		this.enablePathTracing = true;
		this.pausePathTracing = false;
		this.dynamicLowRes = false;
		this.lowResScale = 0.25;
		this.renderScale = 1;
		this.synchronizeRenderSize = true;
		this.rasterizeScene = true;
		this.renderToCanvas = true;
		this.textureSize = new Vector2( 1024, 1024 );

		// --- Denoise options ------------------------------------------------
		this.enableDenoise = false;

		// Resolution multiplier for the denoise render target (0–1).  Values
		// below 1 trade quality for performance at high canvas resolutions.
		this.denoiseResolution = 1.0;

		// When true the bilateral-filter parameters are automatically adjusted
		// based on the current sample count.
		this.denoiseAutoAdjust = true;

		// Multiplier that controls how aggressive the auto-adjusted denoise
		// parameters are.  Higher = stronger denoise at every sample count.
		this.denoiseAggressiveness = 1.0;

		// Manual overrides – when non-null these take priority over the
		// auto-adjusted values.
		this.denoiseSigma = null;
		this.denoiseKSigma = null;
		this.denoiseThreshold = null;

		// Sample-count range over which the output transitions from fully
		// denoised (at denoiseFadeStartSamples) to fully raw (at
		// denoiseFadeEndSamples).  Uses a smoothstep curve.
		this.denoiseFadeStartSamples = 5;
		this.denoiseFadeEndSamples = 100;

		// When > 0, onTargetSamplesReached is invoked once the path-traced
		// sample count first reaches this value.
		this.targetSamples = 0;
		this.onTargetSamplesReached = null;

		this.rasterizeSceneCallback = ( scene, camera ) => {

			this._renderer.render( scene, camera );

		};

		this.renderToCanvasCallback = ( target, renderer, quad ) => {

			const currentAutoClear = renderer.autoClear;
			renderer.autoClear = false;
			quad.render( renderer );
			renderer.autoClear = currentAutoClear;

		};

		// initialize the scene so it doesn't fail
		this.setScene( new Scene(), new PerspectiveCamera() );

	}

	setBVHWorker( worker ) {

		this._generator.setBVHWorker( worker );

	}

	setScene( scene, camera, options = {} ) {

		scene.updateMatrixWorld( true );
		camera.updateMatrixWorld();

		const generator = this._generator;
		generator.setObjects( scene );

		if ( this._buildAsync ) {

			return generator.generateAsync( options.onProgress ).then( result => {

				return this._updateFromResults( scene, camera, result );

			} );

		} else {

			const result = generator.generate();
			return this._updateFromResults( scene, camera, result );

		}

	}

	setSceneAsync( ...args ) {

		this._buildAsync = true;
		const result = this.setScene( ...args );
		this._buildAsync = false;

		return result;

	}

	setCamera( camera ) {

		this.camera = camera;
		this.updateCamera();

	}

	updateCamera() {

		const camera = this.camera;
		camera.updateMatrixWorld();

		this._pathTracer.setCamera( camera );
		this._lowResPathTracer.setCamera( camera );
		this.reset();

	}

	updateMaterials() {

		const material = this._pathTracer.material;
		const renderer = this._renderer;
		const materials = this._materials;
		const textureSize = this.textureSize;

		// reduce texture sources here - we don't want to do this in the
		// textures array because we need to pass the textures array into the
		// material target
		const textures = getTextures( materials );
		material.textures.setTextures( renderer, textures, textureSize.x, textureSize.y );
		material.materials.updateFrom( materials, textures );
		this.reset();

	}

	updateLights() {

		const scene = this.scene;
		const renderer = this._renderer;
		const material = this._pathTracer.material;

		const lights = getLights( scene );
		const iesTextures = getIesTextures( lights );
		material.lights.updateFrom( lights, iesTextures );
		material.iesProfiles.setTextures( renderer, iesTextures );
		this.reset();

	}

	updateEnvironment() {

		const scene = this.scene;
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

				const background = new CubeToEquirectGenerator( this._renderer ).generate( scene.background );
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

					const environment = new CubeToEquirectGenerator( this._renderer ).generate( scene.environment );
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
		this.reset();

	}

	_updateFromResults( scene, camera, results ) {

		const {
			materials,
			geometry,
			bvh,
			bvhChanged,
			needsMaterialIndexUpdate,
		} = results;

		this._materials = materials;

		const pathTracer = this._pathTracer;
		const material = pathTracer.material;

		if ( bvhChanged ) {

			material.bvh.updateFrom( bvh );
			material.attributesArray.updateFrom(
				geometry.attributes.normal,
				geometry.attributes.tangent,
				geometry.attributes.uv,
				geometry.attributes.color,
			);

		}

		if ( needsMaterialIndexUpdate ) {

			material.materialIndexAttribute.updateFrom( geometry.attributes.materialIndex );

		}

		// save previously used items
		this._previousScene = scene;
		this.scene = scene;
		this.camera = camera;

		this.updateCamera();
		this.updateMaterials();
		this.updateEnvironment();
		this.updateLights();

		return results;

	}

	// ---------------------------------------------------------------------
	// Denoise helpers
	// ---------------------------------------------------------------------

	// Returns a value in [0, 1] describing how much of the denoised image
	// should be blended with the raw output.  1 = fully denoised, 0 = raw.
	_getDenoiseBlendFactor( samples ) {

		const start = this.denoiseFadeStartSamples;
		const end = this.denoiseFadeEndSamples;
		if ( end <= start ) return samples <= start ? 1.0 : 0.0;
		if ( samples <= start ) return 1.0;
		if ( samples >= end ) return 0.0;
		const t = ( samples - start ) / ( end - start );
		// Inverted smoothstep: 1 at t=0, 0 at t=1
		return 1.0 - t * t * ( 3.0 - 2.0 * t );

	}

	// Push auto-adjusted (or manually overridden) bilateral-filter parameters
	// into the DenoiseMaterial uniforms based on the current sample count.
	_updateDenoiseUniforms( samples ) {

		const mat = this._denoiseMaterial;
		const agg = this.denoiseAggressiveness;
		const start = this.denoiseFadeStartSamples;
		const end = this.denoiseFadeEndSamples;
		const t = Math.max( 0, Math.min( 1, ( samples - start ) / ( end - start ) ) );

		if ( this.denoiseAutoAdjust ) {

			mat.sigma = this.denoiseSigma !== null
				? this.denoiseSigma
				: 5.0 * agg * ( 1.0 - t ) + 0.5;
			mat.kSigma = this.denoiseKSigma !== null
				? this.denoiseKSigma
				: 1.0 * agg * ( 1.0 - t * 0.5 ) + 0.5;
			mat.threshold = this.denoiseThreshold !== null
				? this.denoiseThreshold
				: 0.03 * ( 1.0 - t * 0.5 ) + 0.01;

		} else {

			// Manual mode – use user-supplied values or sensible defaults.
			mat.sigma = this.denoiseSigma !== null ? this.denoiseSigma : 5.0;
			mat.kSigma = this.denoiseKSigma !== null ? this.denoiseKSigma : 1.0;
			mat.threshold = this.denoiseThreshold !== null ? this.denoiseThreshold : 0.03;

		}

	}

	// Run the bilateral-filter denoise pass: reads from `sourceTexture` and
	// writes the denoised result into `target` (a WebGLRenderTarget).
	_applyDenoise( sourceTexture, target ) {

		const renderer = this._renderer;
		const denoiseQuad = this._denoiseQuad;

		this._denoiseMaterial.map = sourceTexture;
		denoiseQuad.material = this._denoiseMaterial;

		const ogTarget = renderer.getRenderTarget();
		renderer.setRenderTarget( target );
		denoiseQuad.render( renderer );
		renderer.setRenderTarget( ogTarget );

	}

	// Blend between a raw texture and a denoised texture using `blendFactor`
	// (0 = raw, 1 = denoised) and write the result into `target`.
	_applyDenoiseBlend( rawTexture, denoisedTexture, blendFactor, target ) {

		const renderer = this._renderer;
		const lerpQuad = this._denoiseLerpQuad;

		this._denoiseLerpMaterial.rawMap = rawTexture;
		this._denoiseLerpMaterial.denoisedMap = denoisedTexture;
		this._denoiseLerpMaterial.blendFactor = blendFactor;
		lerpQuad.material = this._denoiseLerpMaterial;

		const ogTarget = renderer.getRenderTarget();
		renderer.setRenderTarget( target );
		lerpQuad.render( renderer );
		renderer.setRenderTarget( ogTarget );

	}

	// Resolve the texture that should be displayed for a given path-tracer
	// output.  Returns the appropriate texture (raw, denoised, or blended).
	_resolveDenoisedTexture( sourceTexture, denoiseTarget, blendTarget, denoiseFactor ) {

		this._applyDenoise( sourceTexture, denoiseTarget );

		if ( denoiseFactor < 1.0 ) {

			this._applyDenoiseBlend(
				sourceTexture,
				denoiseTarget.texture,
				denoiseFactor,
				blendTarget,
			);
			return blendTarget.texture;

		}

		return denoiseTarget.texture;

	}

	renderSample() {

		const lowResPathTracer = this._lowResPathTracer;
		const pathTracer = this._pathTracer;
		const renderer = this._renderer;
		const clock = this._clock;
		const quad = this._quad;

		this._updateScale();

		if ( this._queueReset ) {

			pathTracer.reset();
			lowResPathTracer.reset();
			this._queueReset = false;
			this._denoiseFired = false;

			quad.material.opacity = 0;
			clock.start();

		}

		// render the path tracing sample after enough time has passed
		const delta = clock.getDelta() * 1e3;
		const elapsedTime = clock.getElapsedTime() * 1e3;
		if ( ! this.pausePathTracing && this.enablePathTracing && this.renderDelay <= elapsedTime && ! this.isCompiling ) {

			pathTracer.update();

		}

		// when alpha is enabled we use a manual blending system rather than
		// rendering with a blend function
		pathTracer.alpha = pathTracer.material.backgroundAlpha !== 1 || ! supportsFloatBlending( renderer );
		lowResPathTracer.alpha = pathTracer.alpha;

		if ( this.renderToCanvas ) {

			const renderer = this._renderer;
			const minSamples = this.minSamples;
			const samples = this.samples;

			// --- Denoise bookkeeping ---
			const denoiseEnabled = this.enableDenoise;
			const denoiseFactor = denoiseEnabled
				? this._getDenoiseBlendFactor( samples )
				: 0;

			if ( denoiseEnabled && denoiseFactor > 0 ) {

				this._updateDenoiseUniforms( samples );

			}

			if ( elapsedTime >= this.renderDelay && this.samples >= this.minSamples ) {

				if ( this.fadeDuration !== 0 ) {

					quad.material.opacity = Math.min( quad.material.opacity + delta / this.fadeDuration, 1 );

				} else {

					quad.material.opacity = 1;

				}

			}

			// Fire target-samples callback (once per accumulation run).
			if ( this.targetSamples > 0 && samples >= this.targetSamples && ! this._denoiseFired ) {

				this._denoiseFired = true;
				if ( typeof this.onTargetSamplesReached === 'function' ) {

					this.onTargetSamplesReached( samples );

				}

			}

			// render the fallback if we haven't rendered enough samples, are paused, or are occluded
			if ( ! this.enablePathTracing || this.samples < minSamples || quad.material.opacity < 1 ) {

				if ( this.dynamicLowRes && ! this.isCompiling ) {

					if ( lowResPathTracer.samples < 1 ) {

						lowResPathTracer.material = pathTracer.material;
						lowResPathTracer.update();

					}

					// Determine the low-res display texture, applying denoise
					// when enabled so the preview is cleaner during the
					// accumulation phase.
					let lowResTexture = lowResPathTracer.target.texture;
					if ( denoiseEnabled && denoiseFactor > 0 ) {

						lowResTexture = this._resolveDenoisedTexture(
							lowResPathTracer.target.texture,
							this._denoiseLowResTarget,
							this._denoiseLowResBlendTarget,
							denoiseFactor,
						);

					}

					const currentOpacity = quad.material.opacity;
					quad.material.opacity = 1 - quad.material.opacity;
					quad.material.map = lowResTexture;
					quad.render( renderer );
					quad.material.opacity = currentOpacity;

				}

				if ( ! this.dynamicLowRes && this.rasterizeScene || this.dynamicLowRes && this.isCompiling ) {

					this.rasterizeSceneCallback( this.scene, this.camera );

				}

			}


			if ( this.enablePathTracing && quad.material.opacity > 0 ) {

				if ( quad.material.opacity < 1 ) {

					// use additive blending when the low res texture is rendered so we can fade the
					// background out while the full res fades in
					quad.material.blending = this.dynamicLowRes ? AdditiveBlending : NormalBlending;

				}

				// Determine the full-res display texture, applying denoise
				// when enabled.
				let displayTexture = pathTracer.target.texture;
				if ( denoiseEnabled && denoiseFactor > 0 ) {

					displayTexture = this._resolveDenoisedTexture(
						pathTracer.target.texture,
						this._denoiseTarget,
						this._denoiseBlendTarget,
						denoiseFactor,
					);

				}

				quad.material.map = displayTexture;
				this.renderToCanvasCallback( pathTracer.target, renderer, quad );
				quad.material.blending = NoBlending;

			}

		}

	}

	reset() {

		this._queueReset = true;
		this._pathTracer.samples = 0;

	}

	dispose() {

		this._quad.dispose();
		this._quad.material.dispose();
		this._pathTracer.dispose();

		// Denoise resources
		this._denoiseQuad.dispose();
		this._denoiseMaterial.dispose();
		this._denoiseLerpQuad.dispose();
		this._denoiseLerpMaterial.dispose();
		this._denoiseTarget.dispose();
		this._denoiseBlendTarget.dispose();
		this._denoiseLowResTarget.dispose();
		this._denoiseLowResBlendTarget.dispose();

	}

	_updateScale() {

		// update the path tracer scale if it has changed
		if ( this.synchronizeRenderSize ) {

			this._renderer.getDrawingBufferSize( _resolution );

			const w = Math.floor( this.renderScale * _resolution.x );
			const h = Math.floor( this.renderScale * _resolution.y );

			this._pathTracer.getSize( _resolution );
			if ( _resolution.x !== w || _resolution.y !== h ) {

				const lowResScale = this.lowResScale;
				this._pathTracer.setSize( w, h );
				this._lowResPathTracer.setSize( Math.floor( w * lowResScale ), Math.floor( h * lowResScale ) );

			}

			// Denoise targets – sized every frame so that changes to
			// denoiseResolution or lowResScale are picked up immediately.
			// WebGLRenderTarget.setSize is a no-op when the dimensions match.
			const denoiseRes = this.denoiseResolution;

			this._denoiseTarget.setSize(
				Math.max( 1, Math.floor( w * denoiseRes ) ),
				Math.max( 1, Math.floor( h * denoiseRes ) ),
			);
			this._denoiseBlendTarget.setSize( w, h );

			const lw = Math.floor( w * this.lowResScale );
			const lh = Math.floor( h * this.lowResScale );

			this._denoiseLowResTarget.setSize(
				Math.max( 1, Math.floor( lw * denoiseRes ) ),
				Math.max( 1, Math.floor( lh * denoiseRes ) ),
			);
			this._denoiseLowResBlendTarget.setSize(
				Math.max( 1, lw ),
				Math.max( 1, lh ),
			);

		}

	}

}
