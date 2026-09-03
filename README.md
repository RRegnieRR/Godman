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
- `src/runtime/deep-sky.js` — procedural volumetric nebulae, stellar clusters, and navigable 3D galaxies with atmospheric extinction.
- `src/data/nasa-exoplanets.js` — bundled NASA Exoplanet Archive snapshot for additional real planetary systems.
- `assets/earth/` — Earth textures, elevation data, and mountain heightmaps.
- `assets/character/` — the rigged, textured astronaut GLB used by the player plus its attribution notice.
- `vendor/` — pinned Three.js r128 runtime, GLTF loader, and its MIT license.
- `solar-jumper.html` — preserved single-file snapshot from before modularization.

The preserved snapshot is intentionally not used by `index.html`, so future work can change the modular game without altering that copy.

Terrain distance can be changed in Settings. The default 11 × 11 streamed area can be reduced to 7 × 7 or expanded to 15 × 15; outer chunks use progressively lighter geometry while nearby terrain keeps full detail.

Earth terrain rings are committed atomically: the current complete ring stays visible while replacement chunks and LODs stream in, then the renderer swaps only after the replacement is complete. Chunk borders include small geometry skirts, the cutaway follows Earth rotation every frame, and streaming uses the post-physics player position to avoid airborne and landing gaps.

Target locks include predictive arrival assistance. The controller uses closing speed and remaining distance to begin braking before a high-speed intercept, align lateral motion, and settle onto planets at walking-speed touchdown. Locked stars use the same guidance but stop at a safe observation radius instead of treating the photosphere as land.

The orbital laser uses a terrain-independent thermal damage path. Its beam and rotating impact plasma respond immediately, heat decays after releasing the trigger, and sustained contact vaporizes the planet without rebuilding Earth mountains or producing fallback-blue landing chunks.

The modular build includes a cinematic adaptive quality tier, animated stellar surfaces, wavelength-inspired atmospheric scattering, eclipse-aware illumination, shoreline-faded reflective water, speed-responsive camera optics, and higher-resolution celestial meshes. Intergalactic travel uses capped, distance-aware galaxy populations plus a single-batch, camera-centred cosmic backdrop, keeping the universe visually continuous without a reachable boundary or multi-million-point frame spike. The playable character now uses a genuinely rigged and textured humanoid spacesuit with a 94-bone skeleton, anatomically separate five-finger hands, and embedded `idle`, `moon_walk`, `floating`, and `wave` animation clips. Three.js AnimationMixer crossfades those authored motions according to walking, running, landing, swimming, and flight state; motion hysteresis prevents stop/start animation chatter, walking and running use independent cadence-controlled actions, and additive flight posing gives the astronaut stable shoulders, wrists, knees, and boots without replacing the authored motion. Ground movement is capped at human-scale speeds: a purposeful 1.8 m/s walk and a 6.2 m/s athletic run. Charged jumps retain the original camera-directed planetary launch range so a full jump can leave Earth. Touchdown separates normal and tangential velocity, bends the rig through a timed compression, and dissipates excess slide with gravity-scaled surface friction. Propulsion comes from four articulated repulsors attached to the real wrist and ankle bones, with compact layered exhaust, smooth throttle response, directional steering, and local blue illumination; the old backpack nozzle is disabled. A two-stage directional IK pass repositions the upper and lower limbs every frame and aligns the palm and boot-sole normals opposite the applied force after final body orientation, including during rapid direction changes. The material is rendered locally with the orange pressure-suit palette and dark visor from the project's visual direction, while the lightweight procedural astronaut remains only as an offline fallback. Its bundled catalogue now contains 26 NASA-derived stellar systems and 115 archived exoplanets, in addition to the hand-built Solar System and nearby destinations. The newest system parameters were refreshed from the [NASA Exoplanet Archive PSCompPars TAP service](https://exoplanetarchive.ipac.caltech.edu/docs/TAP/usingTAP.html) on 2026-09-01 so the game remains fully usable offline.

The deep sky includes ray-marched emission, planetary, and supernova-remnant nebulae plus procedural open and globular star clusters. The Solar System now begins 26,670 light-years from Sagittarius A* inside a 104,000-light-year Milky Way. Its 12-million-sample deterministic catalogue uses a rotated five-kiloparsec box/peanut bar, unequal logarithmic Scutum–Centaurus, Perseus, Sagittarius–Carina, and Norma–Outer arms, a finite Local Arm spur, exponential thin and thick disks, an oblate stellar halo, and flared and warped outskirts. Rendering uses 1.35 million resident galactic samples inside the disk and up to 2.6 million for the exterior silhouette. The former observer-wrapped Milky Way sky overlay has been removed completely; the physical galaxy and a camera-centred 900,000-star field now supply the entire sky without a reachable wall, lattice, band, seam, fade transition, or empty rectangular sectors.

Deep-sky colour follows approximate visible black-body stellar classes: numerous but faint red/orange M and K stars, warm G stars, blue-white F/A stars, and rare luminous blue stars. The Galactic bulge is warmer and older, spiral arms retain younger blue populations, and dust reddening plus H-alpha-like star-forming regions add localized red structure. Galaxy brightness is compensated across streamed detail levels and alpha-composited so loading more stellar samples adds detail without washing every dense region to white.

There are 100 navigable 3D galaxies in total: the Milky Way, six named nearby galaxies, and 93 deterministic deep-field systems arranged in filament-like distance groups rather than on a boundary sphere. Their combined visual catalogues contain tens of millions of stellar samples and metadata estimates for the much larger physical populations. Real catalog stars retain their known names; each Milky Way GPU sample also has a stable `MW-########` designation that can be entered in the destination finder. Reaching 10 AU from a numbered star deterministically creates 3–8 varied planets and their orbit guides; passing 20 AU removes their meshes, labels, orbits, and physics bodies. Beyond the catalogue lies progressively emptier space rather than a physical universe edge. These objects do not use photographs, canvas images, or flat billboards.

Sagittarius A* uses a live Kerr-aware null-geodesic lens tuned to the `a/M = 0.6` presentation used for Gargantua in *Interstellar*. A rendered copy of the real scene is reprojected through observer-distance-aware curved ray paths, so stars, nebulae, galaxies, and nearby objects are genuinely lensed instead of replaced with a decorative texture. The projected spin shifts and compresses the capture shadow while a bounded gravitomagnetic term drags near-hole rays in the prograde direction. Escaping rays integrate through a geometrically thin disk beginning near the prograde ISCO; Doppler beaming, gravitational frequency shift, multiple disk crossings, and near-critical paths produce the asymmetric direct and secondary images. The integrator uses adaptive midpoint steps, a 1280-pixel capture ceiling, and adaptive trace counts to contain the GPU cost. Horizon crossing is one-way and no longer teleports the player into a fictional mirrored universe.
