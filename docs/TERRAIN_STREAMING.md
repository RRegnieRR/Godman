# Earth terrain streaming

The orbital Earth mesh is always the fallback. Walking-scale terrain is a
fixed latitude/longitude grid parented to the rotating Earth; it never follows
or teleports with the player.

## Stability rules

1. A visible terrain ring is immutable until a complete replacement ring has
   finished building.
2. Missing replacement tiles remain hidden behind the orbital fallback instead
   of creating holes in the current ring.
3. Walking tiles clip to a fixed Earth-space centre. The regional mesh and
   globe fill pixels left uncovered by finer terrain using the stencil
   buffer. Planet rotation and render-origin shifts leave the centre and
   texture coordinates unchanged.
4. Chunk borders have downward skirts to cover interpolation gaps between
   neighbouring LOD levels.
5. Streaming runs after movement and collision so jumps and landings request
   terrain for the final position of the frame.
6. Cache eviction cannot remove either the committed ring or its pending
   replacement.

This follows the useful invariants of geometry clipmaps—complete active levels,
nested detail, and continuity at resolution transitions—without replacing the
project's existing spherical elevation and collision model.
