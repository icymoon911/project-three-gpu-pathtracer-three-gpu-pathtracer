import { Vector2, NoBlending, NormalBlending, AdditiveBlending } from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { ClampedInterpolationMaterial } from '../materials/fullscreen/ClampedInterpolationMaterial.js';

const _resolution = new Vector2();

function supportsFloatBlending( renderer ) {

	return renderer.extensions.get( 'EXT_float_blend' );

}

/**
 * OutputCompositor
 *
 * Responsible for the final screen-space composition that happens inside
 * `WebGLPathTracer.renderSample()`. It owns three pieces of behaviour that
 * were previously interleaved with the rendering loop and therefore hard to
 * follow in isolation:
 *
 * 1. **Fade-in transition** (`fadeDuration`). After a scene change the path-
 *    traced output is faded from 0→1 opacity over `fadeDuration` ms using a
 *    full-screen quad with `ClampedInterpolationMaterial`.
 *
 * 2. **Low-resolution preview fallback** (`dynamicLowRes`). While the sample
 *    count is below `minSamples` (or path tracing is paused / disabled) a
 *    low-resolution path-traced texture is rendered underneath the full-res
 *    output using additive blending so the two fade into each other.
 *
 * 3. **Rasterized fallback**. When `dynamicLowRes` is off (or the shader is
 *    still compiling) a regular three.js rasterized pass is drawn instead.
 *
 * Alpha compositing happens at TWO distinct levels in this codebase; this
 * class is level 2. See `PathTracingRenderer.renderTask` (level 1) for the
 * other:
 *
 *   Level 1 – PathTracingRenderer (`_blendTargets` + BlendMaterial):
 *     Accumulates each new path-traced sample into an internal floating-point
 *     target with proper alpha-weighted blending. The `target` getter returns
 *     the current accumulated result. This level is about mathematically
 *     correct sample accumulation with transparency.
 *
 *   Level 2 – OutputCompositor (this class, via `_quad`):
 *     Takes the accumulated `target.texture` and fades it onto the canvas
 *     over time, optionally layered on top of a low-res or rasterized
 *     fallback. This level is about the visual transition the user sees.
 *
 * The two layers cannot be merged because they operate on different time
 * scales: level 1 runs once per sample (sub-frame tiles) while level 2 runs
 * once per rendered frame and is driven by wall-clock time (fadeDuration).
 */
export class OutputCompositor {

	constructor( renderer, pathTracer, lowResPathTracer ) {

		this._renderer = renderer;
		this._pathTracer = pathTracer;
		this._lowResPathTracer = lowResPathTracer;

		this._quad = new FullScreenQuad( new ClampedInterpolationMaterial( {
			map: null,
			transparent: true,
			blending: NoBlending,
			premultipliedAlpha: renderer.getContextAttributes().premultipliedAlpha,
		} ) );

	}

	get quad() {

		return this._quad;

	}

	/**
	 * Resize both path tracers to match the renderer's drawing buffer size,
	 * honouring `renderScale` and `lowResScale`. Called from renderSample()
	 * before any rendering takes place.
	 */
	updateScale( state ) {

		if ( ! state.synchronizeRenderSize ) return;

		const renderer = this._renderer;
		const pathTracer = this._pathTracer;
		const lowResPathTracer = this._lowResPathTracer;

		renderer.getDrawingBufferSize( _resolution );

		const w = Math.floor( state.renderScale * _resolution.x );
		const h = Math.floor( state.renderScale * _resolution.y );

		pathTracer.getSize( _resolution );
		if ( _resolution.x !== w || _resolution.y !== h ) {

			const lowResScale = state.lowResScale;
			pathTracer.setSize( w, h );
			lowResPathTracer.setSize(
				Math.floor( w * lowResScale ),
				Math.floor( h * lowResScale ),
			);

		}

	}

	/**
	 * Push the path-traced result to the canvas, handling fade-in, low-res
	 * preview blending and rasterized fallback.
	 *
	 * @param {object} state  The current WebGLPathTracer state snapshot.
	 */
	render( state ) {

		const renderer = this._renderer;
		const pathTracer = this._pathTracer;
		const lowResPathTracer = this._lowResPathTracer;
		const quad = this._quad;

		const {
			delta,
			elapsedTime,
			enablePathTracing,
			minSamples,
			fadeDuration,
			dynamicLowRes,
			rasterizeScene,
			isCompiling,
			samples,
			renderDelay,
			scene,
			camera,
			rasterizeSceneCallback,
			renderToCanvasCallback,
		} = state;

		// Configure alpha mode on both path tracers. Alpha is required when
		// either the background is partially transparent or the hardware does
		// not support float blending (in which case we emulate it in shader).
		const useAlpha = pathTracer.material.backgroundAlpha !== 1 || ! supportsFloatBlending( renderer );
		pathTracer.alpha = useAlpha;
		lowResPathTracer.alpha = useAlpha;

		// --- fade-in opacity -------------------------------------------------
		if ( elapsedTime >= renderDelay && samples >= minSamples ) {

			if ( fadeDuration !== 0 ) {

				quad.material.opacity = Math.min( quad.material.opacity + delta / fadeDuration, 1 );

			} else {

				quad.material.opacity = 1;

			}

		}

		// --- fallback layer (behind the full-res output) ---------------------
		// Rendered whenever the full-res result isn't fully visible yet:
		// either not enough samples, path tracing disabled, or still fading in.
		const needsFallback = ! enablePathTracing || samples < minSamples || quad.material.opacity < 1;
		if ( needsFallback ) {

			if ( dynamicLowRes && ! isCompiling ) {

				if ( lowResPathTracer.samples < 1 ) {

					lowResPathTracer.material = pathTracer.material;
					lowResPathTracer.update();

				}

				// Draw the low-res texture with inverted opacity so it shows
				// through exactly where the full-res output is still transparent.
				const currentOpacity = quad.material.opacity;
				quad.material.opacity = 1 - quad.material.opacity;
				quad.material.map = lowResPathTracer.target.texture;
				quad.render( renderer );
				quad.material.opacity = currentOpacity;

			}

			if ( ! dynamicLowRes && rasterizeScene || dynamicLowRes && isCompiling ) {

				rasterizeSceneCallback( scene, camera );

			}

		}

		// --- full-res path-traced layer --------------------------------------
		if ( enablePathTracing && quad.material.opacity > 0 ) {

			if ( quad.material.opacity < 1 ) {

				// use additive blending when the low res texture is rendered so we can fade the
				// background out while the full res fades in
				quad.material.blending = dynamicLowRes ? AdditiveBlending : NormalBlending;

			}

			quad.material.map = pathTracer.target.texture;
			renderToCanvasCallback( pathTracer.target, renderer, quad );
			quad.material.blending = NoBlending;

		}

	}

	dispose() {

		this._quad.dispose();
		this._quad.material.dispose();

	}

}
