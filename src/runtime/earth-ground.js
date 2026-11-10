/* Shared, planet-anchored material detail for Earth's streamed terrain. */
(function (g) {
  'use strict';

  // An integer number of detail repeats per patch period makes neighbouring
  // tiles identical even when they wrap from different origins.
  const patchPeriod = 540;
  const detailRepeats = 87;

  function groundOrigin(anchor, out) {
    return out.set(
      Math.floor(anchor.x / patchPeriod) * patchPeriod,
      Math.floor(anchor.y / patchPeriod) * patchPeriod,
      Math.floor(anchor.z / patchPeriod) * patchPeriod
    );
  }

  function writeGroundVertex(array, index, direction, radius, planetRadius, origin) {
    const i = index * 4;
    array[i] = direction.x * radius - origin.x;
    array[i + 1] = direction.y * radius - origin.y;
    array[i + 2] = direction.z * radius - origin.z;
    array[i + 3] = radius - planetRadius;
  }

  function lattice(x, y, width, height, seed) {
    x = (x % width + width) % width;
    y = (y % height + height) % height;
    let h = Math.imul(x + seed, 374761393) ^ Math.imul(y + seed, 668265263);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  }

  function noise(u, v, width, height, seed) {
    const x = u * width, y = v * height;
    const i = Math.floor(x), j = Math.floor(y);
    const a = x - i, b = y - j;
    const s = a * a * (3 - 2 * a), t = b * b * (3 - 2 * b);
    const lo = lattice(i, j, width, height, seed) * (1 - s) + lattice(i + 1, j, width, height, seed) * s;
    const hi = lattice(i, j + 1, width, height, seed) * (1 - s) + lattice(i + 1, j + 1, width, height, seed) * s;
    return lo * (1 - t) + hi * t;
  }

  function stoneChips(u, v) {
    const cells = 21;
    const x = u * cells, y = v * cells;
    const i = Math.floor(x), j = Math.floor(y);
    let chip = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const col = i + dx, row = j + dy;
      const size = lattice(col, row, cells, cells, 139);
      if (size < .53) continue;
      const px = x - col - lattice(col, row, cells, cells, 107);
      const py = y - row - lattice(col, row, cells, cells, 119);
      // An irregular edge and broad face read as small stone fragments.
      const radius = Math.max(Math.abs(px + py * .36), Math.abs(py - px * .24) * 1.4);
      chip = Math.max(chip, Math.min(1, Math.max(0, (.08 + .26 * size - radius) * 7)));
    }
    return chip;
  }

  function makeDetailTexture(T) {
    const size = 256;
    const pixels = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const warp = (noise(u, v, 5, 5, 11) - .5) * .13;
      const coarse = noise(u + warp, v - warp, 7, 7, 21);
      const grain = noise(u, v, 48, 48, 37);
      const clumps = noise(u + warp, v, 18, 22, 53);
      const blades = noise(u, v, 72, 35, 67);
      const veins = noise(u + warp, v + warp, 5, 23, 83);
      const index = (y * size + x) * 4;
      pixels[index] = Math.round(255 * (.68 * coarse + .32 * clumps));
      pixels[index + 1] = Math.round(255 * (.52 * clumps + .28 * grain + .20 * blades));
      pixels[index + 2] = Math.round(255 * (.46 * veins + .34 * clumps + .20 * grain));
      pixels[index + 3] = Math.round(255 * stoneChips(u, v));
    }
    const texture = new T.DataTexture(pixels, size, size);
    texture.wrapS = texture.wrapT = T.RepeatWrapping;
    texture.minFilter = T.LinearMipmapLinearFilter;
    texture.magFilter = T.LinearFilter;
    texture.generateMipmaps = true;
    texture.needsUpdate = true;
    return texture;
  }

  const landscapeGLSL = `
    vec4 earthTriplanar(vec3 p, vec3 weights) {
      return texture2D(earthGroundDetail, p.yz + vec2(.31, .73)) * weights.x
           + texture2D(earthGroundDetail, p.zx + vec2(.53, .11)) * weights.y
           + texture2D(earthGroundDetail, p.xy + vec2(.91, .39)) * weights.z;
    }

    vec3 earthTerrainRegion(vec3 planetPoint, vec3 radial) {
      // Skew the broad field so its repeat never lines up with the ground
      // texture or tile grid. Sample in continuous, planet-fixed space.
      vec3 p = planetPoint / 32800.;
      vec3 weights = radial * radial;
      return earthTriplanar(p + p.yzx * .317 - p.zxy * .213, weights).rgb;
    }

    float earthTerrainDryness(vec3 satellite, vec3 region) {
      float climate = (satellite.r - satellite.g) * 3.1;
      return smoothstep(.26, .72, region.r + climate);
    }

    vec3 earthPlants(vec3 satellite, vec3 region, float latitude, float height, float cover) {
      float warm=1.-smoothstep(.33,.71,latitude);
      float cold=smoothstep(.69,.95,latitude+.29*smoothstep(1250.,5200.,height));
      float trees=smoothstep(.43,.77,region.g+clamp((satellite.g-satellite.r)*1.25,-.13,.24));
      vec3 meadow=mix(vec3(.055,.105,.030),vec3(.18,.215,.074),cover);
      vec3 woodland=mix(vec3(.038,.081,.035),vec3(.026,.105,.052),warm)*mix(.76,1.36,cover);
      vec3 tundra=mix(vec3(.14,.143,.101),vec3(.21,.201,.119),cover);
      return mix(mix(meadow,woodland,trees),tundra,cold);
    }
  `;

  const detailGLSL = `
    uniform sampler2D earthGroundDetail;
    uniform mat3 earthTilePlanetInverse;
    uniform float earthHeightScale;
    ${landscapeGLSL}

    vec3 earthSurfaceAlbedo(vec3 satellite, vec4 ground, vec3 radial, vec3 terrainNormal,
                           vec3 region, out float snow, out float ice, out float bump) {
      float altitude = ground.w / earthHeightScale;
      float slope = 1. - clamp(dot(terrainNormal, radial), 0., 1.);
      vec3 weights = pow(abs(terrainNormal), vec3(4.));
      weights /= max(dot(weights, vec3(1.)), .0001);
      // Distinct sizes separate valleys and outcrops from walking-scale grain.
      vec3 patchCoord = ground.xyz / ${patchPeriod}.;
      vec3 patches = earthTriplanar(patchCoord + (region - .5) * 2.1, weights).rgb;
      vec4 detail = earthTriplanar(patchCoord * ${detailRepeats}. + (patches - .5) * 2.3 + region, weights);
      float footprint = max(length(dFdx(ground.xyz)), length(dFdy(ground.xyz)));
      // Fine contrast and bump both ease away before the smallest marks
      // shrink below a pixel at a grazing camera angle.
      detail = mix(detail, vec4(.5, .5, .5, .05), smoothstep(.065, .32, footprint));
      float bare = smoothstep(.07, .34, slope + (patches.r - .5) * .16 + (region.b - .5) * .20);
      float latitude = abs(radial.y);
      float snowline = mix(520., 92., smoothstep(.47, .96, latitude));
      snowline = mix(snowline, -16., smoothstep(.94, .998, latitude));
      snowline += (patches.r - .5) * 108. + bare * 62.;
      float exposedSnow = smoothstep(.10, .38, slope + (patches.b - .5) * .21);
      snow = smoothstep(-20., 27., altitude - snowline) * (1. - .88 * exposedSnow);
      snow *= smoothstep(-1.1, .3, altitude);

      float landLight = dot(satellite, vec3(.2126, .7152, .0722));
      float arid = earthTerrainDryness(satellite, region);
      float grass = smoothstep(.26, .68, patches.r + (detail.r - .5) * .48);
      float tufts = smoothstep(.32, .64, detail.g);
      vec3 soil = mix(vec3(.151, .105, .057), vec3(.314, .215, .114), arid);
      vec3 plants = earthPlants(satellite,region,latitude,altitude*10.,.43*grass+.27*tufts+.30*region.g);
      float vegetation = (1. - arid * .86) * (1. - .68 * smoothstep(snowline - 160., snowline - 18., altitude));
      vec3 lowland = mix(soil, plants, vegetation * (.41 + .38 * grass + .21 * tufts));
      vec3 stone = mix(vec3(.131, .108, .089), vec3(.275, .231, .181), patches.b);
      stone *= .58 + .85 * detail.b;
      vec3 land = mix(lowland, stone, bare);
      land *= .70 + .60 * detail.g;
      float scree = detail.a * (.24 + .50 * bare) * (1. - .58 * grass);
      land = mix(land, stone * (1.17 + detail.b * .29), scree);
      // Keep regional color from the satellite map. Bright white areas in
      // that map use the snow mask for their local coverage and material.
      land *= mix(vec3(1.), clamp(satellite / max(landLight, .05), .62, 1.45), .27);
      land *= mix(.86, 1.23, smoothstep(.045, .36, landLight));

      float windPack = smoothstep(.46, .73, patches.b + (.5 - patches.r) * .28);
      ice = clamp(.56 * windPack + .38 * bare, 0., 1.);
      vec3 frozen = mix(vec3(.84, .91, .97), vec3(.47, .66, .79), ice);
      frozen *= .85 + .25 * detail.g;
      float seabed = 1. - smoothstep(-2.4, -.35, ground.w);
      vec3 albedo = mix(mix(land, frozen, snow), satellite, seabed);
      bump = mix(mix(detail.g, detail.b, bare) + scree * .62, detail.g * .31, snow) * (1. - seabed);
      return albedo;
    }

    vec3 earthGroundNormal(vec3 normal, vec3 point, float height) {
      vec3 dx = dFdx(point), dy = dFdy(point);
      vec3 rx = cross(dy, normal), ry = cross(normal, dx);
      float area = dot(dx, rx);
      float footprint = max(length(dx), length(dy));
      float bumpScale = .028 * (1. - smoothstep(.075, .27, footprint));
      vec3 gradient = dFdx(height) * rx + dFdy(height) * ry;
      return normalize(max(abs(area), 1e-8) * normal - sign(area) * gradient * bumpScale);
    }
  `;

  const flightDetailGLSL = `
    vec3 earthFlightAlbedo(vec3 satellite, vec4 ground, float land, vec3 terrainNormal, vec3 region){
      vec3 radial=normalize(ground.xyz);
      vec3 p=ground.xyz/2070.;
      vec3 pattern=earthTriplanar(p-p.zxy*.137+(region-.5)*2.7,radial*radial).rgb;
      float arid=earthTerrainDryness(satellite,region);
      float slope=1.-clamp(dot(terrainNormal,radial),0.,1.);
      float exposed=smoothstep(.04,.24,slope+(region.b-.5)*.18+(pattern.b-.5)*.17);
      float cover=smoothstep(.24,.74,pattern.r*.65+region.g*.35);
      vec3 meadow=earthPlants(satellite,region,abs(radial.y),ground.w,cover);
      vec3 soil=mix(vec3(.104,.078,.052),vec3(.29,.195,.105),pattern.g*.6+region.g*.4);
      vec3 rock=mix(vec3(.11,.104,.092),vec3(.25,.224,.186),pattern.b);
      vec3 surface=mix(mix(meadow,soil,mix(.13,.94,arid)),rock,exposed*.92);
      float snowline=mix(5200.,920.,smoothstep(.47,.96,abs(radial.y)));
      snowline=mix(snowline,-160.,smoothstep(.94,.998,abs(radial.y)));
      float snow=smoothstep(-250.,310.,ground.w-snowline+(pattern.b-.5)*790.+(region.g-.5)*720.);
      surface=mix(surface,mix(vec3(.45,.48,.48),vec3(.83,.85,.83),pattern.g),snow);
      return mix(satellite,mix(surface,satellite,.32),land);
    }
  `;

  g.GodmanEarthGround = { makeDetailTexture, detailGLSL, landscapeGLSL, flightDetailGLSL, groundOrigin, writeGroundVertex, patchPeriod };
})(typeof window === 'undefined' ? globalThis : window);
