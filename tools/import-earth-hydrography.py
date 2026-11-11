"""Build the game asset from the Natural Earth 1:10m lakes and rivers ZIPs."""
import argparse
import math
import statistics
import struct
import zipfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy.ndimage import label


def records(path):
    with zipfile.ZipFile(path) as archive:
        shapes = archive.read(next(n for n in archive.namelist() if n.endswith(".shp")))
        table = archive.read(next(n for n in archive.namelist() if n.endswith(".dbf")))
    header, row_size = struct.unpack_from("<HH", table, 8)
    fields = [(table[i:i+11].split(b"\0")[0].decode(), table[i+16])
              for i in range(32, header-1, 32)]
    offset, row = 100, header
    while offset < len(shapes):
        size = struct.unpack_from(">i", shapes, offset+4)[0]*2
        start = offset+8
        props = {}
        cursor = row+1
        for name, width in fields:
            props[name] = table[cursor:cursor+width].decode("utf-8", "replace").strip(" \x00")
            cursor += width
        if struct.unpack_from("<i", shapes, start)[0] in (3, 5):
            count, points = struct.unpack_from("<ii", shapes, start+36)
            parts = [*struct.unpack_from(f"<{count}i", shapes, start+44), points]
            coordinates = list(struct.iter_unpack("<dd", shapes[start+44+count*4:offset+8+size]))
            yield props, [coordinates[a:b] for a, b in zip(parts, parts[1:])]
        offset += 8+size
        row += row_size


def thin(points, minimum):
    result = [points[0]]
    for point in points[1:-1]:
        if math.dist(point, result[-1]) >= minimum:
            result.append(point)
    return result + [points[-1]]


def pack(points, height=None):
    packed = []
    for lon, lat in points:
        packed.extend((round(lon*100000), round(lat*100000)))
        if height:
            packed.append(round(height(lon, lat)*10))
    return packed


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("lakes")
    parser.add_argument("rivers")
    parser.add_argument("elevation")
    parser.add_argument("specular_mask")
    parser.add_argument("output")
    args = parser.parse_args()
    raster = Image.open(args.elevation).convert("L")
    w, h = raster.size
    pixels = raster.load()

    def height(lon, lat):
        x, y = ((lon+180)/360*w) % w, min(h-1, max(0, (90-lat)/180*(h-1)))
        i, j = int(x), int(y)
        u, v = x-i, y-j
        a, b = pixels[i, j], pixels[(i+1) % w, j]
        c, d = pixels[i, min(h-1, j+1)], pixels[(i+1) % w, min(h-1, j+1)]
        return ((a*(1-u)+b*u)*(1-v)+(c*(1-u)+d*u)*v)*6400/255

    specular = Image.open(args.specular_mask).convert("RGB")
    coast_width, coast_height = specular.size
    lake_mask = Image.new("L", specular.size)
    draw_lakes = ImageDraw.Draw(lake_mask)
    lakes = []
    for _, parts in records(args.lakes):
        rings = [part for part in parts if len(part) >= 4]
        if not rings:
            continue
        # The source describes the outline. Infer a single water level from
        # the existing elevation map around it.
        shore_heights = [height(*p) for ring in rings for p in ring[::max(1,len(ring)//180)]]
        # Favor low shore samples so steep surrounding slopes don't set the lake level.
        level = statistics.quantiles(shore_heights, n=10, method="inclusive")[2]
        lakes.append((round(level*10), [pack(r) for r in rings]))
        for ring in rings:
            area = sum(x0*y1-x1*y0 for (x0,y0), (x1,y1) in zip(ring, ring[1:]))
            outline = [((x+180)*coast_width/360-.5, (90-y)*coast_height/180-.5) for x,y in ring]
            draw_lakes.polygon(outline, fill=255 if area<0 else 0)
    rivers = []
    for props, parts in records(args.rivers):
        if props["featurecla"] != "River":
            continue
        rank = int(props["scalerank"] or 9)
        # Map rank is a visual size proxy, not a surveyed channel width.
        half_width = {1:310, 2:240, 3:180, 4:140, 5:105, 6:76, 7:54, 8:37}.get(rank, 25)
        rivers.extend([half_width, pack(thin(part, .00045), height)] for part in parts if len(part) > 1)
    data = bytearray(b"HYD2")

    def integer(value):
        value = value*2 if value >= 0 else -value*2-1
        while value >= 128:
            data.append((value & 127) | 128)
            value >>= 7
        data.append(value)

    def path(values, stride):
        integer(len(values)//stride)
        previous = [0]*stride
        for index, value in enumerate(values):
            axis = index % stride
            integer(value-previous[axis])
            previous[axis] = value

    integer(len(lakes))
    integer(len(rivers))
    for level, rings in lakes:
        integer(level)
        integer(len(rings))
        for ring in rings:
            path(ring, 2)
    for width, points in rivers:
        integer(width)
        path(points, 3)
    # The old ocean mask includes coarse lake silhouettes. Remove only
    # isolated components substantially covered by mapped lakes, preserving
    # the connected ocean and its existing shoreline treatment.
    wet = np.asarray(specular).sum(axis=2) > 258
    components, _ = label(wet)
    sizes = np.bincount(components.ravel())
    overlap = np.bincount(components[np.asarray(lake_mask) > 0], minlength=len(sizes))
    mapped = (sizes <= 18000) & (overlap >= sizes*.25)
    mapped[0] = False
    old_lake_pixels = np.flatnonzero(mapped[components])
    integer(coast_width)
    integer(coast_height)
    integer(len(old_lake_pixels))
    previous = 0
    for index in old_lake_pixels:
        integer(int(index)-previous)
        previous = int(index)
    Path(args.output).write_bytes(data)
    print(f"{len(lakes)} lakes and {len(rivers)} river paths")


if __name__ == "__main__":
    main()
