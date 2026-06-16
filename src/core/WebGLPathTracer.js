import { PerspectiveCamera, Scene, Vector2, Clock } from 'three';
import { PathTracingSceneGenerator } from './PathTracingSceneGenerator.js';
import { PathTracingRenderer } from './PathTracingRenderer.js';
import { SceneDataManager } from './SceneDataManager.js';
import { OutputCompositor } from './OutputCompositor.js';

/**
 * WebGLPathTracer
 *
 * High-level orchestrator. It delegates:
 *
 *  - Scene-data synchronization (materials, lights, environment maps) to
 *    `SceneDataManager`.
 *  - Path-traced sample accumulation to `PathTracingRenderer` (both the
 *    full-res `_pathTracer` and the low-res preview `_lowResPathTracer`).
 *  - Final screen-space compositing (fade-in, low-res preview overlay,
 *    rasterized fallback) to `OutputCompositor`.
 *
 * Public API (setScene, setSceneAsync, setCamera, updateCamera,
 * updateMaterials, updateLights, updateEnvironment, renderSample, reset,
 * dispose, plus all public getters/setters) is preserved for backward
 * compatibility with existing examples.
 */
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

		// Scene data manager: handles materials, lights and environment
		// uniforms. Wired to call `this.reset()` whenever any of them change.
		this._sceneData = new SceneDataManager( renderer, this._pathTracer, {
			textureSize: null, // assigned below once `this.textureSize` exists
			onDirty: () => this.reset(),
		} );

		// Output compositor: handles fade-in, low-res preview and rasterized
		// fallback composition on the canvas.
		this._compositor = new OutputCompositor(
			renderer,
			this._pathTracer,
			this._lowResPathTracer,
		);

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

		// Now that textureSize exists, point the scene-data manager at it.
		this._sceneData._textureSize = this.textureSize;

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
	 * Push the current camera into both path tracers and reset accumulated
	 * samples. When called inside a scene-data batch (e.g. from
	 * `_updateFromResults`) the reset is deferred until the batch ends.
	 */
	updateCamera() {

		const camera = this.camera;
		camera.updateMatrixWorld();

		this._pathTracer.setCamera( camera );
		this._lowResPathTracer.setCamera( camera );

		// Respect the scene-data manager's batch mode so a single setScene
		// only resets once, not once per sub-update.
		if ( this._sceneData._batchMode ) {

			this._sceneData._markDirty();

		} else {

			this.reset();

		}

	}

	// --- delegated scene-data updates --------------------------------------

	updateMaterials() {

		this._sceneData.updateMaterials();

	}

	updateLights() {

		this._sceneData.updateLights();

	}

	updateEnvironment() {

		this._sceneData.updateEnvironment();

	}

	_updateFromResults( scene, camera, results ) {

		const {
			materials,
			geometry,
			bvh,
			bvhChanged,
			needsMaterialIndexUpdate,
		} = results;

		const sceneData = this._sceneData;
		sceneData.materials = materials;

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

		// Point the scene-data manager at the new scene and batch all the
		// sub-updates so we only reset once at the end.
		sceneData.scene = scene;
		sceneData.beginBatch();
		this.updateCamera();
		sceneData.updateMaterials();
		sceneData.updateEnvironment();
		sceneData.updateLights();
		sceneData.endBatch();

		return results;

	}

	renderSample() {

		const pathTracer = this._pathTracer;
		const lowResPathTracer = this._lowResPathTracer;
		const clock = this._clock;
		const compositor = this._compositor;

		compositor.updateScale( {
			renderer: this._renderer,
			pathTracer,
			lowResPathTracer,
			synchronizeRenderSize: this.synchronizeRenderSize,
			renderScale: this.renderScale,
			lowResScale: this.lowResScale,
		} );

		if ( this._queueReset ) {

			pathTracer.reset();
			lowResPathTracer.reset();
			this._queueReset = false;

			compositor.quad.material.opacity = 0;
			clock.start();

		}

		// render the path tracing sample after enough time has passed
		const delta = clock.getDelta() * 1e3;
		const elapsedTime = clock.getElapsedTime() * 1e3;
		if ( ! this.pausePathTracing && this.enablePathTracing && this.renderDelay <= elapsedTime && ! this.isCompiling ) {

			pathTracer.update();

		}

		if ( this.renderToCanvas ) {

			compositor.render( {
				delta,
				elapsedTime,
				enablePathTracing: this.enablePathTracing,
				minSamples: this.minSamples,
				fadeDuration: this.fadeDuration,
				dynamicLowRes: this.dynamicLowRes,
				rasterizeScene: this.rasterizeScene,
				isCompiling: this.isCompiling,
				samples: this.samples,
				renderDelay: this.renderDelay,
				scene: this.scene,
				camera: this.camera,
				rasterizeSceneCallback: this.rasterizeSceneCallback,
				renderToCanvasCallback: this.renderToCanvasCallback,
			} );

		}

	}

	reset() {

		this._queueReset = true;
		this._pathTracer.samples = 0;

	}

	dispose() {

		this._compositor.dispose();
		this._pathTracer.dispose();
		this._sceneData.dispose();

	}

}
