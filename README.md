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
- `src/runtime/deep-sky.js` — procedural volumetric nebulae, stellar clusters, and navigable 3D galaxies with atmospheric extinction.
- `src/data/nasa-exoplanets.js` — bundled NASA Exoplanet Archive snapshot for additional real planetary systems.
- `assets/earth/` — Earth textures, elevation data, and mountain heightmaps.
- `vendor/` — pinned Three.js r128 runtime and its MIT license.
- `solar-jumper.html` — preserved single-file snapshot from before modularization.

The preserved snapshot is intentionally not used by `index.html`, so future work can change the modular game without altering that copy.

Terrain distance can be changed in Settings. The default 11 × 11 streamed area can be reduced to 7 × 7 or expanded to 15 × 15; outer chunks use progressively lighter geometry while nearby terrain keeps full detail.

Earth terrain rings are committed atomically: the current complete ring stays visible while replacement chunks and LODs stream in, then the renderer swaps only after the replacement is complete. Chunk borders include small geometry skirts, the cutaway follows Earth rotation every frame, and streaming uses the post-physics player position to avoid airborne and landing gaps.

Target locks include predictive arrival assistance. The controller uses closing speed and remaining distance to begin braking before a high-speed intercept, align lateral motion, and settle onto planets at walking-speed touchdown. Locked stars use the same guidance but stop at a safe observation radius instead of treating the photosphere as land.

The orbital laser uses a terrain-independent thermal damage path. Its beam and rotating impact plasma respond immediately, heat decays after releasing the trigger, and sustained contact vaporizes the planet without rebuilding Earth mountains or producing fallback-blue landing chunks.

The modular build includes a cinematic adaptive quality tier, animated stellar surfaces, wavelength-inspired atmospheric scattering, eclipse-aware illumination, shoreline-faded reflective water, planet-anchored surface traces, speed-responsive camera optics, and higher-resolution celestial meshes. Intergalactic travel uses capped, distance-aware galaxy populations plus a single-batch, camera-centred cosmic backdrop, keeping the universe visually continuous without a reachable boundary or multi-million-point frame spike. The playable character is a scratch-built articulated Ember expedition suit with a woven burnt-orange pressure layer, fitted copper-orange armor, mirrored visor, black utility harness, compact life-support spine, equipment belt, hoses, gloves, and layered boots. Its bundled catalogue now contains 26 NASA-derived stellar systems and 115 archived exoplanets, in addition to the hand-built Solar System and nearby destinations. The newest system parameters were refreshed from the [NASA Exoplanet Archive PSCompPars TAP service](https://exoplanetarchive.ipac.caltech.edu/docs/TAP/usingTAP.html) on 2026-09-01 so the game remains fully usable offline.

The deep sky includes ray-marched emission, planetary, and supernova-remnant nebulae plus procedural open and globular star clusters. The Solar System now begins inside a 104,000-light-year Milky Way centered on Sagittarius A*: a barred bulge, four spiral arms, dust lanes and physical disk thickness are selected from a 2.4-million-sample deterministic catalogue. Rendering uses a 150,000-star resident set inside the disk and a capped 260,000-star exterior silhouette, preventing the former multi-million-point frame spike. A lightweight distant field keeps intergalactic space continuous without a reachable dotted wall.

There are 100 navigable 3D galaxies in total: the Milky Way, six named nearby galaxies, and 93 deterministic deep-field systems arranged in filament-like distance groups rather than on a boundary sphere. Their combined visual catalogues contain tens of millions of addressable stellar samples and metadata estimates for the much larger physical populations. Every procedural star deterministically owns three planets; only the nearest system is expanded into full planet meshes, orbital motion, labels and gravity bodies, keeping the simulation bounded. Beyond the catalogue lies progressively emptier space rather than a physical universe edge. These objects do not use photographs, canvas images, or flat billboards.

Sagittarius A* uses a live Schwarzschild null-geodesic lens. A pre-rendered copy of the real scene is reprojected through the curved ray directions, so the surrounding stars, nebulae, and galaxies are actually lensed instead of replaced with a decorative texture. Rays below the critical impact parameter are analytically captured into a fully opaque shadow; escaping rays can intersect the relativistic accretion flow multiple times, producing Doppler beaming, gravitational redshift, the photon ring, and fainter higher-order images. Close-range tracing now uses adaptive geodesic steps, a 1280-pixel capture ceiling, and 24–30 Hz background refresh while the final lens remains full-resolution. Flight also enters a relativistic safety regime near the horizon to prevent numerical velocity spikes.
