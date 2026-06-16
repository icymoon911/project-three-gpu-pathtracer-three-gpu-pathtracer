import { PerspectiveCamera, Scene, Vector2, Clock } from 'three';
import { PathTracingSceneGenerator } from './PathTracingSceneGenerator.js';
import { PathTracingRenderer } from './PathTracingRenderer.js';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { ClampedInterpolationMaterial } from '../materials/fullscreen/ClampedInterpolationMaterial.js';
import { SceneDataManager } from './SceneDataManager.js';
import { OutputCompositor } from './OutputCompositor.js';

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

			premultipliedAlpha: renderer.getContextAttributes().premultipliedAlpha,
		} ) );

		this._sceneDataManager = new SceneDataManager( renderer, this._pathTracer, this._lowResPathTracer );
		this._compositor = new OutputCompositor( renderer, this._quad );

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

	/**
	 * Update camera uniforms on both path tracers and trigger a single sample reset.
	 */
	updateCamera() {

		const camera = this.camera;
		camera.updateMatrixWorld();

		this._pathTracer.setCamera( camera );
		this._lowResPathTracer.setCamera( camera );
		this.reset();

	}

	/**
	 * Update material data on the path-tracing material and trigger a sample reset.
	 * For batch updates (e.g. during setScene), use _sceneDataManager directly to
	 * avoid redundant resets.
	 */
	updateMaterials() {

		this._sceneDataManager.updateMaterials( this.textureSize );
		this.reset();

	}

	/**
	 * Update light data on the path-tracing material and trigger a sample reset.
	 * For batch updates (e.g. during setScene), use _sceneDataManager directly to
	 * avoid redundant resets.
	 */
	updateLights() {

		this._sceneDataManager.updateLights( this.scene );
		this.reset();

	}

	/**
	 * Update environment map and background on the path-tracing material and trigger
	 * a sample reset. For batch updates (e.g. during setScene), use _sceneDataManager
	 * directly to avoid redundant resets.
	 */
	updateEnvironment() {

		this._sceneDataManager.updateEnvironment( this.scene );
		this.reset();

	}

	/**
	 * Apply results from PathTracingSceneGenerator to the path-tracing material.
	 *
	 * All scene-data updates (materials, environment, lights) are batched through
	 * SceneDataManager WITHOUT triggering individual resets. A single reset is then
	 * performed by updateCamera() at the end, ensuring that a setScene call only
	 * clears accumulated samples once.
	 */
	_updateFromResults( scene, camera, results ) {

		const {
			materials,
			geometry,
			bvh,
			bvhChanged,
			needsMaterialIndexUpdate,
		} = results;

		this._sceneDataManager.setMaterials( materials );

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

		// Batch scene-data updates: materials, environment, and lights are all applied
		// without intermediate resets. updateCamera() triggers the single reset at the end.
		this._sceneDataManager.updateMaterials( this.textureSize );
		this._sceneDataManager.updateEnvironment( scene );
		this._sceneDataManager.updateLights( scene );
		this.updateCamera();

		return results;

	}

	/**
	 * Render one sample of the path-traced image and composite the result to the canvas.
	 *
	 * The rendering pipeline has two distinct alpha/compositing layers:
	 *
	 *   Layer 1 — PathTracingRenderer (internal): progressive sample accumulation with
	 *             correct alpha compositing via _blendTargets and BlendMaterial. This
	 *             produces the accumulated path-traced image in `pathTracer.target`.
	 *
	 *   Layer 2 — OutputCompositor (this method): takes the accumulated image from Layer 1
	 *             and composites it to the canvas with a fade-in transition, dynamic low-res
	 *             preview, and rasterized scene fallback.
	 *
	 * These layers serve different purposes and are intentionally kept separate.
	 */
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
		// rendering with a blend function (see PathTracingRenderer for details
		// on the internal alpha accumulation layer)
		pathTracer.alpha = pathTracer.material.backgroundAlpha !== 1 || ! supportsFloatBlending( renderer );
		lowResPathTracer.alpha = pathTracer.alpha;

		if ( this.renderToCanvas ) {

			this._compositor.compose( {
				pathTracer,
				lowResPathTracer,
				scene: this.scene,
				camera: this.camera,
				samples: this.samples,
				minSamples: this.minSamples,
				fadeDuration: this.fadeDuration,
				dynamicLowRes: this.dynamicLowRes,
				enablePathTracing: this.enablePathTracing,
				rasterizeScene: this.rasterizeScene,
				rasterizeSceneCallback: this.rasterizeSceneCallback,
				renderToCanvasCallback: this.renderToCanvasCallback,
				isCompiling: this.isCompiling,
				delta,
				elapsedTime,
				renderDelay: this.renderDelay,
			} );

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
		this._sceneDataManager.dispose();

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
