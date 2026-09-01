# Solar Jumper

## Run locally

Serve this folder and open `index.html`. The current local development URL is:

`http://127.0.0.1:4173/index.html`

## Project structure

- `index.html` — modular development entry point.
- `styles/game.css` — interface styling.
- `src/game.js` — game world, controls, physics, terrain, and rendering.
- `src/config.js` — rendering and atmosphere quality settings.
- `src/runtime/adaptive-quality.js` — reversible frame-rate based resolution control.
- `src/runtime/atmosphere.js` — close-range atmospheric haze and mountain depth.
- `src/runtime/physical-lighting.js` — inverse-square stellar illumination, blackbody light color, and eye-adapted exposure.
- `src/runtime/surface-traces.js` — planet-anchored footprints and landing impressions with bounded lifetime and memory.
- `src/runtime/deep-sky.js` — procedural volumetric nebulae and batched stellar clusters with atmospheric extinction.
- `src/data/nasa-exoplanets.js` — bundled NASA Exoplanet Archive snapshot for additional real planetary systems.
- `assets/earth/` — Earth textures, elevation data, and mountain heightmaps.
- `vendor/` — pinned Three.js r128 runtime and its MIT license.
- `solar-jumper.html` — preserved single-file snapshot from before modularization.

The preserved snapshot is intentionally not used by `index.html`, so future work can change the modular game without altering that copy.

Terrain distance can be changed in Settings. The default 11 × 11 streamed area can be reduced to 7 × 7 or expanded to 15 × 15; outer chunks use progressively lighter geometry while nearby terrain keeps full detail.

Earth terrain rings are committed atomically: the current complete ring stays visible while replacement chunks and LODs stream in, then the renderer swaps only after the replacement is complete. Chunk borders include small geometry skirts, the cutaway follows Earth rotation every frame, and streaming uses the post-physics player position to avoid airborne and landing gaps.

The modular build includes a cinematic adaptive quality tier, animated stellar surfaces, wavelength-inspired atmospheric scattering, eclipse-aware illumination, shoreline-faded reflective water, planet-anchored surface traces, speed-responsive camera optics, and higher-resolution celestial meshes. Its bundled catalogue now contains 23 NASA-derived stellar systems and 104 archived exoplanets, in addition to the hand-built Solar System and nearby destinations. The data snapshot was taken from the [NASA Exoplanet Archive PSCompPars TAP service](https://exoplanetarchive.ipac.caltech.edu/docs/TAP/usingTAP.html) on 2026-08-26 so the game remains fully usable offline.

The deep sky includes ray-marched emission, planetary, and supernova-remnant nebulae plus procedural open and globular star clusters. Gas density, turbulent filaments, ionized emission, dust extinction, and shell structure are evaluated live in shaders; the objects do not use nebula photographs or flat billboards.

Sagittarius A* uses a live Schwarzschild null-geodesic lens. A pre-rendered copy of the real scene is reprojected through the curved ray directions, so the surrounding stars and nebulae are actually lensed instead of replaced with a decorative star texture. Rays below the critical impact parameter are analytically captured into a fully opaque shadow; escaping rays can intersect the relativistic accretion flow multiple times, producing Doppler beaming, gravitational redshift, the photon ring, and fainter higher-order images. The extra scene capture activates only while the lens is large enough to see, scales from 35% to 85% resolution with its apparent size, refreshes between 30 and 60 fps, and is capped at 1600 pixels for predictable GPU cost while the final ray-traced image remains full-resolution.
