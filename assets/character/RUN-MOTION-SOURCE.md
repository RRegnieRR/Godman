# Locomotion motion source

The direction-only motion data in `src/data/run-motion.js` and
`src/data/walk-motion.js` is extracted from the `Run` and `Walk` clips of the
Soldier sample distributed in Three.js examples:
https://github.com/mrdoob/three.js/tree/dev/examples/models/gltf/Soldier.glb

The sample character/motion originated from Mixamo. The Soldier model, textures,
and source GLB are not bundled here. Only sampled limb directions used by the
astronaut retargeting controller are included. The astronaut's original model
and attribution remain unchanged.

To regenerate the directions from a local source GLB, run
`node tools/extract-run-motion.cjs /path/to/Soldier.glb`.

For walking, pass `Walk` as the final argument. The default is `Run`. The
generator writes JavaScript to stdout and does not modify source files.

Both regenerated clips additionally contain foot forward/up vectors, torso world
rotation deltas from bind pose, and pelvis translation relative to bind pose.
All vectors use the source hips' bind frame (+Y up, +Z forward); translations
are normalized by source leg length. Torso entries are world-space deltas in
that frame, not local joint rotations: do not apply each entry directly as an
additive local rotation down the spine chain. Foot up is calibrated from the
bind sole direction rather than assuming a particular imported bone axis.
Sole forward is calibrated from the toe segment, not the sloped ankle-to-toe
offset. Each frame's `pelvisHeight` and `footClearance.L` / `.R` use one minimum
ankle height over the entire clip as their reference floor, in source leg-length
units. This preserves the run's aerial phase; recomputing a floor per frame
would incorrectly keep one foot on the ground. Foot clearance measures the
ankle joint, so it is not by itself an exact mesh-sole collision/contact flag.
