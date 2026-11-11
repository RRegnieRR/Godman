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

## Inland water

Earth uses the public-domain [Natural Earth 1:10m physical vectors](https://www.naturalearthdata.com/downloads/10m-physical-vectors/)
for lake outlines and river centerlines. The elevation raster supplies estimated
water levels, and the river widths and beds are modeled. The same Earth-local
samples drive terrain, water rendering, and landing contact in both scales.

Regenerate the bundled asset with the Natural Earth `ne_10m_lakes.zip` and
`ne_10m_rivers_lake_centerlines.zip` downloads and Python with Pillow, NumPy,
and SciPy installed.

```sh
python3 tools/import-earth-hydrography.py ne_10m_lakes.zip \
  ne_10m_rivers_lake_centerlines.zip assets/earth/earth_elevation_nasa_4096.png \
  assets/earth/earth_specular_2048.jpg assets/earth/hydrography.bin
```
