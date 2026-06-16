import { PerspectiveCamera, Scene, Vector2, Clock, NormalBlending, NoBlending, AdditiveBlending, WebGLRenderTarget, RGBAFormat, FloatType, NearestFilter, ShaderMaterial } from 'three';
import { PathTracingSceneGenerator } from './PathTracingSceneGenerator.js';
import { PathTracingRenderer } from './PathTracingRenderer.js';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { GradientEquirectTexture } from '../textures/GradientEquirectTexture.js';
import { getIesTextures, getLights, getTextures } from './utils/sceneUpdateUtils.js';
import { ClampedInterpolationMaterial } from '../materials/fullscreen/ClampedInterpolationMaterial.js';
import { CubeToEquirectGenerator } from '../utils/CubeToEquirectGenerator.js';
import { DenoiseMaterial } from '../materials/fullscreen/DenoiseMaterial.js';

// Simple linear interpolation material for blending raw and denoised textures.
// Outputs mix(raw, denoised, blend) where blend=0 is raw and blend=1 is fully denoised.
function createDenoiseLerpMaterial() {

	const mat = new ShaderMaterial( {

		uniforms: {

			tRaw: { value: null },
			tDenoised: { value: null },
			blend: { value: 1.0 },

		},

		vertexShader: /* glsl */`
			varying vec2 vUv;
			void main() {
				vUv = uv;
				gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
			}
		`,

		fragmentShader: /* glsl */`
			uniform sampler2D tRaw;
			uniform sampler2D tDenoised;
			uniform float blend;
			varying vec2 vUv;
			void main() {
				vec4 raw = texture2D( tRaw, vUv );
				vec4 denoised = texture2D( tDenoised, vUv );
				gl_FragColor = mix( raw, denoised, blend );
			}
		`,

		blending: NoBlending,
		depthWrite: false,
		depthTest: false,

	} );

	return mat;

}

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

		// denoise members (lazily initialized)
		this._denoiseQuad = null;
		this._denoiseBlendQuad = null;
		this._denoiseTarget = null;
		this._denoiseBlendTarget = null;
		this._lowResDenoiseTarget = null;
		this._lowResBlendTarget = null;
		this._targetSamplesFired = false;

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
		this.rasterizeSceneCallback = ( scene, camera ) => {

			this._renderer.render( scene, camera );

		};

		this.renderToCanvasCallback = ( target, renderer, quad ) => {

			const currentAutoClear = renderer.autoClear;
			renderer.autoClear = false;
			quad.render( renderer );
			renderer.autoClear = currentAutoClear;

		};

		// denoise options
		this.enableDenoise = false;
		this.denoiseParams = { sigma: 5.0, threshold: 0.03, kSigma: 1.0 };
		this.denoiseAutoAdjust = 0.5; // 0..1: 0 = gentle falloff, 1 = aggressive falloff
		this.targetSamples = 200;
		this.denoiseResolution = 1.0; // scale factor for denoise render targets
		this.onTargetSamplesReached = null; // callback when samples >= targetSamples

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

	// ----------------------------------------------------------------
	// Denoise pipeline helpers
	// ----------------------------------------------------------------

	_initDenoise() {

		if ( this._denoiseQuad ) return;

		this._denoiseQuad = new FullScreenQuad( new DenoiseMaterial( {
			map: null,
			transparent: false,
			blending: NoBlending,
		} ) );

		this._denoiseBlendQuad = new FullScreenQuad( createDenoiseLerpMaterial() );

		const rtOptions = {
			format: RGBAFormat,
			type: FloatType,
			magFilter: NearestFilter,
			minFilter: NearestFilter,
		};

		this._denoiseTarget = new WebGLRenderTarget( 1, 1, rtOptions );
		this._denoiseBlendTarget = new WebGLRenderTarget( 1, 1, rtOptions );
		this._lowResDenoiseTarget = new WebGLRenderTarget( 1, 1, rtOptions );
		this._lowResBlendTarget = new WebGLRenderTarget( 1, 1, rtOptions );

	}

	_disposeDenoise() {

		if ( this._denoiseQuad ) {

			this._denoiseQuad.dispose();
			this._denoiseQuad.material.dispose();
			this._denoiseQuad = null;

		}

		if ( this._denoiseBlendQuad ) {

			this._denoiseBlendQuad.dispose();
			this._denoiseBlendQuad.material.dispose();
			this._denoiseBlendQuad = null;

		}

		if ( this._denoiseTarget ) {

			this._denoiseTarget.dispose();
			this._denoiseTarget = null;

		}

		if ( this._denoiseBlendTarget ) {

			this._denoiseBlendTarget.dispose();
			this._denoiseBlendTarget = null;

		}

		if ( this._lowResDenoiseTarget ) {

			this._lowResDenoiseTarget.dispose();
			this._lowResDenoiseTarget = null;

		}

		if ( this._lowResBlendTarget ) {

			this._lowResBlendTarget.dispose();
			this._lowResBlendTarget = null;

		}

	}

	// Compute denoise strength based on current samples and target samples.
	// Returns a value in [0, 1] where 1 = full denoise, 0 = no denoise.
	_computeDenoiseStrength( samples ) {

		const target = this.targetSamples;
		if ( target <= 0 ) return 0;

		const t = Math.min( samples / target, 1.0 );

		// Higher denoiseAutoAdjust = faster strength falloff
		// denoiseAutoAdjust=0 -> exponent=1 (linear), 0.5 -> exponent=3, 1.0 -> exponent=5
		const exponent = 1.0 + this.denoiseAutoAdjust * 4.0;
		return Math.pow( 1.0 - t, exponent );

	}

	// Apply denoise pipeline to a source texture.
	// Returns the texture that should be used for display.
	// sourceTexture: the raw path tracer output texture
	// strength: denoise strength [0, 1]
	// denoiseTarget: WebGLRenderTarget for denoised output
	// blendTarget: WebGLRenderTarget for blended output
	_applyDenoise( sourceTexture, strength, denoiseTarget, blendTarget ) {

		// Below this threshold, skip denoise entirely and use raw
		if ( strength <= 0.01 ) {

			return sourceTexture;

		}

		this._initDenoise();

		const renderer = this._renderer;
		const denoiseQuad = this._denoiseQuad;
		const blendQuad = this._denoiseBlendQuad;

		// Ensure targets are sized to match the source texture
		const sourceImage = sourceTexture.image;
		let srcW, srcH;
		if ( sourceImage ) {

			srcW = sourceImage.width;
			srcH = sourceImage.height;

		} else {

			// Fallback: use the render target dimensions
			srcW = sourceTexture.source.data.width || 1;
			srcH = sourceTexture.source.data.height || 1;

		}

		const denoiseScale = this.denoiseResolution;
		const dW = Math.max( 1, Math.floor( srcW * denoiseScale ) );
		const dH = Math.max( 1, Math.floor( srcH * denoiseScale ) );

		if ( denoiseTarget.width !== dW || denoiseTarget.height !== dH ) {

			denoiseTarget.setSize( dW, dH );

		}

		// Compute effective denoise params
		const baseParams = this.denoiseParams;
		const effectiveSigma = baseParams.sigma * strength;
		const effectiveThreshold = baseParams.threshold / Math.max( strength, 0.01 );
		const effectiveKSigma = baseParams.kSigma * strength;

		// Render denoise pass: sourceTexture → denoiseTarget
		const denoiseMat = denoiseQuad.material;
		denoiseMat.uniforms.map.value = sourceTexture;
		denoiseMat.uniforms.sigma.value = effectiveSigma;
		denoiseMat.uniforms.threshold.value = effectiveThreshold;
		denoiseMat.uniforms.kSigma.value = effectiveKSigma;
		denoiseMat.uniforms.opacity.value = 1.0;

		const ogRenderTarget = renderer.getRenderTarget();
		renderer.setRenderTarget( denoiseTarget );
		renderer.autoClear = true;
		denoiseQuad.render( renderer );
		renderer.setRenderTarget( ogRenderTarget );

		// If strength is near 1.0, use denoised directly (no blending needed)
		if ( strength >= 0.99 ) {

			return denoiseTarget.texture;

		}

		// Blend raw and denoised: mix(source, denoised, strength) → blendTarget
		if ( blendTarget.width !== dW || blendTarget.height !== dH ) {

			blendTarget.setSize( dW, dH );

		}

		const blendMat = blendQuad.material;
		blendMat.uniforms.tRaw.value = sourceTexture;
		blendMat.uniforms.tDenoised.value = denoiseTarget.texture;
		blendMat.uniforms.blend.value = strength;

		renderer.setRenderTarget( blendTarget );
		renderer.autoClear = true;
		blendQuad.render( renderer );
		renderer.setRenderTarget( ogRenderTarget );

		return blendTarget.texture;

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
			this._targetSamplesFired = false;

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

		// Compute denoise strength for the main path tracer
		const denoiseEnabled = this.enableDenoise;
		const denoiseStrength = denoiseEnabled ? this._computeDenoiseStrength( this.samples ) : 0;

		if ( this.renderToCanvas ) {

			const renderer = this._renderer;
			const minSamples = this.minSamples;

			if ( elapsedTime >= this.renderDelay && this.samples >= this.minSamples ) {

				if ( this.fadeDuration !== 0 ) {

					quad.material.opacity = Math.min( quad.material.opacity + delta / this.fadeDuration, 1 );

				} else {

					quad.material.opacity = 1;

				}

			}

			// render the fallback if we haven't rendered enough samples, are paused, or are occluded
			if ( ! this.enablePathTracing || this.samples < minSamples || quad.material.opacity < 1 ) {

				if ( this.dynamicLowRes && ! this.isCompiling ) {

					if ( lowResPathTracer.samples < 1 ) {

						lowResPathTracer.material = pathTracer.material;
						lowResPathTracer.update();

					}

					// Determine the texture to display for low-res preview
					let lowResTexture = lowResPathTracer.target.texture;
					if ( denoiseEnabled ) {

						// Denoise the low-res preview as well, using the same strength
						// (at low samples the strength is high, giving strong denoise)
						lowResTexture = this._applyDenoise(
							lowResTexture,
							denoiseStrength,
							this._lowResDenoiseTarget,
							this._lowResBlendTarget,
						);

					}

					const currentOpacity = quad.material.opacity;
					quad.material.opacity = 1 - quad.material.opacity;
					quad.material.map = lowResTexture;
					quad.render( renderer );
					quad.material.opacity = currentOpacity;

				}

				if ( ! this.dynamicLowRes && this.rasterizeScene || this.dynamicLowRes && this.isCompiling ) {

					// During compilation with dynamicLowRes, show the rasterized scene
					// Optionally denoise the low-res output if we have one from a previous frame
					if ( this.dynamicLowRes && this.isCompiling && denoiseEnabled && lowResPathTracer.samples >= 1 ) {

						let lowResTexture = lowResPathTracer.target.texture;
						lowResTexture = this._applyDenoise(
							lowResTexture,
							denoiseStrength,
							this._lowResDenoiseTarget,
							this._lowResBlendTarget,
						);

						const currentOpacity = quad.material.opacity;
						quad.material.opacity = 1 - quad.material.opacity;
						quad.material.map = lowResTexture;
						quad.render( renderer );
						quad.material.opacity = currentOpacity;

					}

					this.rasterizeSceneCallback( this.scene, this.camera );

				}

			}


			if ( this.enablePathTracing && quad.material.opacity > 0 ) {

				if ( quad.material.opacity < 1 ) {

					// use additive blending when the low res texture is rendered so we can fade the
					// background out while the full res fades in
					quad.material.blending = this.dynamicLowRes ? AdditiveBlending : NormalBlending;

				}

				// Determine the texture to display for the main path tracer output
				let displayTexture = pathTracer.target.texture;
				if ( denoiseEnabled ) {

					displayTexture = this._applyDenoise(
						displayTexture,
						denoiseStrength,
						this._denoiseTarget,
						this._denoiseBlendTarget,
					);

				}

				quad.material.map = displayTexture;
				this.renderToCanvasCallback( pathTracer.target, renderer, quad );
				quad.material.blending = NoBlending;

			}

			// Fire targetSamples callback
			if (
				! this._targetSamplesFired &&
				this.samples >= this.targetSamples &&
				this.onTargetSamplesReached
			) {

				this._targetSamplesFired = true;
				this.onTargetSamplesReached( this.samples );

			}

		}

	}

	reset() {

		this._queueReset = true;
		this._pathTracer.samples = 0;
		this._targetSamplesFired = false;

	}

	dispose() {

		this._quad.dispose();
		this._quad.material.dispose();
		this._pathTracer.dispose();
		this._disposeDenoise();

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

		}

	}

}
