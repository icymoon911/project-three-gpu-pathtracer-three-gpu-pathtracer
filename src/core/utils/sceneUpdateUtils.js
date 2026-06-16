function uuidSort( a, b ) {

	if ( a.uuid < b.uuid ) return 1;
	if ( a.uuid > b.uuid ) return - 1;
	return 0;

}

// we must hash the texture to determine uniqueness using the encoding, as well, because the
// when rendering each texture to the texture array they must have a consistent color space.
export function getTextureHash( t ) {

	return `${ t.source.uuid }:${ t.colorSpace }`;

}

// reduce the set of textures to just those with a unique source while retaining
// the order of the textures.
function reduceTexturesToUniqueSources( textures ) {

	const sourceSet = new Set();
	const result = [];
	for ( let i = 0, l = textures.length; i < l; i ++ ) {

		const tex = textures[ i ];
		const hash = getTextureHash( tex );
		if ( ! sourceSet.has( hash ) ) {

			sourceSet.add( hash );
			result.push( tex );

		}

	}

	return result;

}

export function getIesTextures( lights ) {

	const textures = lights.map( l => l.iesMap || null ).filter( t => t );
	const textureSet = new Set( textures );
	return Array.from( textureSet ).sort( uuidSort );

}

export function getTextures( materials ) {

	const textureSet = new Set();
	for ( let i = 0, l = materials.length; i < l; i ++ ) {

		const material = materials[ i ];
		for ( const key in material ) {

			const value = material[ key ];
			if ( value && value.isTexture ) {

				textureSet.add( value );

			}

		}

	}

	const textureArray = Array.from( textureSet );
	return reduceTexturesToUniqueSources( textureArray ).sort( uuidSort );

}

/**
 * Collect all visible light objects.
 *
 * Accepts either a single `Scene` (or any Object3D — its subtree is
 * traversed) **or** an array of Object3D roots, each of whose subtrees is
 * traversed. This single entry point replaces the two duplicated versions
 * that previously lived here and inside `PathTracingSceneGenerator`.
 *
 * @param {Object3D|Object3D[]} sceneOrObjects
 * @returns {Array} sorted array of light objects
 */
export function getLights( sceneOrObjects ) {

	const lights = [];
	const roots = Array.isArray( sceneOrObjects ) ? sceneOrObjects : [ sceneOrObjects ];

	for ( let r = 0, rl = roots.length; r < rl; r ++ ) {

		roots[ r ].traverse( c => {

			if ( c.visible ) {

				if (
					c.isRectAreaLight ||
					c.isSpotLight ||
					c.isPointLight ||
					c.isDirectionalLight
				) {

					lights.push( c );

				}

			}

		} );

	}

	return lights.sort( uuidSort );

}
