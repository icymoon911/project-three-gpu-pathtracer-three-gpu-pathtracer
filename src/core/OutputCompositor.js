import { NormalBlending, AdditiveBlending, NoBlending } from 'three';

/**
 * OutputCompositor
 *
 * Handles the final output compositing that was previously embedded in
 * WebGLPathTracer.renderSample(). This includes:
 *
 * - Fade-in transition (fadeDuration): smoothly animates the path-traced output
 *   from transparent to opaque over a configurable duration.
 * - Dynamic low-res preview: when `dynamicLowRes` is enabled, renders a low-resolution
 *   path-traced preview underneath the fading-in full-res output using additive blending.
 * - Rasterized scene fallback: when path tracing is disabled, paused, or still compiling,
 *   falls back to a standard rasterized render of the scene.
 *
 * This compositor operates on top of the PathTracingRenderer's output (which handles its
 * own internal progressive alpha accumulation via _blendTargets). The two alpha layers are:
 *
 *   Layer 1 — PathTracingRenderer (internal): progressive sample accumulation with correct
 *             alpha compositing. The `target` getter returns the accumulated result.
 *
 *   Layer 2 — OutputCompositor (this class): visual fade-in transition from preview/fallback
 *             to the final path-traced output, using opacity animation and blending modes.
 *
 * These layers serve different purposes and cannot be merged: Layer 1 is about correct
 * pixel accumulation, Layer 2 is about the UX transition effect.
 */
export class OutputCompositor {

	constructor( renderer, quad ) {

		this._renderer = renderer;
		this._quad = quad;

	}

	/**
	 * Compose the final output to the canvas.
	 *
	 * @param {object} params - Compositing parameters:
	 *   pathTracer          - The full-resolution PathTracingRenderer.
	 *   lowResPathTracer    - The low-resolution PathTracingRenderer for dynamic preview.
	 *   scene               - The three.js Scene (for rasterized fallback).
	 *   camera              - The camera (for rasterized fallback).
	 *   samples             - Current sample count of the full-res path tracer.
	 *   minSamples          - Minimum samples before the output starts fading in.
	 *   fadeDuration        - Duration (ms) of the fade-in transition. 0 = instant.
	 *   dynamicLowRes       - Whether to show a low-res path-traced preview during fade-in.
	 *   enablePathTracing   - Whether path tracing is enabled.
	 *   rasterizeScene      - Whether to use rasterized fallback when available.
	 *   rasterizeSceneCallback  - Callback(scene, camera) to render the rasterized fallback.
	 *   renderToCanvasCallback  - Callback(target, renderer, quad) to render the quad to canvas.
	 *   isCompiling         - Whether the shader is still compiling.
	 *   delta               - Time since last frame (ms).
	 *   elapsedTime         - Total elapsed time since last reset (ms).
	 *   renderDelay         - Delay (ms) before path tracing output starts.
	 */
	compose( params ) {

		const {
			pathTracer,
			lowResPathTracer,
			scene,
			camera,
			samples,
			minSamples,
			fadeDuration,
			dynamicLowRes,
			enablePathTracing,
			rasterizeScene,
			rasterizeSceneCallback,
			renderToCanvasCallback,
			isCompiling,
			delta,
			elapsedTime,
			renderDelay,
		} = params;

		const renderer = this._renderer;
		const quad = this._quad;

		// Only begin fading in once the render delay has passed and we have enough samples
		if ( elapsedTime >= renderDelay && samples >= minSamples ) {

			if ( fadeDuration !== 0 ) {

				quad.material.opacity = Math.min( quad.material.opacity + delta / fadeDuration, 1 );

			} else {

				quad.material.opacity = 1;

			}

		}

		// Render the fallback layer underneath the fading-in path-traced output.
		// This is shown when: path tracing is disabled, not enough samples, or still fading in.
		if ( ! enablePathTracing || samples < minSamples || quad.material.opacity < 1 ) {

			// Dynamic low-res preview: a low-resolution path-traced image rendered in real time
			if ( dynamicLowRes && ! isCompiling ) {

				if ( lowResPathTracer.samples < 1 ) {

					lowResPathTracer.material = pathTracer.material;
					lowResPathTracer.update();

				}

				const currentOpacity = quad.material.opacity;
				quad.material.opacity = 1 - quad.material.opacity;
				quad.material.map = lowResPathTracer.target.texture;
				quad.render( renderer );
				quad.material.opacity = currentOpacity;

			}

			// Rasterized scene fallback: standard three.js render when low-res is not available
			if ( ! dynamicLowRes && rasterizeScene || dynamicLowRes && isCompiling ) {

				rasterizeSceneCallback( scene, camera );

			}

		}

		// Render the full-resolution path-traced output on top, with the current fade opacity.
		// When dynamicLowRes is active and opacity < 1, use additive blending so the low-res
		// preview shows through as the full-res image fades in.
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

}
