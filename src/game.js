(function () {
  'use strict';
  addEventListener('error', function (ev) {
    const el = document.getElementById('toast');
    if (el) { el.textContent = 'Error: ' + ev.message; el.style.opacity = 1; }
  });

  // ---------- Loading screen ----------
  const loaderEl = document.getElementById('loader');
  const loadBar = document.getElementById('loadBar');
  const loadText = document.getElementById('loadText');
  const loadStart = Date.now();
  let loadTotal = 999, loadDone = 0, loaderHidden = false;
  function loadTick(label) {
    loadDone++;
    if (label) loadText.textContent = label;
    loadBar.style.width = Math.min(100, loadDone / loadTotal * 100) + '%';
    if (loadDone >= loadTotal) hideLoader();
  }
  function hideLoader() {
    if (loaderHidden) return;
    loaderHidden = true;
    const wait = Math.max(0, 1000 - (Date.now() - loadStart));
    setTimeout(() => {
      loaderEl.style.opacity = 0;
      setTimeout(() => { loaderEl.style.display = 'none'; }, 800);
    }, wait);
  }
  setTimeout(hideLoader, 15000); // failsafe: never trap the player on the loader

  // 1 unit = 1 m at 1:10 real scale. Floating origin rendering.

  const CONFIG=window.GODMAN_CONFIG;
  const terrainRangeControl=document.getElementById('setTerrainRange');
  let terrainRadiusPreference=CONFIG.terrain.defaultRadius;
  try{
    const savedTerrainRadius=parseInt(localStorage.getItem('godman_terrain_radius'),10);
    if(Number.isFinite(savedTerrainRadius))terrainRadiusPreference=Math.max(CONFIG.terrain.minRadius,Math.min(CONFIG.terrain.maxRadius,savedTerrainRadius));
  }catch(e){}
  terrainRangeControl.value=String(terrainRadiusPreference);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x01040b);
  const surfaceAtmosphere=new window.GodmanSurfaceAtmosphere(THREE,scene,CONFIG.atmosphere);
  const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.5, 1e23);
  const renderer = new THREE.WebGLRenderer({
    antialias:true,logarithmicDepthBuffer:true,powerPreference:'high-performance',stencil:false
  });
  renderer.setSize(innerWidth, innerHeight);
  renderer.setPixelRatio(Math.min(devicePixelRatio,CONFIG.renderer.maxPixelRatio));
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.dithering = true;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  document.body.appendChild(renderer.domElement);

  // cinematic bloom + style — loaded in the background, game starts immediately
  let composer = null, useBloom = false, bloomPass = null, stylePass = null;
  // The old off-screen composer caused terrain shimmer and downloaded six
  // scripts that the final renderer never used. Direct rendering is cleaner
  // and leaves substantially more GPU time for terrain and water detail.

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
    if (composer) composer.setSize(innerWidth, innerHeight);
    if (stylePass) stylePass.uniforms.resolution.value.set(innerWidth, innerHeight);
  });

  const renderObjs = [];
  const reliefQueue = [];
  const reliefNormalCache = new WeakMap();
  const labels = [];
  const glows = [];
  const orbitGuides = [];
  let universeAnnotationsHidden = false;
  function track(o, w) { renderObjs.push({ o: o, w: w }); scene.add(o); }

  const ambient = new THREE.AmbientLight(0x202735, 0.12);
  scene.add(ambient);
  const skyLight = new THREE.HemisphereLight(0xa9d2ff,0x40352c,0.08);
  scene.add(skyLight);
  const headlamp = new THREE.PointLight(0xd7e7ff, 0.35, 40, 2);
  scene.add(headlamp);
  const boomLight = new THREE.PointLight(0xffaa55, 0, 0, 2);
  scene.add(boomLight);
  let boomAge = 99, boomDur = 1, boomW = new THREE.Vector3();

  // ---------- Starfield ----------
  const starMats = [];
  const starLayers = [];
  // The old implementation placed stars on several spherical shells hundreds
  // of thousands of light-years away. From inside, those shells looked like a
  // dotted end wall. The navigable Milky Way below now supplies the sky instead;
  // beyond its disk there is simply progressively emptier intergalactic space.

  function V3n(x, y, z) { return new THREE.Vector3(x, y, z); }
  function softSprite(color1, color2) {
    const c = document.createElement('canvas'); c.width = 256; c.height = 256;
    const x = c.getContext('2d');
    const g = x.createRadialGradient(128, 128, 8, 128, 128, 128);
    g.addColorStop(0, color1); g.addColorStop(0.5, color2); g.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = g; x.fillRect(0, 0, 256, 256);
    return new THREE.CanvasTexture(c);
  }

  // ---------- Procedural textures ----------
  function canvasTex(draw, w, h) {
    const c = document.createElement('canvas');
    c.width = w || 1024; c.height = h || 512;
    draw(c.getContext('2d'), c.width, c.height);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = THREE.RepeatWrapping;
    t.encoding = THREE.sRGBEncoding;
    t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    return t;
  }
  // procedural normal map from a texture's luminance (real surface relief)
  function normalFromCanvas(srcCanvas, strength) {
    const w = srcCanvas.width, h = srcCanvas.height;
    const sd = srcCanvas.getContext('2d').getImageData(0, 0, w, h).data;
    const out = document.createElement('canvas'); out.width = w; out.height = h;
    const ox = out.getContext('2d');
    const od = ox.createImageData(w, h);
    function lum(px, py) {
      const i = (((py + h) % h) * w + ((px + w) % w)) * 4;
      return sd[i] * 0.3 + sd[i + 1] * 0.59 + sd[i + 2] * 0.11;
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const dx = (lum(x - 1, y) - lum(x + 1, y)) * strength * 0.01;
        const dy = (lum(x, y - 1) - lum(x, y + 1)) * strength * 0.01;
        const il = 1 / Math.sqrt(dx * dx + dy * dy + 1);
        const i = (y * w + x) * 4;
        od.data[i] = (dx * il * 0.5 + 0.5) * 255;
        od.data[i + 1] = (dy * il * 0.5 + 0.5) * 255;
        od.data[i + 2] = il * 255;
        od.data[i + 3] = 255;
      }
    }
    ox.putImageData(od, 0, 0);
    const t = new THREE.CanvasTexture(out);
    t.wrapS = THREE.RepeatWrapping;
    return t;
  }
  // procedural night-side city lights, clustered on land
  function nightLights(srcCanvas) {
    const w = srcCanvas.width, h = srcCanvas.height;
    const sd = srcCanvas.getContext('2d').getImageData(0, 0, w, h).data;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const x = c.getContext('2d');
    x.fillStyle = '#000'; x.fillRect(0, 0, w, h);
    function isLand(px, py) {
      if (px < 0 || px >= w || py < 0 || py >= h) return false;
      const i = ((py | 0) * w + (px | 0)) * 4;
      return sd[i + 1] > sd[i + 2] + 8 || (sd[i] > 120 && sd[i] > sd[i + 2] + 25);
    }
    let placed = 0, guard = 0;
    while (placed < 90 && guard++ < 5000) {
      const cx = Math.random() * w, cy = h * 0.18 + Math.random() * h * 0.64;
      if (!isLand(cx, cy)) continue;
      placed++;
      const n = 30 + Math.random() * 90;
      for (let i = 0; i < n; i++) {
        const px = cx + (Math.random() - 0.5) * w * 0.045;
        const py = cy + (Math.random() - 0.5) * h * 0.04;
        if (!isLand(px, py)) continue;
        x.fillStyle = Math.random() > 0.3 ? '#ffd9a0' : '#ffeecc';
        x.globalAlpha = 0.35 + Math.random() * 0.6;
        const s = Math.random() * 1.8 + 0.6;
        x.fillRect(px, py, s, s);
      }
    }
    x.globalAlpha = 1;
    const t = new THREE.CanvasTexture(c);
    t.wrapS = THREE.RepeatWrapping;
    return t;
  }
  function blob(x, cx, cy, size, color, alpha) {
    x.fillStyle = color;
    let px = cx, py = cy;
    for (let i = 0; i < 22; i++) {
      x.globalAlpha = alpha * (0.5 + Math.random() * 0.5);
      const r = size * (0.25 + Math.random() * 0.75);
      x.beginPath(); x.arc(px, py, r, 0, Math.PI * 2); x.fill();
      px += (Math.random() - 0.5) * size * 1.6;
      py += (Math.random() - 0.5) * size * 0.9;
    }
    x.globalAlpha = 1;
  }
  function detailPass(x, w, h, strength) {
    const s0 = strength || 1;
    for (let i = 0; i < 2400 * s0; i++) {
      x.globalAlpha = 0.04;
      x.fillStyle = Math.random() > 0.5 ? '#000' : '#fff';
      const s = 1 + Math.random() * 3;
      x.fillRect(Math.random() * w, Math.random() * h, s, s);
    }
    for (let i = 0; i < 9; i++) {
      x.globalAlpha = 0.055;
      x.fillStyle = Math.random() > 0.5 ? '#000' : '#fff';
      x.beginPath();
      x.ellipse(Math.random() * w, Math.random() * h, w * (0.06 + Math.random() * 0.18), h * (0.08 + Math.random() * 0.2), Math.random() * 3, 0, Math.PI * 2);
      x.fill();
    }
    const gT = x.createLinearGradient(0, 0, 0, h * 0.1);
    gT.addColorStop(0, 'rgba(0,0,0,0.22)'); gT.addColorStop(1, 'rgba(0,0,0,0)');
    x.globalAlpha = 1; x.fillStyle = gT; x.fillRect(0, 0, w, h * 0.1);
    const gB = x.createLinearGradient(0, h * 0.9, 0, h);
    gB.addColorStop(0, 'rgba(0,0,0,0)'); gB.addColorStop(1, 'rgba(0,0,0,0.22)');
    x.fillStyle = gB; x.fillRect(0, h * 0.9, w, h * 0.1);
    x.globalAlpha = 1;
  }
  function craterAt(x, cx, cy, r, dark, light, rays) {
    x.globalAlpha = 0.5; x.fillStyle = dark;
    x.beginPath(); x.arc(cx, cy, r, 0, Math.PI * 2); x.fill();
    x.globalAlpha = 0.55; x.fillStyle = light;
    x.beginPath(); x.arc(cx - r * 0.22, cy - r * 0.22, r * 0.55, 0, Math.PI * 2); x.fill();
    x.globalAlpha = 0.35; x.strokeStyle = light; x.lineWidth = Math.max(1, r * 0.12);
    x.beginPath(); x.arc(cx, cy, r, 0, Math.PI * 2); x.stroke();
    if (rays) {
      x.globalAlpha = 0.12; x.strokeStyle = light; x.lineWidth = 1.5;
      for (let i = 0; i < 8; i++) {
        const a = Math.random() * Math.PI * 2, L = r * (2 + Math.random() * 4);
        x.beginPath(); x.moveTo(cx, cy);
        x.lineTo(cx + Math.cos(a) * L, cy + Math.sin(a) * L);
        x.stroke();
      }
    }
    x.globalAlpha = 1;
  }
  function rocky(base, spots, n, capColor, blobSize) {
    return canvasTex((x, w, h) => {
      x.fillStyle = base; x.fillRect(0, 0, w, h);
      const bs = blobSize || 26;
      for (let i = 0; i < n; i++) blob(x, Math.random() * w, Math.random() * h, bs * 2.2, spots[(Math.random() * spots.length) | 0], 0.22);
      for (let i = 0; i < n * 1.6; i++) blob(x, Math.random() * w, Math.random() * h, bs, spots[(Math.random() * spots.length) | 0], 0.3);
      for (let i = 0; i < n * 2.5; i++) blob(x, Math.random() * w, Math.random() * h, bs * 0.4, spots[(Math.random() * spots.length) | 0], 0.35);
      x.globalAlpha = 0.16; x.strokeStyle = '#000'; x.lineWidth = 1.6;
      for (let i = 0; i < 26; i++) {
        let px = Math.random() * w, py = Math.random() * h;
        x.beginPath(); x.moveTo(px, py);
        for (let s = 0; s < 14; s++) { px += (Math.random() - 0.5) * 70; py += (Math.random() - 0.5) * 26; x.lineTo(px, py); }
        x.stroke();
      }
      x.globalAlpha = 1;
      for (let i = 0; i < 26; i++) craterAt(x, Math.random() * w, Math.random() * h, 3 + Math.random() * 12, 'rgba(0,0,0,0.7)', 'rgba(255,255,255,0.55)', false);
      if (capColor) {
        x.globalAlpha = 0.95; x.fillStyle = capColor;
        x.beginPath(); x.ellipse(w/2, 0, w/1.5, h*0.055, 0, 0, Math.PI*2); x.fill();
        x.beginPath(); x.ellipse(w/2, h, w/1.5, h*0.055, 0, 0, Math.PI*2); x.fill();
      }
      detailPass(x, w, h, 1);
    });
  }
  function banded(colors, storm) {
    return canvasTex((x, w, h) => {
      let y = 0;
      while (y < h) {
        const bh = h * (0.018 + Math.random() * 0.055);
        x.fillStyle = colors[(Math.random() * colors.length) | 0];
        x.fillRect(0, y, w, bh + 1);
        x.globalAlpha = 0.35;
        for (let i = 0; i < 22; i++) {
          x.beginPath();
          x.ellipse(Math.random()*w, y + bh*Math.random(), 30+Math.random()*90, 2.5+Math.random()*5, 0, 0, Math.PI*2);
          x.fillStyle = colors[(Math.random() * colors.length) | 0];
          x.fill();
        }
        x.globalAlpha = 0.2; x.strokeStyle = colors[(Math.random() * colors.length) | 0]; x.lineWidth = 2;
        for (let i = 0; i < 6; i++) {
          x.beginPath();
          x.arc(Math.random() * w, y + bh, 4 + Math.random() * 9, 0, Math.PI * (1 + Math.random()));
          x.stroke();
        }
        x.globalAlpha = 1;
        y += bh;
      }
      if (storm) {
        x.fillStyle = storm; x.globalAlpha = 0.9;
        x.beginPath(); x.ellipse(w*0.68, h*0.62, w*0.055, h*0.045, 0, 0, Math.PI*2); x.fill();
        x.globalAlpha = 0.5; x.strokeStyle = storm; x.lineWidth = 3;
        x.beginPath(); x.ellipse(w*0.68, h*0.62, w*0.075, h*0.06, 0, 0, Math.PI*2); x.stroke();
        x.globalAlpha = 1;
      }
      detailPass(x, w, h, 0.5);
    });
  }
  function cratered(base, dark, light) {
    return canvasTex((x, w, h) => {
      x.fillStyle = base; x.fillRect(0, 0, w, h);
      for (let i = 0; i < 60; i++) blob(x, Math.random()*w, Math.random()*h, 44, dark, 0.14);
      for (let i = 0; i < 80; i++) blob(x, Math.random()*w, Math.random()*h, 18, light, 0.1);
      for (let i = 0; i < 240; i++) {
        craterAt(x, Math.random() * w, Math.random() * h, 1.5 + Math.random() * 15, dark, light, Math.random() < 0.06);
      }
      detailPass(x, w, h, 1.2);
    });
  }
  function earthlike(seaTop, seaMid, greens, capAlpha) {
    return canvasTex((x, w, h) => {
      const sea = x.createLinearGradient(0, 0, 0, h);
      sea.addColorStop(0, seaTop); sea.addColorStop(0.5, seaMid); sea.addColorStop(1, seaTop);
      x.fillStyle = sea; x.fillRect(0, 0, w, h);
      for (let i = 0; i < 30; i++) blob(x, Math.random() * w, Math.random() * h, 60, 'rgba(0,0,30,0.5)', 0.1);
      const centers = [];
      for (let i = 0; i < 24; i++) centers.push([Math.random() * w, h * 0.15 + Math.random() * h * 0.7]);
      for (const c of centers) blob(x, c[0], c[1], 78, '#3a7ab8', 0.3); // shallow-water halo
      for (const c of centers) {
        blob(x, c[0], c[1], 64, greens[(Math.random() * greens.length) | 0], 0.9);
        for (let k2 = 0; k2 < 4; k2++) blob(x, c[0] + (Math.random()-0.5)*150, c[1] + (Math.random()-0.5)*70, 30, greens[(Math.random() * greens.length) | 0], 0.8);
        for (let k2 = 0; k2 < 7; k2++) blob(x, c[0] + (Math.random()-0.5)*190, c[1] + (Math.random()-0.5)*90, 13, greens[(Math.random() * greens.length) | 0], 0.7);
        x.globalAlpha = 0.25; x.fillStyle = '#2a2a1a';
        for (let k2 = 0; k2 < 40; k2++) {
          x.fillRect(c[0] + (Math.random()-0.5)*120, c[1] + (Math.random()-0.5)*60, 2.5, 2.5);
        }
        x.globalAlpha = 1;
      }
      for (let i = 0; i < 14; i++) blob(x, Math.random() * w, h*0.38 + Math.random() * h*0.24, 22, '#c2a25a', 0.4);
      x.globalAlpha = capAlpha; x.fillStyle = '#f4f8ff';
      x.beginPath(); x.ellipse(w/2, 0, w/1.4, h*0.06, 0, 0, Math.PI*2); x.fill();
      x.beginPath(); x.ellipse(w/2, h, w/1.4, h*0.07, 0, 0, Math.PI*2); x.fill();
      detailPass(x, w, h, 1.6);
    }, 2048, 1024);
  }
  const cloudTex = canvasTex((x, w, h) => {
    x.clearRect(0, 0, w, h);
    for (let i = 0; i < 40; i++) blob(x, Math.random() * w, Math.random() * h, 40, '#ffffff', 0.1);
    for (let i = 0; i < 70; i++) blob(x, Math.random() * w, Math.random() * h, 18, '#ffffff', 0.14);
    x.globalAlpha = 0.1; x.fillStyle = '#fff';
    for (let i = 0; i < 60; i++) {
      x.beginPath();
      x.ellipse(Math.random() * w, Math.random() * h, 60 + Math.random() * 120, 4 + Math.random() * 8, 0, 0, Math.PI * 2);
      x.fill();
    }
    x.globalAlpha = 1;
  });
  function starTex(c1, c2, spot1, spot2) {
    return canvasTex((x, w, h) => {
      const g = x.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, c1); g.addColorStop(0.5, c2); g.addColorStop(1, c1);
      x.fillStyle = g; x.fillRect(0, 0, w, h);
      for (let i = 0; i < 500; i++) {
        x.globalAlpha = 0.15;
        x.fillStyle = Math.random() > 0.5 ? spot1 : spot2;
        x.beginPath();
        x.arc(Math.random() * w, Math.random() * h, 4 + Math.random() * 22, 0, Math.PI * 2);
        x.fill();
      }
      x.globalAlpha = 1;
    });
  }
  const ringTex = canvasTex((x, w, h) => {
    const cols = ['#cbb287', '#a89066', '#e2d0a8', '#8f7a55', '#d8c498'];
    let px = 0;
    while (px < w) {
      const bw = 3 + Math.random() * 18;
      x.fillStyle = cols[(Math.random() * cols.length) | 0];
      x.globalAlpha = 0.25 + Math.random() * 0.75;
      x.fillRect(px, 0, bw + 1, h);
      px += bw;
    }
    x.globalAlpha = 1; x.fillStyle = '#000';
    x.fillRect(w * 0.55, 0, w * 0.05, h);
    x.fillRect(w * 0.3, 0, w * 0.015, h);
  }, 512, 8);

  // ---------- Atmosphere shader ----------
  const atmoVert = '#include <common>\n#include <logdepthbuf_pars_vertex>\n' +
    'varying vec3 vNormal; varying vec3 vPosW;\n' +
    'void main(){ vNormal = normalize(mat3(modelMatrix) * normal);\n' +
    'vPosW = (modelMatrix * vec4(position,1.0)).xyz;\n' +
    'gl_Position = projectionMatrix * viewMatrix * vec4(vPosW,1.0);\n' +
    '#include <logdepthbuf_vertex>\n}';
  const atmoFrag = '#include <common>\n#include <logdepthbuf_pars_fragment>\n' +
    'uniform vec3 glowColor; uniform vec3 sunDirection; uniform float fade; uniform float starVisibility; varying vec3 vNormal; varying vec3 vPosW;\n' +
    'void main(){\n#include <logdepthbuf_fragment>\n' +
    'vec3 viewDir = normalize(cameraPosition - vPosW);\n' +
    'vec3 n = normalize(vNormal);\n' +
    'vec3 s = normalize(sunDirection);\n' +
    'float mu = clamp(dot(n, viewDir), 0.0, 1.0);\n' +
    'float sunMu = dot(n, s);\n' +
    'float viewSun = clamp(dot(viewDir, s), -1.0, 1.0);\n' +
    'float opticalDepth = 1.0 / (0.12 + mu * 2.8);\n' +
    'float horizon = pow(1.0 - mu, 2.15);\n' +
    'float day = smoothstep(-0.32, 0.12, sunMu);\n' +
    'float rayleighPhase = 0.75 * (1.0 + viewSun * viewSun);\n' +
    'float g = 0.76; float miePhase = (1.0-g*g) / pow(max(0.08,1.0+g*g-2.0*g*viewSun),1.5);\n' +
    'float sunset = exp(-pow((sunMu + 0.075) * 6.5, 2.0)) * smoothstep(-0.36,0.08,sunMu);\n' +
    'vec3 rayleigh = glowColor * rayleighPhase * (0.28 + 0.72 * day);\n' +
    'vec3 aerosol = vec3(1.0,0.62,0.28) * miePhase * 0.055 * day;\n' +
    'vec3 warm = vec3(1.0,0.16,0.025) * sunset * opticalDepth * 0.22;\n' +
    'vec3 color = (rayleigh + aerosol + warm) * (0.08 + 0.92 * starVisibility);\n' +
    'float alpha = horizon * clamp(opticalDepth*.48,0.0,1.0) * (0.08 + 0.92*day) * fade;\n' +
    'gl_FragColor = vec4(color, alpha); }';
  function atmoMaterial(colorHex) {
    return new THREE.ShaderMaterial({
      uniforms: {
        glowColor: { value: new THREE.Color(colorHex) },
        sunDirection: { value: new THREE.Vector3(1, 0, 0) },
        fade: { value: 1 },
        starVisibility: { value: 1 }
      },
      vertexShader: atmoVert, fragmentShader: atmoFrag,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.FrontSide
    });
  }

  // ---------- Bodies ----------
  const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
  const planets = [];
  const stars = [];
  const stellarSurfaceMaterials=[];

  function stellarSurfaceMaterial(o){
    const material=new THREE.ShaderMaterial({
      uniforms:{surfaceMap:{value:o.tex},time:{value:0},temperature:{value:(o.temperature||5772)/5772}},
      vertexShader:'#include <common>\n#include <logdepthbuf_pars_vertex>\nvarying vec2 vStarUv;varying vec3 vStarNormal;varying vec3 vStarWorld;\nvoid main(){vStarUv=uv;vStarNormal=normalize(mat3(modelMatrix)*normal);vStarWorld=(modelMatrix*vec4(position,1.0)).xyz;gl_Position=projectionMatrix*viewMatrix*vec4(vStarWorld,1.0);\n#include <logdepthbuf_vertex>\n}',
      fragmentShader:'#include <common>\n#include <logdepthbuf_pars_fragment>\nuniform sampler2D surfaceMap;uniform float time;uniform float temperature;varying vec2 vStarUv;varying vec3 vStarNormal;varying vec3 vStarWorld;\nfloat hash21(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}\nvoid main(){\n#include <logdepthbuf_fragment>\nvec3 n=normalize(vStarNormal);vec3 viewDir=normalize(cameraPosition-vStarWorld);float mu=clamp(dot(n,viewDir),0.0,1.0);vec2 flow=vStarUv+vec2(time*.00035,time*.00011);vec3 base=texture2D(surfaceMap,flow).rgb;float cells=hash21(floor(flow*vec2(420.0,210.0)));float granulation=(cells-.5)*.16;float convection=sin(flow.x*820.0+sin(flow.y*75.0+time*.17)*5.0)*.025;float limb=.38+.62*pow(mu,.46);float facula=pow(1.0-mu,2.0)*max(0.0,granulation)*1.7;vec3 color=base*(limb+granulation+convection+facula)*(1.18+clamp(temperature-.45,0.0,1.8)*.08);gl_FragColor=vec4(color,1.0);\n#include <tonemapping_fragment>\n#include <encodings_fragment>\n}',
      depthWrite:true
    });
    stellarSurfaceMaterials.push(material);return material;
  }

  function orbitPos(center, R, angleDeg, incDeg) {
    const a = angleDeg * Math.PI / 180, inc = incDeg * Math.PI / 180;
    return new THREE.Vector3(
      center.x + R * Math.cos(a),
      center.y + R * Math.sin(a) * Math.sin(inc),
      center.z + R * Math.sin(a) * Math.cos(inc));
  }
  function addOrbitLine(center, R, incDeg) {
    const inc = incDeg * Math.PI / 180, pts = [];
    for (let i = 0; i <= 180; i++) {
      const a = i / 180 * Math.PI * 2;
      pts.push(new THREE.Vector3(
        R * Math.cos(a),
        R * Math.sin(a) * Math.sin(inc),
        R * Math.sin(a) * Math.cos(inc)));
    }
    const g = new THREE.BufferGeometry().setFromPoints(pts);
    const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0x3a4a66, transparent: true, opacity: 0.3 }));
    line.userData.universeOrbitGuide = true;
    line.visible = !universeAnnotationsHidden;
    orbitGuides.push(line);
    track(line, center.clone());
  }

  function addPlanet(o) {
    const geo = new THREE.SphereGeometry(o.r, o.detail ? 96 : 64, o.detail ? 64 : 40);
    let mat;
    if (o.emissive) {
      mat = o.blackhole ? new THREE.MeshBasicMaterial({map:o.tex}) : stellarSurfaceMaterial(o);
    } else {
      mat = new THREE.MeshStandardMaterial({
        map: o.tex,
        bumpMap: o.bump === false ? null : o.tex,
        bumpScale: (o.bumpScale != null ? o.bumpScale : 0.45) * o.r * 1e-5,
        roughness: o.hasOcean ? 0.58 : (o.bump === false ? 0.82 : 0.9),
        metalness: 0
      });
      if (o.bump !== false) reliefQueue.push(o); // relief computed in the background
    }
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = !o.emissive;
    mesh.receiveShadow = !o.emissive;
    o.qTilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), o.tilt || 0);
    o.spinAxis = new THREE.Vector3(0, 1, 0).applyQuaternion(o.qTilt);
    o.velNow = new THREE.Vector3();
    o.prevCenter = o.center.clone();
    o.spinW = 0;
    mesh.quaternion.copy(o.qTilt);
    track(mesh, o.center);
    o.mesh = mesh;
    o.soi = o.soiMult ? o.r * o.soiMult : o.r * 7;

    if (o.atmosphere) {
      o.atmoMat = atmoMaterial(o.atmosphere);
      const atm = new THREE.Mesh(new THREE.SphereGeometry(o.r * 1.045, 48, 30), o.atmoMat);
      track(atm, o.center);
      o.atmoMesh = atm;
    }
    if (o.clouds) {
      const cl = new THREE.Mesh(
        new THREE.SphereGeometry(o.r * 1.012, o.detail ? 80 : 48, o.detail ? 52 : 30),
        new THREE.MeshStandardMaterial({
          map: o.clouds, transparent: true, opacity: 0.82, depthWrite: false,
          side: THREE.DoubleSide, roughness: 1, metalness: 0, alphaTest: 0.015
        })
      );
      cl.castShadow = true;
      cl.quaternion.copy(o.qTilt);
      track(cl, o.center);
      o.cloudMesh = cl;
    }
    if (o.ring) {
      const rg = new THREE.RingGeometry(o.r * 1.4, o.r * 2.3, 96, 1);
      const posAttr = rg.attributes.position, uvAttr = rg.attributes.uv;
      const inner = o.r * 1.4, outer = o.r * 2.3;
      for (let i = 0; i < posAttr.count; i++) {
        const vx = posAttr.getX(i), vy = posAttr.getY(i);
        const rr = Math.sqrt(vx * vx + vy * vy);
        uvAttr.setXY(i, (rr - inner) / (outer - inner), 0.5);
      }
      const ring = new THREE.Mesh(rg, new THREE.MeshStandardMaterial({
        map:ringTex,transparent:true,opacity:.9,side:THREE.DoubleSide,
        roughness:.84,metalness:0,alphaTest:.018,depthWrite:true
      }));
      ring.rotation.x = Math.PI / 2 - 0.35;
      ring.castShadow=true;ring.receiveShadow=true;
      track(ring, o.center);
      o.ringMesh = ring;
    }
    const lw = o.center.clone().add(new THREE.Vector3(0, o.r * 1.8, 0));
    const entry = { spr: null, w: lw, r: o.r, body: o };
    labels.push(entry);
    o.labelEntry = entry;

    planets.push(o);
    return o;
  }

  function ensureBodyLabel(entry) {
    if (entry.spr) return entry.spr;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: canvasTex((x, w, h) => {
        x.font = 'bold 64px Segoe UI, Arial';
        x.textAlign = 'center'; x.textBaseline = 'middle';
        x.shadowColor = '#000'; x.shadowBlur = 14;
        x.fillStyle = '#dceaff';
        x.fillText(entry.body.name.toUpperCase(), w / 2, h / 2);
      }, 512, 128),
      transparent: true, depthWrite: false, opacity: 0.9
    }));
    entry.spr = sprite;
    track(sprite, entry.w);
    sprite.position.copy(entry.w).sub(pos);
    return sprite;
  }

  function addStar(o) {
    o.emissive = true; o.deadly = true; o.isStar = true; o.soiMult = 0.001;
    o.temperature=o.temperature||5772;
    o.luminosity=o.luminosity||Math.pow(o.r/6.96e7,2)*Math.pow(o.temperature/5772,4);
    addPlanet(o);
    // Astronomical point lights lose precision and used to double-light the
    // local scene. A single inverse-square directional primary is updated from
    // the nearest star each frame, which is physically equivalent at local scale.
    function glow(size, pulse) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({
        map: softSprite(o.glowInner || 'rgba(255,230,150,1)', o.glowMid || 'rgba(255,170,60,0.4)'),
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
      }));
      s.scale.set(size, size, 1);
      track(s, o.center);
      glows.push({ spr: s, w: o.center, base: size, pulse: pulse, body:o });
      return s;
    }
    glow(o.r * 6.5, false);
    glow(o.r * 3.7, true);
    stars.push(o);
    return o;
  }

  const AU = 1.496e10;
  const LYS = 9.461e14;
  const RE = 6.371e5;   // Earth radius (scaled)

  function landGreen(r, g, b) { return g > b + 8 || (r > 120 && r > b + 25); }
  function landBright(r, g, b) { return (r + g + b) > 330; }

  // ===== SOL =====
  const sun = addStar({ name: 'Sun', r: 6.96e7, g: 274, center: V3(0, 0, 0),
    tex: starTex('#ffdd55', '#ff9a1f', '#ffe98a', '#e8641b'),
    temperature:5772,luminosity:1,
    lightColor: 0xfff2d0, lightRange: 9e11, glowInner: 'rgba(255,230,150,1)', glowMid: 'rgba(255,170,60,0.4)' });

  addOrbitLine(sun.center, 0.387 * AU, 3.4);
  const mercury = addPlanet({ name: 'Mercury', r: 2.44e5, g: 3.7, center: orbitPos(sun.center, 0.387 * AU, 25, 3.4), tex: cratered('#8d7f72', '#5f554b', '#b0a293'), bumpScale: 0.6, props: 'rocky', propColor: 0x8d7f72 });
  addOrbitLine(sun.center, 0.723 * AU, 3.39);
  const venus = addPlanet({ name: 'Venus', r: 6.052e5, g: 8.87, center: orbitPos(sun.center, 0.723 * AU, 135, 3.39), tex: rocky('#caa05a', ['#e0bc7a', '#a9803e', '#d8c08e'], 40, null, 30), atmosphere: 0xe8c87a, tilt: 0.05, bumpScale: 0.25, props: 'rocky', propColor: 0xc9a05a });
  addOrbitLine(sun.center, AU, 0);
  const earth = addPlanet({ name: 'Earth', r: RE, g: 9.81, center: orbitPos(sun.center, AU, 0, 0),
    tex: earthlike('#0d3f7a', '#10519e', ['#2e7d32', '#3f8f3f', '#56792f', '#27693f', '#7a6a35'], 0.95),
    atmosphere: 0x6db3ff, clouds: cloudTex, tilt: 0.41, specular: 0x335577, shininess: 16, bumpScale: 0.3,
    hasOcean: true, detail: true, landFn: landGreen, props: 'forest', propColor: 0x2e7d32, trunkColor: 0x6a4a2a, rockColor: 0x8a8d92 });
  const moon = addPlanet({ name: 'Moon', r: 1.737e5, g: 1.62, center: earth.center.clone().add(V3(2.5e7, 1.4e7, 2.5e7)), tex: cratered('#9a9a9a', '#6e6e6e', '#c2c2c2'), bumpScale: 0.7, soiMult: 5, props: 'rocky', propColor: 0x9a9a9a });
  addOrbitLine(sun.center, 1.52 * AU, 1.85);
  const mars = addPlanet({ name: 'Mars', r: 3.39e5, g: 3.71, center: orbitPos(sun.center, 1.52 * AU, 305, 1.85), tex: rocky('#b34a26', ['#8c2f12', '#d2693f', '#7a3a20'], 46, '#e8d9c8', 28), tilt: 0.44, bumpScale: 0.5, props: 'rocky', propColor: 0x9c4a26 });
  addOrbitLine(sun.center, 5.2 * AU, 1.3);
  const jupiter = addPlanet({ name: 'Jupiter', r: 6.9911e6, g: 24.79, center: orbitPos(sun.center, 5.2 * AU, 55, 1.3), tex: banded(['#c9a06c', '#a9764a', '#e3c8a0', '#8a5a36', '#d8b288'], '#b5502e'), tilt: 0.05, bump: false });
  addOrbitLine(sun.center, 9.58 * AU, 2.49);
  const saturn = addPlanet({ name: 'Saturn', r: 5.8232e6, g: 10.44, center: orbitPos(sun.center, 9.58 * AU, 160, 2.49), tex: banded(['#e0c690', '#c8a86a', '#efe0b8', '#b6925a'], null), ring: true, tilt: 0.47, bump: false });
  addOrbitLine(sun.center, 19.2 * AU, 0.77);
  const uranus = addPlanet({ name: 'Uranus', r: 2.5362e6, g: 8.87, center: orbitPos(sun.center, 19.2 * AU, 240, 0.77), tex: rocky('#7fd4e0', ['#9ae2ea', '#68bcd0'], 24, null, 36), atmosphere: 0x9ae2ea, tilt: 1.7, bump: false });
  addOrbitLine(sun.center, 30.1 * AU, 1.77);
  const neptune = addPlanet({ name: 'Neptune', r: 2.4622e6, g: 11.15, center: orbitPos(sun.center, 30.1 * AU, 95, 1.77), tex: rocky('#2f5bd4', ['#4a78ea', '#244aa8', '#6f93f0'], 32, null, 34), atmosphere: 0x4a78ea, tilt: 0.49, bump: false });

  // Major moons and dwarf planets use true 1:10 radii and orbital distances.
  // They share the existing procedural texture system, keeping the expanded
  // Solar System lightweight and available offline.
  const phobos = addPlanet({ name: 'Phobos', bodyType: 'MOON', r: 1.126e3, g: 0.0057, center: orbitPos(mars.center, 9.376e5, 15, 1.1), tex: cratered('#76685b','#443c36','#938474'), bump: false });
  const deimos = addPlanet({ name: 'Deimos', bodyType: 'MOON', r: 620, g: 0.003, center: orbitPos(mars.center, 2.346e6, 210, 1.8), tex: cratered('#82756a','#524941','#a19486'), bump: false });
  const io = addPlanet({ name: 'Io', bodyType: 'MOON', r: 1.8216e5, g: 1.796, center: orbitPos(jupiter.center, 4.217e7, 25, 0.04), tex: rocky('#d8bf62',['#f0d878','#9f6a36','#efe4a5'],44,null,28), bump: false });
  const europa = addPlanet({ name: 'Europa', bodyType: 'MOON', r: 1.5608e5, g: 1.315, center: orbitPos(jupiter.center, 6.711e7, 110, 0.47), tex: rocky('#d9d3bb',['#f1eee1','#9d866d','#c7b99d'],34,null,38), bump: false });
  const ganymede = addPlanet({ name: 'Ganymede', bodyType: 'MOON', r: 2.6341e5, g: 1.428, center: orbitPos(jupiter.center, 1.0704e8, 205, 0.2), tex: cratered('#7c7164','#4e4944','#a49a8c'), bump: false });
  const callisto = addPlanet({ name: 'Callisto', bodyType: 'MOON', r: 2.4103e5, g: 1.235, center: orbitPos(jupiter.center, 1.8827e8, 300, 0.28), tex: cratered('#625a52','#332f2c','#8d8378'), bump: false });
  const enceladus = addPlanet({ name: 'Enceladus', bodyType: 'MOON', r: 2.521e4, g: 0.113, center: orbitPos(saturn.center, 2.3795e7, 40, 0.01), tex: rocky('#e4edf3',['#ffffff','#b9d5e7','#d9e6ef'],24,null,40), bump: false });
  const rhea = addPlanet({ name: 'Rhea', bodyType: 'MOON', r: 7.638e4, g: 0.264, center: orbitPos(saturn.center, 5.271e7, 140, 0.35), tex: cratered('#aaa59e','#74716d','#d1ccc4'), bump: false });
  const titan = addPlanet({ name: 'Titan', bodyType: 'MOON', r: 2.5747e5, g: 1.352, center: orbitPos(saturn.center, 1.2219e8, 230, 0.33), tex: rocky('#b8843f',['#d5a258','#936226','#e2b66d'],30,null,32), atmosphere: 0xd58c3b, bump: false });
  const iapetus = addPlanet({ name: 'Iapetus', bodyType: 'MOON', r: 7.346e4, g: 0.223, center: orbitPos(saturn.center, 3.5608e8, 315, 15.5), tex: rocky('#b8b1a7',['#ede7dd','#514840','#8d8176'],28,null,34), bump: false });
  const triton = addPlanet({ name: 'Triton', bodyType: 'MOON', r: 1.3534e5, g: 0.779, center: orbitPos(neptune.center, 3.5476e7, 70, 157), tex: rocky('#c2a6a6',['#e5d2cb','#9d7c83','#c8b9aa'],28,null,36), atmosphere: 0x9ab8cf, bump: false });

  const ceres = addPlanet({ name: 'Ceres', bodyType: 'DWARF PLANET', r: 4.73e4, g: 0.27, center: orbitPos(sun.center, 2.77 * AU, 195, 10.6), tex: cratered('#77746e','#4d4b48','#aaa69d'), bump: false });
  const pluto = addPlanet({ name: 'Pluto', bodyType: 'DWARF PLANET', r: 1.1883e5, g: 0.62, center: orbitPos(sun.center, 39.48 * AU, 250, 17.2), tex: rocky('#b99b83',['#e6d0b8','#755e55','#c8ae94'],38,null,32), bump: false });
  const charon = addPlanet({ name: 'Charon', bodyType: 'MOON', r: 6.06e4, g: 0.288, center: orbitPos(pluto.center, 1.9596e6, 30, 0.1), tex: cratered('#8d8985','#585552','#bbb7b2'), bump: false });
  const haumea = addPlanet({ name: 'Haumea', bodyType: 'DWARF PLANET', r: 7.8e4, g: 0.4, center: orbitPos(sun.center, 43.1 * AU, 330, 28.2), tex: rocky('#d8d7d2',['#f1f3f4','#aaa9a5'],22,null,42), bump: false });
  haumea.mesh.scale.set(1.28, 0.82, 0.76);
  const makemake = addPlanet({ name: 'Makemake', bodyType: 'DWARF PLANET', r: 7.15e4, g: 0.5, center: orbitPos(sun.center, 45.79 * AU, 125, 29), tex: rocky('#a87559',['#d6ad8b','#73483b','#bd8b6d'],28,null,34), bump: false });
  const eris = addPlanet({ name: 'Eris', bodyType: 'DWARF PLANET', r: 1.163e5, g: 0.82, center: orbitPos(sun.center, 67.7 * AU, 45, 44), tex: rocky('#d4d2cd',['#f3f4f2','#aaa8a5','#c5c1bb'],24,null,40), bump: false });

  // ===== PROXIMA CENTAURI (4.25 ly) =====
  const proxima = addStar({ name: 'Proxima Centauri', r: 1.07e7, g: 160, center: V3(0.62, 0.08, -0.5).normalize().multiplyScalar(4.25 * LYS),
    tex: starTex('#ff8a66', '#e0421f', '#ffae8a', '#a82a10'),
    temperature:3042,luminosity:.0017,
    lightColor: 0xffb098, lightRange: 4e10, glowInner: 'rgba(255,140,100,1)', glowMid: 'rgba(220,60,30,0.4)' });
  addOrbitLine(proxima.center, 0.0485 * AU, 4);
  addPlanet({ name: 'Proxima b', r: 1.07 * RE, g: 11, center: orbitPos(proxima.center, 0.0485 * AU, 40, 4),
    tex: rocky('#9c4a3a', ['#c96a4a', '#6e3026', '#e0a080'], 46, null, 30), atmosphere: 0xd98a66, tilt: 0.3, bumpScale: 0.5, props: 'rocky', propColor: 0xa55038 });
  addOrbitLine(proxima.center, 1.489 * AU, 2.5);
  addPlanet({ name: 'Proxima c', r: 1.3 * RE, g: 12, center: orbitPos(proxima.center, 1.489 * AU, 210, 2.5),
    tex: rocky('#b8d8e8', ['#dceef8', '#8ab8d0', '#eef8ff'], 36, null, 34), atmosphere: 0xbfe8ff, tilt: 0.35, bumpScale: 0.3, props: 'rocky', propColor: 0xbfe8ff });

  // ===== ALPHA CENTAURI A & B (4.37 ly, no known planets) =====
  addStar({ name: 'Alpha Centauri A', r: 8.5e7, g: 280, center: V3(0.64, 0.1, -0.48).normalize().multiplyScalar(4.37 * LYS),
    tex: starTex('#fff3c8', '#ffd24a', '#fffbe8', '#e8a01f'), noLight: true,
    temperature:5790,luminosity:1.52,
    glowInner: 'rgba(255,245,200,1)', glowMid: 'rgba(255,210,90,0.4)' });
  addStar({ name: 'Alpha Centauri B', r: 6e7, g: 250, center: V3(0.645, 0.09, -0.475).normalize().multiplyScalar(4.37 * LYS),
    tex: starTex('#ffd9a0', '#ff9a40', '#ffeac8', '#d87a20'), noLight: true,
    temperature:5260,luminosity:.50,
    glowInner: 'rgba(255,215,160,1)', glowMid: 'rgba(255,160,60,0.4)' });

  // ===== SIRIUS (8.6 ly) & BARNARD'S STAR (5.96 ly) =====
  addStar({ name: 'Sirius', r: 1.19e8, g: 320, center: V3(-0.5, -0.2, 0.84).normalize().multiplyScalar(8.6 * LYS),
    tex: starTex('#eaf2ff', '#bcd6ff', '#ffffff', '#9ec0ff'), noLight: true,
    temperature:9940,luminosity:25.4,
    glowInner: 'rgba(220,235,255,1)', glowMid: 'rgba(150,190,255,0.45)' });
  addStar({ name: "Barnard's Star", r: 1.36e7, g: 140, center: V3(0.1, 0.55, 0.83).normalize().multiplyScalar(5.96 * LYS),
    tex: starTex('#ff9a70', '#e04a20', '#ffb89a', '#a83012'), noLight: true,
    temperature:3134,luminosity:.0035,
    glowInner: 'rgba(255,150,110,1)', glowMid: 'rgba(220,70,30,0.4)' });

  // ===== TRAPPIST-1 (40.7 ly): 7 real rocky worlds =====
  const trappist = addStar({ name: 'TRAPPIST-1', r: 8.4e6, g: 180, center: V3(-0.3, -0.15, -0.94).normalize().multiplyScalar(40.7 * LYS),
    tex: starTex('#ff7a55', '#c83a18', '#ff9a80', '#902a0a'),
    temperature:2566,luminosity:.00055,
    lightColor: 0xff9a80, lightIntensity: 2.0, lightRange: 2e10, glowInner: 'rgba(255,130,90,1)', glowMid: 'rgba(200,55,25,0.4)' });
  (function () {
    const data = [
      ['b', 1.12, 0.0115, '#7a4a30', ['#9c6a48', '#5a3520', '#b88a60'], 'rocky'],
      ['c', 1.10, 0.0158, '#8a5038', ['#aa7050', '#6a3a26', '#c89070'], 'rocky'],
      ['d', 0.78, 0.0223, '#9a8a6a', ['#b8a888', '#7a6a4a', '#d0c0a0'], 'rocky'],
      ['e', 0.91, 0.0293, '#5a7a8a', ['#7a9aaa', '#3a5a6a', '#a0c0d0'], 'rocky'],
      ['f', 1.05, 0.0385, '#8ab0c8', ['#aad0e8', '#6a90a8', '#cae8f8'], 'rocky'],
      ['g', 1.13, 0.0469, '#a0c4d8', ['#c0e4f0', '#80a4b8', '#e0f4ff'], 'rocky'],
      ['h', 0.76, 0.0619, '#c0d8e8', ['#e0f0f8', '#a0b8c8', '#f0f8ff'], 'ice']
    ];
    for (let i = 0; i < data.length; i++) {
      const d = data[i];
      addOrbitLine(trappist.center, d[2] * AU, 2 + i * 0.5);
      addPlanet({ name: 'TRAPPIST-1' + d[0], r: d[1] * RE, g: d[1] * 9.8, center: orbitPos(trappist.center, d[2] * AU, i * 51, 2 + i * 0.5),
        tex: rocky(d[3], d[4], 40, null, 28), bumpScale: 0.45, props: d[5], propColor: parseInt(d[3].slice(1), 16) });
    }
  })();

  // ===== KEPLER-186 (~580 ly) =====
  const kepler = addStar({ name: 'Kepler-186', r: 3.9e7, g: 188, center: V3(-0.78, -0.09, 0.62).normalize().multiplyScalar(580 * LYS),
    tex: starTex('#ff8a66', '#e0421f', '#ffae8a', '#a82a10'),
    temperature:3788,luminosity:.055,
    lightColor: 0xffb098, lightIntensity: 2.0, lightRange: 1.4e10, glowInner: 'rgba(255,140,100,1)', glowMid: 'rgba(220,60,30,0.4)' });
  addOrbitLine(kepler.center, 0.0378 * AU, 3);
  addPlanet({ name: 'Kepler-186b', r: 1.07 * RE, g: 10.5, center: orbitPos(kepler.center, 0.0378 * AU, 290, 3),
    tex: rocky('#2a2125', ['#d04a1a', '#7a2a10', '#3a2a22', '#ff7a2a'], 56, null, 22), atmosphere: 0xcc4422, tilt: 0.2, bumpScale: 0.65, props: 'rocky', propColor: 0x3a2a22 });
  addOrbitLine(kepler.center, 0.432 * AU, 5);
  addPlanet({ name: 'Kepler-186f', r: 1.17 * RE, g: 11.5, center: orbitPos(kepler.center, 0.432 * AU, 120, 5),
    tex: earthlike('#3a2f5e', '#4a3d78', ['#8a5fb0', '#6a4a92', '#b08ad0', '#5a3a80'], 0.85),
    atmosphere: 0xa080d8, clouds: cloudTex, tilt: 0.4, specular: 0x443366, shininess: 14, bumpScale: 0.3,
    hasOcean: true, landFn: landBright, props: 'rocky', propColor: 0x9a6fd0, rockColor: 0x6a5a85 });

  // ===== KEPLER-452 (~1400 ly) =====
  const k452 = addStar({ name: 'Kepler-452', r: 7.7e7, g: 270, center: V3(0.45, 0.3, 0.84).normalize().multiplyScalar(1400 * LYS),
    tex: starTex('#fff0c0', '#ffce5a', '#fff8e0', '#e8a830'),
    temperature:5757,luminosity:1.2,
    lightColor: 0xfff0d0, lightRange: 5e10, glowInner: 'rgba(255,240,200,1)', glowMid: 'rgba(255,200,90,0.4)' });
  addOrbitLine(k452.center, 1.046 * AU, 2);
  addPlanet({ name: 'Kepler-452b', r: 1.5 * RE, g: 14.7, center: orbitPos(k452.center, 1.046 * AU, 75, 2),
    tex: earthlike('#0d4a6a', '#0f5e88', ['#3a8a3a', '#4f9a44', '#6a8a30', '#2a7a4a'], 0.9),
    atmosphere: 0x7ac0e8, clouds: cloudTex, tilt: 0.35, specular: 0x336688, shininess: 15, bumpScale: 0.3,
    hasOcean: true, landFn: landGreen, props: 'rocky', propColor: 0x3a8a3a, rockColor: 0x7a8a7a });

  // ===== 51 PEGASI (50 ly): first exoplanet ever found =====
  const peg51 = addStar({ name: '51 Pegasi', r: 8.6e7, g: 270, center: V3(0.9, 0.2, 0.39).normalize().multiplyScalar(50.6 * LYS),
    tex: starTex('#fff0c8', '#ffd05a', '#fff8e8', '#e8aa30'),
    temperature:5793,luminosity:1.36,
    lightColor: 0xfff0d0, lightRange: 3e10, glowInner: 'rgba(255,240,200,1)', glowMid: 'rgba(255,205,90,0.4)' });
  addOrbitLine(peg51.center, 0.0527 * AU, 2);
  addPlanet({ name: '51 Pegasi b', r: 1.27 * 6.9911e6, g: 22, center: orbitPos(peg51.center, 0.0527 * AU, 200, 2),
    tex: banded(['#e8b870', '#c89048', '#f8d8a0', '#a87030', '#ffc880'], null), tilt: 0.1, bump: false });

  // Earth glows with city lights on the night side (built in the background)
  setTimeout(() => {
    try {
      installEarthNight(nightLights(earth.tex.image));
    } catch (e) {}
    loadTick('Lighting the cities of Earth...');
  }, 600);

  // ===== REAL MOTION: true rotation & orbital periods, time compressed =====
  const TIME_SCALE = 100;           // 1 real second = 100 simulated seconds
  const HOUR = 3600, DAY = 86400;
  const byName = n => planets.find(p => p.name === n);
  function setMotion(p, spinHours, parent, periodDays, R, ang0Deg, incDeg) {
    if (spinHours) {
      p.spinW = (Math.PI * 2) / (spinHours * HOUR);   // rad per simulated second
      const q0 = new THREE.Quaternion().setFromAxisAngle(p.spinAxis, Math.random() * Math.PI * 2);
      p.mesh.quaternion.premultiply(q0);
    }
    if (parent) {
      p.orbit = { parent: parent, R: R, ang: ang0Deg * Math.PI / 180,
                  inc: incDeg * Math.PI / 180, w: (Math.PI * 2) / (periodDays * DAY) };
    }
  }
  setMotion(sun, 601);
  setMotion(mercury, 1407.5, sun, 87.97, 0.387 * AU, 25, 3.4);
  setMotion(venus, -5832.5, sun, 224.7, 0.723 * AU, 135, 3.39);  // retrograde
  setMotion(earth, 23.93, sun, 365.25, AU, 0, 0);
  setMotion(moon, 655.7, earth, 27.32, 3.84e7, 35, 5.1);          // tidally locked
  setMotion(mars, 24.62, sun, 687, 1.52 * AU, 305, 1.85);
  setMotion(jupiter, 9.93, sun, 4332.6, 5.2 * AU, 55, 1.3);
  setMotion(saturn, 10.66, sun, 10759, 9.58 * AU, 160, 2.49);
  setMotion(uranus, -17.24, sun, 30687, 19.2 * AU, 240, 0.77);
  setMotion(neptune, 16.11, sun, 60190, 30.1 * AU, 95, 1.77);
  setMotion(phobos, 7.65, mars, 0.319, 9.376e5, 15, 1.1);
  setMotion(deimos, 30.3, mars, 1.263, 2.346e6, 210, 1.8);
  setMotion(io, 42.46, jupiter, 1.769, 4.217e7, 25, 0.04);
  setMotion(europa, 85.2, jupiter, 3.551, 6.711e7, 110, 0.47);
  setMotion(ganymede, 171.7, jupiter, 7.155, 1.0704e8, 205, 0.2);
  setMotion(callisto, 400.5, jupiter, 16.689, 1.8827e8, 300, 0.28);
  setMotion(enceladus, 32.9, saturn, 1.37, 2.3795e7, 40, 0.01);
  setMotion(rhea, 108.5, saturn, 4.52, 5.271e7, 140, 0.35);
  setMotion(titan, 382.7, saturn, 15.95, 1.2219e8, 230, 0.33);
  setMotion(iapetus, 1903, saturn, 79.33, 3.5608e8, 315, 15.5);
  setMotion(triton, -141.0, neptune, 5.877, 3.5476e7, 70, 157);
  setMotion(ceres, 9.07, sun, 1682, 2.77 * AU, 195, 10.6);
  setMotion(pluto, -153.3, sun, 90560, 39.48 * AU, 250, 17.2);
  setMotion(charon, 153.3, pluto, 6.387, 1.9596e6, 30, 0.1);
  setMotion(haumea, 3.92, sun, 103774, 43.1 * AU, 330, 28.2);
  setMotion(makemake, 22.8, sun, 111845, 45.79 * AU, 125, 29);
  setMotion(eris, 25.9, sun, 203830, 67.7 * AU, 45, 44);
  setMotion(proxima, 1983);
  setMotion(byName('Proxima b'), 11.19 * 24, proxima, 11.19, 0.0485 * AU, 40, 4);   // tidally locked
  setMotion(byName('Proxima c'), 30, proxima, 1884, 1.489 * AU, 210, 2.5);
  setMotion(byName('Alpha Centauri A'), 528);
  setMotion(byName('Alpha Centauri B'), 980);
  setMotion(byName('Sirius'), 134);
  setMotion(byName("Barnard's Star"), 3120);
  setMotion(trappist, 79);
  (function () {
    const orb = [['b', 1.51, 0.0115], ['c', 2.42, 0.0158], ['d', 4.05, 0.0223], ['e', 6.10, 0.0293],
                 ['f', 9.21, 0.0385], ['g', 12.35, 0.0469], ['h', 18.77, 0.0619]];
    for (let i = 0; i < orb.length; i++) {
      setMotion(byName('TRAPPIST-1' + orb[i][0]), orb[i][1] * 24, trappist, orb[i][1], orb[i][2] * AU, i * 51, 2 + i * 0.5);
    }
  })();
  setMotion(kepler, 814);
  setMotion(byName('Kepler-186b'), 3.89 * 24, kepler, 3.89, 0.0378 * AU, 290, 3);
  setMotion(byName('Kepler-186f'), 129.9 * 24, kepler, 129.9, 0.432 * AU, 120, 5);
  setMotion(k452, 638);
  setMotion(byName('Kepler-452b'), 32, k452, 384.8, 1.046 * AU, 75, 2);
  setMotion(peg51, 504);
  setMotion(byName('51 Pegasi b'), 4.23 * 24, peg51, 4.23, 0.0527 * AU, 200, 2);

  // Additional confirmed systems from the bundled NASA Exoplanet Archive
  // snapshot. Shared surface archetypes keep dozens of new worlds inexpensive;
  // their measured sizes, masses, orbits, periods, temperatures and positions
  // remain distinct and drive physics, scale, light and motion.
  (function buildNasaSystems(){
    const systems=window.GODMAN_NASA_SYSTEMS||[];
    if(!systems.length)return;
    const surfaceTextures={
      hot:rocky('#3d1b14',['#7c2717','#d75821','#281515','#f09a3f'],48,null,24),
      rock:rocky('#746b5c',['#9b8d76','#4c4944','#b6aa91','#686052'],42,null,31),
      cold:rocky('#9aa8ad',['#d6e1e4','#64757f','#b9c8cc','#778b91'],34,null,38),
      ice:rocky('#c6d8dc',['#eef7f8','#8fa8b4','#dbe8e9','#708d9a'],30,null,40),
      neptune:banded(['#3e7192','#73a9bf','#28546f','#8ac2d1','#416c88'],null),
      gas:banded(['#b78a5d','#d8b47f','#806044','#ead0a7','#9f704b'],'#8f4936')
    };
    const starTextures={
      red:starTex('#ff8b68','#cf361b','#ffb090','#8d210e'),
      orange:starTex('#ffd09a','#e5792d','#ffe5bd','#b95118'),
      yellow:starTex('#fff0bf','#efb53c','#fff9de','#cf7820'),
      white:starTex('#e9f1ff','#b9d1ff','#ffffff','#86a8ea')
    };
    function starAppearance(temp){return temp<3400?'red':temp<5000?'orange':temp<7500?'yellow':'white';}
    function planetAppearance(radius,temp){
      if(radius>6)return{tex:surfaceTextures.gas,bump:false,atmosphere:0xd5a46f};
      if(radius>1.8)return{tex:surfaceTextures.neptune,bump:false,atmosphere:0x70a9c7};
      if(temp>850)return{tex:surfaceTextures.hot,bumpScale:.62};
      if(temp<190)return{tex:surfaceTextures.ice,bumpScale:.42};
      if(temp<245)return{tex:surfaceTextures.cold,bumpScale:.5};
      return{tex:surfaceTextures.rock,bumpScale:.56};
    }
    for(let si=0;si<systems.length;si++){
      const s=systems[si],ra=s.ra*Math.PI/180,dec=s.dec*Math.PI/180;
      const center=V3(Math.cos(dec)*Math.cos(ra),Math.sin(dec),Math.cos(dec)*Math.sin(ra)).multiplyScalar(s.distanceLy*LYS);
      const stellarRadius=s.radius*6.96e7,stellarGravity=274*s.mass/(s.radius*s.radius);
      const luminosity=s.radius*s.radius*Math.pow(s.temp/5772,4),klass=starAppearance(s.temp);
      const host=addStar({name:s.name,r:stellarRadius,g:stellarGravity,center:center,
        tex:starTextures[klass],temperature:s.temp,luminosity:luminosity,noLight:true,
        glowInner:klass==='red'?'rgba(255,125,90,1)':klass==='orange'?'rgba(255,195,130,1)':'rgba(255,240,205,1)',
        glowMid:klass==='red'?'rgba(210,55,25,.4)':'rgba(255,170,65,.4)'});
      host.archiveData={source:'NASA Exoplanet Archive',distanceLy:s.distanceLy};
      for(let pi=0;pi<s.planets.length;pi++){
        const d=s.planets[pi],radiusEarth=d[1],massEarth=d[2],orbitAu=d[3],periodDays=d[4],eqTemp=d[5];
        const appearance=planetAppearance(radiusEarth,eqTemp),inclination=.6+(pi%5)*.62,angle=(si*83+pi*137)%360;
        const world=addPlanet(Object.assign({name:d[0],bodyType:'EXOPLANET',r:radiusEarth*RE,
          g:9.81*massEarth/(radiusEarth*radiusEarth),center:orbitPos(host.center,orbitAu*AU,angle,inclination),
          tilt:.08+(pi%4)*.11,props:'rocky',propColor:0x77736c},appearance));
        world.archiveData={source:'NASA Exoplanet Archive',eqTemp:eqTemp,massEarth:massEarth,radiusEarth:radiusEarth};
        setMotion(world,0,host,periodDays,orbitAu*AU,angle,inclination);
      }
    }
  })();

  // ===== SAGITTARIUS A* — the supermassive black hole at the galaxy's heart (26,670 ly) =====
  // M87/EHT measurements and stellar-orbit estimates put Sgr A* near
  // 4.3 million solar masses: Schwarzschild radius ~= 12.7 million km.
  // World space is 1:10, so the event-horizon radius is 1.27e9 units.
  const blackhole = addPlanet({ name: 'Sagittarius A*', r: 1.27e9, g: 3.54e6,
    center: V3(0.45, -0.2, 0.87).normalize().multiplyScalar(26670 * LYS),
    tex: canvasTex((x, w, h) => { x.fillStyle = '#000'; x.fillRect(0, 0, w, h); }, 64, 32),
    emissive: true });
  blackhole.isStar = true; blackhole.blackhole = true; blackhole.soiMult = 0.001;
  blackhole.searchAliases=['black hole','blackhole','Sgr A*','Sgr A','event horizon','galactic center'];
  stars.push(blackhole); // its gravity joins the stellar fallback field
  (function buildBlackhole() {
    // The visible image is computed every frame by tracing null rays through a
    // Kerr-aware strong-field approximation in event-horizon units. This is a
    // live simulation, not a texture or pre-rendered black-hole photograph.
    blackhole.mesh.material.visible = false;
    blackhole.diskBands = [];
    blackhole.diskNormalWorld = V3(0.18, 0.96, 0.22).normalize();
    const lensMat = new THREE.ShaderMaterial({
      uniforms: {
        time: { value: 0 },
        diskNormal: { value: V3(0, 1, 0) },
        sceneTexture: { value: null },
        sceneDepthTexture: { value: null },
        viewport: { value: new THREE.Vector2(1, 1) },
        schwarzschildUv: { value: new THREE.Vector2(1e-6, 1e-6) },
        observerDistanceRs: { value: 48 },
        tanHalfFov: { value: 0.577350269 },
        lensDepth: { value: 1 },
        // Interstellar's final Gargantua imagery used a/M = 0.6.  This value
        // keeps the recognizable lensed disk while retaining visible Kerr
        // asymmetry and frame dragging.
        spin: { value: 0.6 },
        traceSteps: { value: 112 }
      },
      vertexShader: [
        'varying vec2 vUv;',
        'void main(){',
        '  vUv = uv;',
        '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
        '}'
      ].join('\n'),
      fragmentShader: [
        'precision highp float;',
        'varying vec2 vUv;',
        'uniform float time;',
        'uniform vec3 diskNormal;',
        'uniform sampler2D sceneTexture;',
        'uniform sampler2D sceneDepthTexture;',
        'uniform vec2 viewport;',
        'uniform vec2 schwarzschildUv;',
        'uniform float observerDistanceRs;',
        'uniform float tanHalfFov;',
        'uniform float lensDepth;',
        'uniform float spin;',
        'uniform int traceSteps;',
        'const float PI = 3.141592653589793;',
        'float hash21(vec2 p){',
        '  p = fract(p * vec2(123.34, 456.21));',
        '  p += dot(p, p + 45.32);',
        '  return fract(p.x * p.y);',
        '}',
        'float noise(vec2 p){',
        '  vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);',
        '  return mix(mix(hash21(i),hash21(i+vec2(1.,0.)),f.x),',
        '             mix(hash21(i+vec2(0.,1.)),hash21(i+vec2(1.,1.)),f.x),f.y);',
        '}',
        'vec3 blackbody(float t){',
        '  t = clamp(t, 0.0, 1.6);',
        '  vec3 redHot = vec3(0.72, 0.055, 0.008);',
        '  vec3 goldHot = vec3(1.0, 0.43, 0.07);',
        '  vec3 whiteHot = vec3(1.0, 0.92, 0.76);',
        '  vec3 blueHot = vec3(0.72, 0.84, 1.0);',
        '  vec3 c = mix(redHot, goldHot, smoothstep(0.05,0.55,t));',
        '  c = mix(c, whiteHot, smoothstep(0.45,1.0,t));',
        '  return mix(c, blueHot, smoothstep(1.0,1.55,t));',
        '}',
        'void main(){',
        '  const float extent=18.0;',
        '  vec2 screenUv=gl_FragCoord.xy/max(viewport,vec2(1.0));',
        // The universe uses logarithmic depth, so compare against the captured
        // logarithmic depth texture directly.  This keeps the astronaut and
        // other true foreground geometry, while no distant star can punch a
        // hole through the shadow because of incompatible depth conventions.
        '  float foregroundDepth=texture2D(sceneDepthTexture,clamp(screenUv,0.0,1.0)).x;',
        '  if(foregroundDepth+0.00002<lensDepth) discard;',
        '  vec3 baseScene=texture2D(sceneTexture,clamp(screenUv,0.0,1.0)).rgb;',
        // Start each backwards ray at the player's actual radius when close
        // to the hole. Beyond 48 rs the remaining weak-field bend is folded
        // into the asymptotic direction, avoiding needless empty integration.
        '  vec2 impact=(vUv-0.5)*2.0*extent;',
        '  float observerR=clamp(observerDistanceRs,1.001,48.0);',
        '  vec3 p=vec3(0.0,0.0,observerR);',
        '  vec3 ray=normalize(vec3(impact,-observerR));',
        '  vec3 initialRay=ray;',
        '  float localH=length(cross(p,ray));',
        // Convert the local launch angle into the conserved impact parameter
        // measured at infinity. Schwarzschild capture occurs below
        // 3*sqrt(3)/2 rs, which is the observed shadow rather than the smaller
        // coordinate event-horizon radius.
        '  float observerLapse=sqrt(max(0.0001,1.0-1.0/observerR));',
        '  float b=localH/max(observerLapse,0.01);',
        '  float h2=b*b;',
        '  vec3 n=normalize(diskNormal);',
        // A Kerr shadow is displaced and compressed on its prograde side.
        // The projected spin tangent selects that side continuously as the
        // camera moves above, below, or around the equatorial plane.
        '  vec2 projectedSpin=n.xy;',
        '  vec2 spinTangent=length(projectedSpin)>.0001?normalize(vec2(-projectedSpin.y,projectedSpin.x)):vec2(1.0,0.0);',
        '  float spinSide=dot(impact,spinTangent)/max(length(impact),.001);',
        '  float inclination=sqrt(max(0.0,1.0-n.z*n.z));',
        '  float criticalImpact=2.598076211-spin*.31*spinSide*inclination;',
        '  float captureAA=max(0.006,0.65/max(viewport.y,1.0)/max(schwarzschildUv.y,1e-8));',
        '  if(observerR>1.5 && b<criticalImpact-captureAA){',
        '    gl_FragColor=vec4(0.0,0.0,0.0,1.0);',
        '    return;',
        '  }',
        '  float previousPlane=dot(p,n);',
        '  float minRadius=1000.0;',
        '  float opacity=0.0;',
        '  vec3 radiance=vec3(0.0);',
        '  bool captured=false;',
        '  bool escaped=false;',
        '  for(int i=0;i<132;i++){',
        '    if(i>=traceSteps)break;',
        '    float r=length(p); minRadius=min(minRadius,r);',
        '    if(r<1.0){ captured=true; break; }',
        // Adaptive midpoint integration of the Schwarzschild null-orbit
        // equation. The former normalized Euler step bled angular momentum
        // and visibly changed the shadow as the camera moved.
        '    float ds=clamp((r-1.0)*0.052,0.006,1.35);',
        '    vec3 accel0=-1.5*h2*p/max(pow(r,5.0),0.00001);',
        '    vec3 midRay=ray+accel0*(0.5*ds);',
        '    vec3 midP=p+midRay*(0.5*ds);',
        '    float midR=length(midP);',
        '    vec3 accelMid=-1.5*h2*midP/max(pow(midR,5.0),0.00001);',
        // Leading gravitomagnetic term: the spin axis drags near-hole rays in
        // the prograde direction.  The bounded term vanishes rapidly outside
        // the strong-field region and keeps the mobile integrator stable.
        '    vec3 frameDrag=spin*.088*h2*cross(n,midP)/max(pow(midR,5.0),0.0001);',
        '    accelMid+=frameDrag;',
        '    vec3 nextRay=ray+accelMid*ds;',
        '    vec3 nextP=p+midRay*ds;',
        '    float nextPlane=dot(nextP,n);',
        // Gargantua's recognizable shape comes from an optically substantial,
        // geometrically thin disk.  Detect true ray/plane crossings so the
        // disk remains continuous even when an adaptive step is wider than it.
        '    vec3 sampleP=(p+nextP)*0.5;',
        '    float crossed=1.0-step(0.0,previousPlane*nextPlane);',
        '    float planeDelta=previousPlane-nextPlane;',
        '    float crossT=clamp(previousPlane/(abs(planeDelta)<.000001?.000001:planeDelta),0.0,1.0);',
        '    vec3 crossingP=mix(p,nextP,crossT);',
        '    vec3 diskP=mix(sampleP,crossingP,crossed);',
        '    vec3 cylindrical=diskP-n*dot(diskP,n);',
        '    float rr=length(cylindrical);',
        '    float height=abs(dot(sampleP,n));',
        '    float scaleHeight=.018+rr*.0065;',
        '    float vertical=max(exp(-0.5*pow(height/scaleHeight,2.0)),crossed);',
        // For a/M=.6 the prograde ISCO is about 1.9 Schwarzschild radii.  A
        // soft outer taper avoids a hard artificial rim.
        '    float radialWindow=smoothstep(1.72,2.02,rr)*(1.0-smoothstep(12.5,17.0,rr));',
        '    if(radialWindow>0.0001 && opacity<0.985){',
        '        vec3 radial=normalize(cylindrical);',
        '        vec3 tangent=normalize(cross(n,radial));',
        '        float beta=clamp(1.0/(pow(max(rr*2.0,1.0),1.5)+spin),0.0,0.74);',
        '        beta=max(beta,sqrt(0.5/max(rr-1.0,0.22))*.68);',
        '        float gamma=1.0/sqrt(max(0.01,1.0-beta*beta));',
        '        vec3 photonToObserver=normalize(-midRay);',
        '        float doppler=1.0/(gamma*max(0.12,1.0-dot(tangent*beta,photonToObserver)));',
        '        float grav=sqrt(max(0.0,1.0-1.0/rr));',
        // Divide by the observer lapse as well as multiplying by the emitter
        // lapse: a nearby player measures the correct local frequency shift.
        '        float shift=clamp(grav*doppler/max(observerLapse,0.08),0.08,2.8);',
        '        float inflow=pow(3.0/max(rr,1.12),1.42);',
        '        float density=vertical*radialWindow*inflow;',
        '        float angle=atan(radial.y,radial.x);',
        '        float phase=angle-time*0.18/pow(max(rr,1.0),1.5);',
        // Radial structure dominates real thin disks; weak azimuthal noise
        // breaks perfect rings without producing the old artificial spokes.
        '        float broad=noise(vec2(rr*.52-time*.012,phase*.46));',
        '        float filament=noise(vec2(rr*2.25-time*.038,phase*1.15));',
        '        float turbulence=.72+.19*broad+.09*filament;',
        '        density*=turbulence;',
        '        float restTemperature=clamp(pow(inflow,.29)*.74,.22,1.08);',
        // Preserve real Doppler/gravitational colour shifts, but compress their
        // intensity contrast as the film did so both sides remain readable.
        '        float relativisticIntensity=mix(1.0,pow(shift,3.0),.42);',
        '        vec3 emission=blackbody(restTemperature*mix(1.0,shift,.58))*density*relativisticIntensity;',
        '        float opticalPath=mix(ds*1.6,2.8,crossed);',
        '        float a=clamp(1.0-exp(-density*opticalPath),0.0,.88);',
        '        radiance+=(1.0-opacity)*emission*a*4.8;',
        '        opacity+=(1.0-opacity)*a;',
        '    }',
        '    p=nextP; ray=nextRay; previousPlane=nextPlane;',
        '    if(i>28 && r>observerR*0.985 && dot(p,ray)>0.0){ escaped=true; break; }',
        '  }',
        // Reproject the ray's escaped direction into the pre-rendered scene.
        // Unlike the former procedural replacement stars, this bends the
        // actual star field, nebulae, and every other object behind Sgr A*.
        '  vec3 background=baseScene;',
        '  if(escaped && !captured){',
        // Reprojection uses the change in asymptotic ray angle. Subtracting
        // the initial slope means a zero-mass ray samples the original pixel,
        // eliminating the old rubber-sheet drift during camera motion.
        '    vec2 initialSlope=initialRay.xy/max(0.03,-initialRay.z);',
        '    vec2 finalSlope=ray.xy/max(0.03,-ray.z);',
        '    vec2 bend=finalSlope-initialSlope;',
        '    vec2 angularUv=vec2(bend.x/max(viewport.x/viewport.y,0.001),bend.y)/(2.0*max(tanHalfFov,0.001));',
        '    vec2 lensedUv=screenUv-angularUv;',
        '    lensedUv=clamp(lensedUv,0.0,1.0);',
        '    float sourceDepth=texture2D(sceneDepthTexture,lensedUv).x;',
        '    background=sourceDepth+0.00002<lensDepth?baseScene:texture2D(sceneTexture,lensedUv).rgb;',
        '  }',
        // The photon ring is not a luminous object. Only boost light that the
        // ray actually collected from the flow while lingering near the
        // critical curve; higher-order images come from repeated integration.
        '  float photonPath=exp(-abs(b-criticalImpact)*46.0)*smoothstep(0.002,0.18,opacity);',
        '  radiance*=1.0+photonPath*1.35;',
        '  vec3 color=(vec3(1.0)-exp(-radiance))+(1.0-opacity)*background;',
        '  float captureMask=1.0-smoothstep(criticalImpact-captureAA,criticalImpact+captureAA,b);',
        '  color=mix(color,vec3(0.0),captureMask);',
        '  float edgeAlpha=1.0-smoothstep(13.5,16.0,b);',
        '  float physicalRegion=max(opacity,max(photonPath,captureMask));',
        '  edgeAlpha=max(edgeAlpha,physicalRegion);',
        '  if(edgeAlpha<0.01) discard;',
        '  gl_FragColor=vec4(clamp(color,0.0,1.0),clamp(edgeAlpha,0.0,1.0));',
        '}'
      ].join('\n'),
      transparent: true,
      depthWrite: true,
      depthTest: false,
      side: THREE.DoubleSide
    });
    // A circular tracing surface guarantees that the finite lens pass can
    // never reveal the corners of a rectangular full-screen quad against the
    // deep sky, even at extreme intergalactic viewing distances.
    const lens = new THREE.Mesh(new THREE.CircleGeometry(1,128),lensMat);
    lens.scale.set(blackhole.r*36,blackhole.r*36,1);
    lens.frustumCulled=false;
    // Draw after the game's transparent star layers so captured rays remain
    // truly black while the shader supplies their lensed replacement outside.
    lens.renderOrder=9999;
    track(lens,blackhole.center);
    blackhole.lensingMesh=lens;
    blackhole.lensingMaterial=lensMat;
    blackhole.captureTarget=null;
    blackhole.captureSize=new THREE.Vector2();
    blackhole.viewportSize=new THREE.Vector2();
    blackhole.schwarzschildUv=new THREE.Vector2();
    blackhole.viewVector=new THREE.Vector3();
    blackhole.projectedCenter=new THREE.Vector3();
    blackhole.passActive=false;
    blackhole.effectRadiusPx=0;
    blackhole.captureReady=false;
    blackhole.lastCaptureTime=-Infinity;
  })();

  // Searchable stellar atlas. These real named stars are rendered in a single
  // GPU point batch and stay outside the gravity/landing loops. Distances are
  // in light-years; RA/Dec places them in the correct part of the sky.
  const catalogStars = [];
  const catalogOrigin = new THREE.Vector3();
  (function buildStellarAtlas() {
    const data = [
      ['Wolf 359',7.86,10.94,7.0,0xff9a78],['Lalande 21185',8.31,11.05,35.97,0xffb18a],
      ['Luyten 726-8',8.73,1.65,-17.95,0xff856f],['Ross 154',9.69,18.83,-23.84,0xff8b70],
      ['Ross 248',10.32,23.70,44.18,0xff9b78],['Epsilon Eridani',10.48,3.55,-9.46,0xffc27d],
      ['Lacaille 9352',10.72,23.10,-35.85,0xffa07f],['Ross 128',11.01,11.79,0.80,0xff9776],
      ['EZ Aquarii',11.11,22.65,-15.30,0xff8b71],['Procyon',11.46,7.66,5.23,0xfff3db],
      ['61 Cygni',11.40,21.12,38.75,0xffbb76],['Struve 2398',11.52,18.71,59.63,0xff9978],
      ['Groombridge 34',11.62,0.31,43.79,0xff9877],['Epsilon Indi',11.87,22.06,-56.79,0xffa97b],
      ['Tau Ceti',11.91,1.73,-15.94,0xffd99e],['Luyten’s Star',12.36,7.45,5.23,0xff9674],
      ['Teegarden’s Star',12.50,2.89,16.88,0xff7f6d],['Kapteyn’s Star',12.83,5.19,-45.02,0xff8c70],
      ['Altair',16.73,19.85,8.87,0xf4f5ff],['Fomalhaut',25.13,22.96,-29.62,0xf3f5ff],
      ['Vega',25.04,18.62,38.78,0xdde8ff],['Pollux',33.78,7.76,28.03,0xffc27e],
      ['Arcturus',36.70,14.26,19.18,0xffa553],['Capella',42.92,5.28,46.00,0xffd38d],
      ['Aldebaran',65.3,4.60,16.51,0xffa05c],['Regulus',79.3,10.14,11.97,0xdde8ff],
      ['Spica',250,13.42,-11.16,0xc9dcff],['Polaris',447,2.53,89.26,0xffe5b3],
      ['Antares',550,16.49,-26.43,0xff7048],['Betelgeuse',548,5.92,7.41,0xff7b4c],
      ['Canopus',310,6.40,-52.70,0xffe5c4],['Rigel',860,5.24,-8.20,0xc5d9ff],
      ['Deneb',2615,20.69,45.28,0xe0eaff],['Alnilam',2000,5.60,-1.20,0xc8ddff],
      ['Alnitak',1260,5.68,-1.94,0xc7dcff],['Mintaka',1200,5.53,-0.30,0xd6e4ff]
    ];
    const positions = new Float32Array(data.length * 3);
    const colors = new Float32Array(data.length * 3);
    for (let i = 0; i < data.length; i++) {
      const d = data[i], ra = d[2] * Math.PI / 12, dec = d[3] * Math.PI / 180;
      const center = V3(Math.cos(dec)*Math.cos(ra), Math.sin(dec), Math.cos(dec)*Math.sin(ra)).multiplyScalar(d[1] * LYS);
      const c = new THREE.Color(d[4]);
      positions.set([center.x,center.y,center.z],i*3); colors.set([c.r,c.g,c.b],i*3);
      catalogStars.push({ name:d[0], r:6.96e7, center:center, isStar:true, catalogOnly:true, distanceLy:d[1] });
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position',new THREE.BufferAttribute(positions,3));
    geometry.setAttribute('color',new THREE.BufferAttribute(colors,3));
    const material = new THREE.PointsMaterial({ size:2.4, sizeAttenuation:false, vertexColors:true, transparent:true, opacity:0.92 });
    starMats.push(material);
    const points = new THREE.Points(geometry,material);
    points.frustumCulled=false;
    track(points,catalogOrigin);
    starLayers.push(points);
  })();

  // ---------- Procedural deep sky ----------
  // These are true 3D volumes and point distributions at real sky positions
  // and distances. No photographic nebula textures or camera-facing cards.
  const deepSkyRenderer=new window.GodmanDeepSkyRenderer(THREE),deepSkyObjects=[];
  let deepSkyVisibility=0;
  // A single GPU batch supplies a sparse extragalactic background. It follows
  // the observer position, so deep space continues naturally without a visible
  // rectangular wall or a reachable end-of-universe shell.
  const cosmicBackdrop=deepSkyRenderer.createCosmicBackdrop({count:900000,radius:5e22,seed:0x5a17c9e3});
  scene.add(cosmicBackdrop);
  function deepSkyPosition(raDeg,decDeg,distanceLy){
    const ra=raDeg*Math.PI/180,dec=decDeg*Math.PI/180;
    return V3(Math.cos(dec)*Math.cos(ra),Math.sin(dec),Math.cos(dec)*Math.sin(ra)).multiplyScalar(distanceLy*LYS);
  }
  function addNebula(spec){
    spec.center=deepSkyPosition(spec.ra,spec.dec,spec.distanceLy);spec.radius*=LYS;
    const body=deepSkyRenderer.createNebula(spec,track);deepSkyObjects.push(body);return body;
  }
  function addStarCluster(spec){
    spec.center=deepSkyPosition(spec.ra,spec.dec,spec.distanceLy);spec.radius*=LYS;
    const body=deepSkyRenderer.createCluster(spec,track);deepSkyObjects.push(body);return body;
  }
  function addGalaxy(spec){
    if(spec.planetsPerStar==null)spec.planetsPerStar=3;
    if(!spec.estimatedStars)spec.estimatedStars=Math.round((2e9+Math.pow(spec.radius/52000,2)*7.5e10)/1e8)*1e8;
    spec.center=deepSkyPosition(spec.ra,spec.dec,spec.distanceLy);spec.radius*=LYS;
    const body=deepSkyRenderer.createGalaxy(spec,track);deepSkyObjects.push(body);return body;
  }
  addNebula({name:'Orion Nebula',aliases:['M42','NGC 1976','stellar nursery'],ra:83.8208,dec:-5.3911,distanceLy:1500,radius:6.5,
    colorA:0xd64b42,colorB:0x79bfff,dustColor:0x09070c,seed:11.2,mode:0,source:'NASA Hubble'});
  addNebula({name:'Carina Nebula',aliases:['NGC 3372','Eta Carinae Nebula','stellar nursery'],ra:161.0,dec:-59.8833,distanceLy:7500,radius:150,
    colorA:0xc84235,colorB:0x6ca9ff,dustColor:0x080609,seed:27.8,mode:0,source:'NASA Hubble'});
  addNebula({name:'Lagoon Nebula',aliases:['M8','Messier 8','emission nebula'],ra:270.904,dec:-24.386,distanceLy:5200,radius:55,
    colorA:0xe15b60,colorB:0x73a9ff,dustColor:0x09070b,seed:42.5,mode:0,source:'NASA Hubble'});
  addNebula({name:'Eagle Nebula',aliases:['M16','Messier 16','Pillars of Creation'],ra:274.7,dec:-13.8067,distanceLy:7000,radius:35,
    colorA:0xb46c43,colorB:0x69b6a8,dustColor:0x070806,seed:63.1,mode:0,source:'NASA Hubble'});
  addNebula({name:'Crab Nebula',aliases:['M1','Messier 1','supernova remnant','pulsar'],ra:83.6331,dec:22.0145,distanceLy:6500,radius:3,
    bodyType:'SUPERNOVA REMNANT',colorA:0xea6943,colorB:0x75bfff,dustColor:0x08060a,seed:88.4,mode:2,source:'NASA Hubble'});
  addNebula({name:'Helix Nebula',aliases:['NGC 7293','planetary nebula','dying star'],ra:337.4106,dec:-20.8372,distanceLy:650,radius:1.5,
    bodyType:'PLANETARY NEBULA',colorA:0xe55b47,colorB:0x53c9c4,dustColor:0x06090a,seed:105.7,mode:1,source:'NASA Hubble'});
  addStarCluster({name:'Pleiades',aliases:['M45','Seven Sisters','open cluster'],ra:56.75,dec:24.1167,distanceLy:445,radius:6,
    bodyType:'OPEN STAR CLUSTER',count:1000,seed:145,warm:0xffd2b0,cool:0xaacfff,source:'NASA Hubble'});
  addStarCluster({name:'Omega Centauri',aliases:['NGC 5139','Caldwell 80','globular cluster'],ra:201.7065,dec:-47.4924,distanceLy:17700,radius:75,
    bodyType:'GLOBULAR CLUSTER',count:1800,seed:5139,warm:0xffb68d,cool:0xc9dcff,globular:true,source:'NASA Hubble'});

  // ===== THE MILKY WAY — the Solar System begins inside this structure =====
  // Current estimates span roughly 100–400 billion physical stars. Rendering
  // every one is neither visible nor practical, so 12 million deterministic
  // stellar samples reproduce the disk, bar, bulge, arms, dust and thickness.
  // A 1.35m resident subset is used from within the disk; a denser population
  // streams only after the player leaves far enough to see the whole silhouette.
  const milkyToSun=blackhole.center.clone().multiplyScalar(-1).normalize();
  const milkyNormal=new THREE.Vector3(0,1,0).cross(milkyToSun).normalize();
  // Local +X is the measured Galactic-centre-to-Sun line and local +Y is the
  // disk normal. This fixes the bar's observed angle relative to the Sun.
  const milkySide=new THREE.Vector3().crossVectors(milkyToSun,milkyNormal).normalize();
  const milkyQuaternion=new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(milkyToSun,milkyNormal,milkySide));
  // The former transparent galactic-veil sphere was divided into visible
  // low-poly facets at extreme distance. Those facets were the large squares
  // seen at the apparent universe boundary. The Milky Way is now composed
  // entirely of independent stellar points, with no far-distance surface or
  // mesh capable of drawing rectangular patches behind them.
  // Do not wrap the observer in a separate Milky Way sky shell. Even with a
  // camera-aware fade, that finite overlay could reveal dense patches during
  // extreme C-view zoom. The navigable physical galaxy below and the uniform
  // camera-centred cosmic backdrop now provide the entire stellar sky.
  const MILKY_SAMPLE_COUNT=12000000;
  const milkyWay=deepSkyRenderer.createGalaxy({
    name:'Milky Way Galaxy',aliases:['Milky Way','our galaxy','home galaxy'],center:blackhole.center.clone(),
    distanceLy:26670,radius:52000*LYS,bodyType:'BARRED SPIRAL GALAXY',count:MILKY_SAMPLE_COUNT,
    initialCount:120000,residentCount:1350000,capacityLimit:2600000,estimatedStars:200000000000,planetsPerStar:5.5,homeGalaxy:true,
    arms:4,twist:6.15,thickness:.012,ellipticity:1,bulgeFraction:.14,bulgeHeight:.34,barStrength:.9,seed:1001,
    haloFraction:.03,barLength:.314,barAngle:29*Math.PI/180,diskScale:.15,thinScaleHeight:.0176,thickScaleHeight:.0535,
    quaternion:milkyQuaternion,core:0xe58d43,arm:0x5f8fe0,dust:0x351b22,source:'NASA / ESA estimate'
  },track);
  deepSkyObjects.push(milkyWay);

  // ===== REAL GALAXIES at their true distances =====
  // Each galaxy is a navigable 3D stellar distribution with spiral structure,
  // a central bulge, dust lanes and measurable thickness—not a billboard.
  addGalaxy({name:'Large Magellanic Cloud',aliases:['LMC','Milky Way satellite galaxy'],ra:80.8942,dec:-69.7561,distanceLy:163000,radius:7000,
    bodyType:'IRREGULAR GALAXY',count:420000,arms:3,twist:2.3,thickness:.12,ellipticity:.78,bulgeFraction:.08,seed:163,rotationX:.58,rotationZ:-.31,core:0xffc59d,arm:0x9fc8ff,source:'NASA'});
  addGalaxy({name:'Small Magellanic Cloud',aliases:['SMC','Milky Way satellite galaxy'],ra:13.1583,dec:-72.8003,distanceLy:200000,radius:3500,
    bodyType:'DWARF GALAXY',count:250000,arms:2,twist:1.7,thickness:.18,ellipticity:.62,bulgeFraction:.12,seed:200,rotationX:-.42,rotationZ:.73,core:0xffcfaa,arm:0x9dbfff,source:'NASA'});
  addGalaxy({name:'Andromeda Galaxy',aliases:['M31','Messier 31','NGC 224','nearest major galaxy'],ra:10.6847,dec:41.269,distanceLy:2500000,radius:130000,
    count:900000,arms:4,twist:6.2,thickness:.026,ellipticity:.9,bulgeFraction:.25,seed:31,rotationX:1.34,rotationZ:.66,core:0xffd3a0,arm:0xa9c9ff,source:'NASA Hubble'});
  addGalaxy({name:'Triangulum Galaxy',aliases:['M33','Messier 33','NGC 598'],ra:23.4621,dec:30.6602,distanceLy:3000000,radius:30000,
    count:650000,arms:3,twist:7.1,thickness:.035,ellipticity:.96,bulgeFraction:.1,seed:33,rotationX:.94,rotationZ:.4,core:0xffc58d,arm:0x8fc4ff,source:'NASA Hubble'});
  addGalaxy({name:'Sculptor Galaxy',aliases:['NGC 253','Silver Coin Galaxy'],ra:11.888,dec:-25.2882,distanceLy:11400000,radius:45000,
    count:480000,arms:4,twist:6.8,thickness:.03,ellipticity:.88,bulgeFraction:.2,seed:253,rotationX:1.22,rotationZ:-.28,core:0xffc98e,arm:0x9fc1e8,source:'NASA'});
  addGalaxy({name:"Bode's Galaxy",aliases:['M81','Messier 81','NGC 3031'],ra:148.8882,dec:69.0653,distanceLy:12000000,radius:45000,
    count:500000,arms:3,twist:6.4,thickness:.027,ellipticity:.92,bulgeFraction:.24,seed:81,rotationX:1.03,rotationZ:.5,core:0xffd0a0,arm:0xa9c7ef,source:'NASA Hubble'});

  // Ninety-three additional galaxies bring the navigable total to 100. They
  // follow filament-like sightlines and logarithmic distance layers instead of
  // occupying a spherical boundary. Each contains a deterministic million-
  // scale stellar catalogue but begins with a 512-point distant LOD.
  (function buildDeepFieldGalaxies(){
    let state=0x6d2b79f5;
    const random=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};
    const filamentDirections=[];
    for(let f=0;f<12;f++){
      const ra=(f*137.507764+random()*18)%360;
      const dec=Math.asin(random()*1.7-.85)*180/Math.PI;
      filamentDirections.push([ra,dec]);
    }
    const kinds=['SPIRAL GALAXY','BARRED SPIRAL GALAXY','ELLIPTICAL GALAXY','DWARF GALAXY'];
    for(let i=0;i<93;i++){
      const filament=i%filamentDirections.length,layer=Math.floor(i/filamentDirections.length);
      const base=filamentDirections[filament];
      const ra=(base[0]+(random()-.5)*(7+layer*1.8)+360)%360;
      const dec=Math.max(-84,Math.min(84,base[1]+(random()-.5)*(5+layer*1.5)));
      const distanceLy=1.6e7*Math.pow(2.08,layer)*(0.82+random()*.36);
      const radius=7000+Math.pow(random(),.58)*125000;
      const estimatedStars=Math.round((2e9+Math.pow(radius/52000,2)*7.5e10)/1e8)*1e8;
      const samples=Math.round(140000+random()*860000);
      const kind=kinds[Math.min(kinds.length-1,Math.floor(random()*kinds.length))];
      addGalaxy({name:'Deep Field G-'+String(i+1).padStart(3,'0'),aliases:['GDF-'+String(i+1).padStart(3,'0'),'deep field galaxy'],
        ra:ra,dec:dec,distanceLy:distanceLy,radius:radius,bodyType:kind,count:samples,initialCount:512,
        estimatedStars:estimatedStars,planetsPerStar:3,arms:kind==='ELLIPTICAL GALAXY'?2:2+Math.floor(random()*4),
        twist:kind==='ELLIPTICAL GALAXY'?1.2:4.8+random()*3.4,thickness:kind==='DWARF GALAXY'?.11:.018+random()*.035,
        ellipticity:kind==='ELLIPTICAL GALAXY'?.62+random()*.24:.86+random()*.13,
        bulgeFraction:kind==='ELLIPTICAL GALAXY'?.58:.08+random()*.24,bulgeHeight:kind==='ELLIPTICAL GALAXY'?.82:.42,
        barStrength:kind==='BARRED SPIRAL GALAXY'?.72:0,
        seed:1700+i*31,rotationX:random()*Math.PI,rotationY:random()*Math.PI,rotationZ:random()*Math.PI,
        core:random()>.45?0xffc893:0xffe0bd,arm:random()>.45?0x9fc5ff:0xc1d3ff,dust:0x443b43,
        source:'Procedural cosmological catalogue'});
    }
  })();

  // Every sampled Milky Way star has a stable numbered identity.  A single
  // eight-world mesh pool is expanded only near the selected/nearest sample;
  // far away, those meshes leave the scene, physics and finder entirely.
  const streamedSystemCenter=V3(.31,.18,-.93).normalize().multiplyScalar(18*LYS);
  const streamedStar=addStar({name:'MW-00000001',bodyType:'NUMBERED MILKY WAY STAR',r:5.8e7,g:250,
    center:streamedSystemCenter,tex:sun.tex,temperature:5450,luminosity:.72,
    glowInner:'rgba(255,235,190,1)',glowMid:'rgba(255,165,80,.38)'});
  streamedStar.searchAliases=['generated star','numbered star','milky way sample','procedural system'];
  streamedStar.archiveData={source:'Milky Way deterministic stellar catalogue',planets:'3–8 when approached'};
  const streamedPalette=[
    rocky('#6d5548',['#8b6b58','#433a37','#a17c62'],26,null,32),
    rocky('#536c69',['#76918a','#304a48','#9aa99d'],34,null,36),
    rocky('#836b4d',['#b59769','#4d4038','#c2a576'],31,null,34),
    banded(['#93836c','#665c52','#b3a087','#514b48'],null),
    rocky('#625c70',['#8a8298','#393442','#aaa1b8'],29,null,34),
    banded(['#8b704f','#c59a63','#584634','#e0bd86'],null),
    rocky('#596b76',['#7e96a2','#34444e','#a7b5bc'],36,null,36),
    banded(['#756579','#a68baa','#4c414f','#c0a8bd'],null)
  ];
  const streamedPlanets=[];
  for(let i=0;i<8;i++){
    const planet=addPlanet({name:'MW-00000001 '+String.fromCharCode(98+i),bodyType:'STREAMED PROCEDURAL PLANET',
      r:RE,g:9.2,center:orbitPos(streamedStar.center,(.28+i*.38)*AU,i*47,2+i*.7),tex:streamedPalette[i],
      bump:i!==3&&i!==5,props:i===3||i===5?'giant':'rocky',propColor:0x74685c});
    planet.searchAliases=['generated planet','procedural planet','streamed planet'];
    streamedPlanets.push(planet);
  }
  setMotion(streamedStar,620);
  for(let i=0;i<streamedPlanets.length;i++)setMotion(streamedPlanets[i],18+i*3,streamedStar,80+i*150,(.28+i*.38)*AU,i*47,2+i*.7);
  const streamedOrbitMaterial=new THREE.LineBasicMaterial({color:0x526783,transparent:true,opacity:.34,depthWrite:false});
  function refreshStreamedOrbitLine(planet){
    const pts=[],R=planet.orbit.R,inc=planet.orbit.inc;
    for(let j=0;j<160;j++){
      const a=j/160*Math.PI*2;
      pts.push(V3(R*Math.cos(a),R*Math.sin(a)*Math.sin(inc),R*Math.sin(a)*Math.cos(inc)));
    }
    const old=planet.streamedOrbitLine.geometry;
    planet.streamedOrbitLine.geometry=new THREE.BufferGeometry().setFromPoints(pts);
    if(old)old.dispose();
  }
  for(const planet of streamedPlanets){
    const line=new THREE.LineLoop(new THREE.BufferGeometry(),streamedOrbitMaterial);
    line.userData.universeOrbitGuide=true;line.visible=!universeAnnotationsHidden;orbitGuides.push(line);
    line.frustumCulled=true;planet.streamedOrbitLine=line;refreshStreamedOrbitLine(planet);track(line,streamedStar.center);
  }
  const milkyInverseQuaternion=milkyQuaternion.clone().invert();
  const streamedLocal=new THREE.Vector3(),streamedCandidate=new THREE.Vector3(),streamedBest=new THREE.Vector3();
  let streamedCellKey='initial',streamedLastCheck=-99,streamedConfiguredKey='',streamedPlanetCount=0;
  function cellHash(x,y,z,salt){
    let n=(Math.imul(x,73856093)^Math.imul(y,19349663)^Math.imul(z,83492791)^Math.imul(salt||1,2654435761))|0;
    n=Math.imul(n^(n>>>15),2246822519);n=Math.imul(n^(n>>>13),3266489917);return ((n^(n>>>16))>>>0)/4294967296;
  }
  function setStreamedPlanetActive(planet,active){
    if(active===planet.streamedActive)return;
    if(active){
      planets.push(planet);
      for(const entry of planet.streamedRenderEntries){renderObjs.push(entry);scene.add(entry.o);}
      labels.push(planet.labelEntry);planet.streamedActive=true;
    }else{
      planet.streamedRenderEntries=[];
      for(let i=renderObjs.length-1;i>=0;i--)if(renderObjs[i].w===planet.center||renderObjs[i].o===planet.labelEntry.spr||renderObjs[i].o===planet.streamedOrbitLine){
        planet.streamedRenderEntries.push(renderObjs[i]);scene.remove(renderObjs[i].o);renderObjs.splice(i,1);
      }
      for(let i=labels.length-1;i>=0;i--)if(labels[i].body===planet)labels.splice(i,1);
      const index=planets.indexOf(planet);if(index>=0)planets.splice(index,1);
      planet.streamedActive=false;
    }
  }
  for(const planet of streamedPlanets){planet.streamedActive=true;planet.streamedRenderEntries=[];setStreamedPlanetActive(planet,false);}
  function configureStreamedPlanets(systemNumber,key){
    const a=systemNumber|0,b=(systemNumber*31)|0,c=(systemNumber*131)|0;
    streamedPlanetCount=3+Math.floor(cellHash(a,b,c,101)*6);
    for(let i=0;i<streamedPlanets.length;i++){
      const planet=streamedPlanets[i],active=i<streamedPlanetCount;
      if(!active){setStreamedPlanetActive(planet,false);continue;}
      const giant=cellHash(a,b,c,130+i)>.72;
      const radiusEarth=giant?4.2+cellHash(a,b,c,150+i)*8.4:.38+Math.pow(cellHash(a,b,c,160+i),.72)*2.25;
      const orbitAu=.24+i*.43+cellHash(a,b,c,180+i)*.22;
      const angle=cellHash(a,b,c,210+i)*Math.PI*2,inc=(cellHash(a,b,c,240+i)-.5)*.18;
      planet.r=radiusEarth*RE;planet.g=(giant?13:5.5)+cellHash(a,b,c,270+i)*12;
      planet.soi=planet.r*7;planet.mesh.scale.setScalar(radiusEarth);
      planet.mesh.material.color.setHSL(cellHash(a,b,c,300+i),.18+.38*cellHash(a,b,c,320+i),.62+.2*cellHash(a,b,c,340+i));
      planet.name=streamedStar.name+' '+String.fromCharCode(98+i);planet.labelEntry.r=planet.r;
      planet.orbit.R=orbitAu*AU;planet.orbit.ang=angle;planet.orbit.inc=inc;
      planet.orbit.w=Math.PI*2/((70+Math.pow(orbitAu,1.5)*365)*DAY);
      refreshStreamedOrbitLine(planet);
      // Place the initial frame with the same radian-space equation used by
      // the orbit update below. The former degree conversion multiplied the
      // inclination by PI and made planets jump when their first frame ran.
      planet.center.set(
        streamedStar.center.x+planet.orbit.R*Math.cos(angle),
        streamedStar.center.y+planet.orbit.R*Math.sin(angle)*Math.sin(inc),
        streamedStar.center.z+planet.orbit.R*Math.sin(angle)*Math.cos(inc));
      planet.prevCenter.copy(planet.center);
      planet.archiveData={source:'Deterministic on-approach generation',host:streamedStar.name,system:key,index:i+1};
      planet.labelEntry.w.copy(planet.center).addScaledVector(planet.spinAxis,planet.r*1.8);
      setStreamedPlanetActive(planet,true);
    }
    streamedStar.archiveData={source:'Milky Way deterministic stellar catalogue',planets:streamedPlanetCount,system:key};
    streamedConfiguredKey=key;
    toast(streamedPlanetCount+'-planet system resolved around '+streamedStar.name);
  }
  function unloadStreamedPlanets(){
    if(streamedPlanets.includes(target)){
      target=null;document.getElementById('targetBanner').style.display='none';
    }
    for(const planet of streamedPlanets)setStreamedPlanetActive(planet,false);
    streamedPlanetCount=0;streamedConfiguredKey='';
  }
  function setStreamedStarLocation(center,name,systemNumber,key){
    unloadStreamedPlanets();streamedCellKey=key;
    streamedStar.center.copy(center);streamedStar.prevCenter.copy(center);streamedStar.name=name;
    streamedStar.archiveData={source:'Milky Way deterministic stellar catalogue',planets:'3–8 when approached',system:key};
    if(streamedStar.labelEntry)streamedStar.labelEntry.w.copy(streamedStar.center).addScaledVector(streamedStar.spinAxis,streamedStar.r*1.8);
    streamedStar.streamedSystemNumber=systemNumber;
  }
  // CPU twin of the Milky Way vertex shader.  It lets the finder turn a GPU
  // point id into an exact navigable location without creating an object for
  // every one of the 12 million addressable samples.
  function milkySamplePosition(sampleId,out){
    const fract=n=>n-Math.floor(n),seed=1001;
    const mix32=value=>{let x=value>>>0;x=Math.imul(x^(x>>>16),0x7feb352d);x=Math.imul(x^(x>>>15),0x846ca68b);return (x^(x>>>16))>>>0;};
    const id=Math.max(1,Math.min(MILKY_SAMPLE_COUNT,sampleId|0)),salts=[0x9e3779b9,0x243f6a88,0xb7e15162,0xdeadbeef];
    const randomSeed=salts.map(s=>(mix32(id^s)&0xffff)/65535);
    const h=salt=>{
      let x=fract(randomSeed[0]+salt*.1031+seed*.0013),y=fract(randomSeed[1]+salt*.11369+seed*.0017);
      let z=fract(randomSeed[2]+salt*.13787+seed*.0019),w=fract(randomSeed[3]+salt*.09987+seed*.0023);
      const d=x*(w+33.33)+y*(z+33.33)+z*(x+33.33)+w*(y+33.33);x+=d;y+=d;z+=d;w+=d;
      return fract((x+y)*(z+w));
    };
    const bell=n=>h(n)+h(n+17.7)+h(n+39.1)+h(n+91.3)-2;
    const smooth=(a,b,x)=>{x=Math.max(0,Math.min(1,(x-a)/(b-a)));return x*x*(3-2*x);};
    let x,y,z,radial;const selector=h(.731);
    if(selector<.03){
      const haloU=Math.max(.018,1-h(2.1));radial=Math.min(1.42,.115*Math.pow(haloU,-1.25));
      const az=h(5.3)*Math.PI*2,cy=h(8.7)*2-1,sy=Math.sqrt(Math.max(0,1-cy*cy));
      x=Math.cos(az)*sy*radial;y=cy*.68*radial;z=Math.sin(az)*sy*radial;
    }else if(selector<.14){
      radial=Math.pow(h(2.1),2.45)*.36;const az=h(5.3)*Math.PI*2,cy=h(8.7)*2-1,sy=Math.sqrt(Math.max(0,1-cy*cy));
      const barRadius=Math.pow(h(21),1.72),barAz=h(24)*Math.PI*2,barCy=h(27)*2-1,barSy=Math.sqrt(Math.max(0,1-barCy*barCy));
      const rawX=Math.cos(barAz)*barSy*.314*barRadius,peanut=.032+.046*Math.pow(Math.abs(rawX)/.314,.72);
      const rawY=barCy*peanut*barRadius,rawZ=Math.sin(barAz)*barSy*.314*.27*barRadius;
      const angle=29*Math.PI/180,ca=Math.cos(angle),sa=Math.sin(angle),bx=ca*rawX-sa*rawZ,by=rawY,bz=sa*rawX+ca*rawZ;
      const mix=.9*(.4+.6*(1-barRadius));
      x=Math.cos(az)*sy*radial*(1-mix)+bx*mix;y=cy*.34*radial*(1-mix)+by*mix;z=Math.sin(az)*sy*radial*(1-mix)+bz*mix;
    }else{
      const lane=Math.floor(h(4.8)*4),localArm=h(421)>=.935;
      let diffuse=smooth(.69,.985,h(61));
      radial=-Math.log(Math.max(1e-5,h(2.1)*h(3.7)))*.15;
      if(h(503)>=.86)radial=.38+Math.pow(h(509),.78)*.77;
      radial=Math.min(radial,1.18);
      const pitches=[.2234,.2025,.2356,.1885],phases=[.17,1.71,3.34,4.92];
      let armTheta=phases[lane]-Math.log(Math.max(.055,radial)/.5)/Math.tan(pitches[lane])+bell(8)*(.018+.022/Math.max(.13,radial));
      if(localArm){radial=.385+Math.pow(h(427),.82)*.285;armTheta=-Math.log(radial/.513)/Math.tan(.2025)+bell(433)*.045;diffuse=0;}
      const theta=armTheta*(1-diffuse)+(h(67)*Math.PI*2)*diffuse;
      const thick=h(193)>=.875,scale=thick?.0535:.0176;
      const flare=1+Math.pow(Math.max(0,(radial-.48)/.62),1.45)*(thick?3:1.55);
      const vertical=(h(197)<.5?-1:1)*(-Math.log(Math.max(.002,h(19))))*scale*flare;
      const warp=Math.pow(Math.max(0,(radial-.52)/.58),1.55)*.044*Math.sin(theta-.38);
      x=Math.cos(theta)*radial;y=vertical+warp;z=Math.sin(theta)*radial;
    }
    return out.set(x,y,z).multiplyScalar(milkyWay.r).applyQuaternion(milkyQuaternion).add(milkyWay.center);
  }
  function materializeMilkySample(sampleId){
    sampleId=Math.max(1,Math.min(MILKY_SAMPLE_COUNT,sampleId|0));
    const name='MW-'+String(sampleId).padStart(8,'0'),center=milkySamplePosition(sampleId,new THREE.Vector3());
    setStreamedStarLocation(center,name,sampleId,'sample:'+sampleId);return streamedStar;
  }
  function updateStreamedMilkySystem(now){
    const distanceToStream=pos.distanceTo(streamedStar.center);
    const approachInterval=(target===streamedStar||distanceToStream<50*AU)?.12:1.25;
    if(now-streamedLastCheck<approachInterval)return;streamedLastCheck=now;
    const planetLocked=streamedPlanets.includes(target);
    if((distanceToStream<=10*AU||planetLocked)&&!streamedConfiguredKey)
      configureStreamedPlanets(streamedStar.streamedSystemNumber||1,streamedCellKey);
    else if(distanceToStream>=20*AU&&streamedConfiguredKey)unloadStreamedPlanets();
    if(target===streamedStar||planetLocked||distanceToStream<80*LYS)return;
    streamedLocal.copy(pos).sub(milkyWay.center).applyQuaternion(milkyInverseQuaternion);
    const galaxyRadius=milkyWay.r,radial=Math.hypot(streamedLocal.x,streamedLocal.z)/galaxyRadius;
    if(radial>1.03||Math.abs(streamedLocal.y)>galaxyRadius*.055)return;
    const cellSize=24*LYS,cx=Math.floor(streamedLocal.x/cellSize),cy=Math.floor(streamedLocal.y/cellSize),cz=Math.floor(streamedLocal.z/cellSize);
    let bestDistance=Infinity,bx=0,by=0,bz=0,found=false;
    for(let x=cx-2;x<=cx+2;x++)for(let y=cy-2;y<=cy+2;y++)for(let z=cz-2;z<=cz+2;z++){
      const occupancy=.2+.34*Math.max(0,1-radial);
      if(cellHash(x,y,z,7)>occupancy)continue;
      streamedCandidate.set((x+cellHash(x,y,z,11))*cellSize,(y+cellHash(x,y,z,13))*cellSize,(z+cellHash(x,y,z,17))*cellSize);
      const rr=Math.hypot(streamedCandidate.x,streamedCandidate.z)/galaxyRadius;
      const halfThickness=galaxyRadius*(.008+.012*Math.max(0,1-rr));
      if(rr>1||Math.abs(streamedCandidate.y)>halfThickness)continue;
      const distance=streamedCandidate.distanceToSquared(streamedLocal);
      if(distance<bestDistance){bestDistance=distance;streamedBest.copy(streamedCandidate);bx=x;by=y;bz=z;found=true;}
    }
    if(!found)return;
    const key=bx+':'+by+':'+bz;if(key===streamedCellKey)return;streamedCellKey=key;
    const systemNumber=(Math.abs(Math.imul(bx,961748927)^Math.imul(by,982451653)^Math.imul(bz,776531419))%999999)+1;
    const systemName='MW-'+String(systemNumber).padStart(8,'0');
    streamedBest.applyQuaternion(milkyQuaternion).add(milkyWay.center);
    setStreamedStarLocation(streamedBest,systemName,systemNumber,key);
  }

  // ---------- Real NASA-derived textures (async, graceful fallback) ----------
  function installEarthNight(texture) {
    texture.encoding = THREE.sRGBEncoding;
    texture.wrapS = THREE.RepeatWrapping;
    texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    if (!earth.nightMesh) {
      const mat = new THREE.ShaderMaterial({
        uniforms: { cityMap:{value:texture}, sunDirection:{value:new THREE.Vector3(-1,0,0)}, intensity:{value:0.9} },
        vertexShader: '#include <common>\n#include <logdepthbuf_pars_vertex>\nvarying vec3 vNormal; varying vec2 vUvNight;\nvoid main(){ vNormal=normalize(mat3(modelMatrix)*normal); vUvNight=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);\n#include <logdepthbuf_vertex>\n}',
        fragmentShader: '#include <common>\n#include <logdepthbuf_pars_fragment>\nuniform sampler2D cityMap; uniform vec3 sunDirection; uniform float intensity; varying vec3 vNormal; varying vec2 vUvNight;\nvoid main(){\n#include <logdepthbuf_fragment>\nvec3 n=normalize(vNormal); float night=smoothstep(0.18,-0.28,dot(n,normalize(sunDirection))); vec3 city=texture2D(cityMap,vUvNight).rgb; float a=max(city.r,max(city.g,city.b))*night*intensity; if(a<0.008) discard; gl_FragColor=vec4(city*night*intensity,a);}',
        transparent:true, blending:THREE.AdditiveBlending, depthWrite:false
      });
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(earth.r*1.003,80,52),mat);
      mesh.renderOrder=2;
      track(mesh,earth.center);
      earth.nightMesh=mesh; earth.nightMat=mat;
    } else {
      earth.nightMat.uniforms.cityMap.value=texture;
    }
  }
  function tryRealTexture(p, url, kind) {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = function () {
      try {
        const cw = Math.min(img.width >= 2048 ? 2048 : 1024, 2048);
        const c = document.createElement('canvas');
        c.width = cw; c.height = cw / 2;
        const x = c.getContext('2d');
        x.drawImage(img, 0, 0, c.width, c.height);
        x.getImageData(0, 0, 1, 1); // CORS taint check
        if (!kind && p.name === 'Earth') {
          const surfacePixels = x.getImageData(0, 0, c.width, c.height);
          p._surfaceData = { d: surfacePixels.data, w: c.width, h: c.height };
          p._imgData = p._surfaceData;
        }
        if (!kind) {
          for (let i = 0; i < 1500; i++) {
            x.globalAlpha = 0.03;
            x.fillStyle = Math.random() > 0.5 ? '#000' : '#fff';
            x.fillRect(Math.random() * c.width, Math.random() * c.height, 2, 2);
          }
          x.globalAlpha = 1;
        }
        const t = new THREE.CanvasTexture(c);
        t.encoding = THREE.sRGBEncoding;
        t.wrapS = THREE.RepeatWrapping;
        t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
        if (kind === 'cloud') {
          p.cloudMesh.material.map = t;
          p.cloudMesh.material.alphaMap = t;
          p.cloudMesh.material.color.set(0xffffff);
          p.cloudMesh.material.needsUpdate = true;
        } else if (kind === 'cloudpng') {
          p.cloudMesh.material.map = t;
          p.cloudMesh.material.alphaMap = null;
          p.cloudMesh.material.color.set(0xffffff);
          p.cloudMesh.material.needsUpdate = true;
        } else if (kind === 'normal') {
          t.encoding = THREE.LinearEncoding;
          p._realNormal = true;
          p.mesh.material.normalMap = t;
          p.mesh.material.normalScale = new THREE.Vector2(1, 1);
          p.mesh.material.needsUpdate = true;
        } else if (kind === 'specular') {
          t.encoding = THREE.LinearEncoding;
          if (p.mesh.material.isMeshStandardMaterial) {
            // The source is a Phong specular mask (white oceans), so invert it
            // into a physically based roughness mask (dark oceans).
            const id=x.getImageData(0,0,c.width,c.height);
            if (p.name === 'Earth') {
              // Keep the original white-ocean mask for coastline collision,
              // swimming and the close-range water surface.
              p._waterData = { d: new Uint8ClampedArray(id.data), w:c.width, h:c.height };
              if (typeof resetEarthSurfaceTiles === 'function') resetEarthSurfaceTiles();
            }
            for(let i=0;i<id.data.length;i+=4){ id.data[i]=255-id.data[i]; id.data[i+1]=255-id.data[i+1]; id.data[i+2]=255-id.data[i+2]; }
            x.putImageData(id,0,0);
            const roughT=new THREE.CanvasTexture(c);
            roughT.encoding=THREE.LinearEncoding; roughT.wrapS=THREE.RepeatWrapping; roughT.anisotropy=t.anisotropy;
            p.mesh.material.roughnessMap = roughT;
            p.mesh.material.roughness = 0.92;
          } else {
            p.mesh.material.specularMap = t;
            p.mesh.material.specular.setHex(0x667a8a);
            p.mesh.material.shininess = 22;
          }
          p.mesh.material.needsUpdate = true;
        } else if (kind === 'ring') {
          p.ringMesh.material.map = t;
          p.ringMesh.material.needsUpdate = true;
        } else {
          p.tex = t;
          p._imgData = undefined;
          if(p.emissive&&p.mesh.material.uniforms&&p.mesh.material.uniforms.surfaceMap){
            p.mesh.material.uniforms.surfaceMap.value=t;
          }else p.mesh.material.map = t;
          if (!p.emissive) {
            if (!p._realNormal && p !== earth) {
              try {
                p.mesh.material.normalMap = normalFromCanvas(c, 2.2);
                p.mesh.material.bumpMap = null;
              } catch (e2) {}
            }
            if (p === earth) {
              try { installEarthNight(nightLights(c)); } catch (e2) {}
            }
          }
          p.mesh.material.needsUpdate = true;
        }
      } catch (e) { /* keep procedural texture */ }
    };
    img.onerror = function () {
      if (!img._retried && /^https?:/.test(url)) {
        img._retried = true;
        img.src = 'https://images.weserv.nl/?url=' + encodeURIComponent(url.replace('https://', ''));
      }
    };
    img.src = url;
  }
  const TXP = 'https://raw.githubusercontent.com/jeromeetienne/threex.planets/master/images/';
  tryRealTexture(sun, TXP + 'sunmap.jpg');
  tryRealTexture(mercury, TXP + 'mercurymap.jpg');
  tryRealTexture(venus, TXP + 'venusmap.jpg');
  // Earth uses local cached 2K maps: fast repeat loads, correct continents,
  // ocean roughness and independent translucent cloud cover. Relief comes
  // from the real displaced geometry; a planet-wide normal map sparkles when
  // viewed from walking distance, so Earth deliberately does not use one.
  tryRealTexture(earth, 'assets/earth/earth_day_2048.jpg');
  tryRealTexture(earth, 'assets/earth/earth_specular_2048.jpg', 'specular');
  tryRealTexture(earth, 'assets/earth/earth_clouds_1024.png', 'cloudpng');

  // NASA global land elevation, encoded 0–6400 real meters. World space is
  // 1:10, therefore a 6400 m mountain is exactly 640 world units high.
  // One stable displaced sphere replaces the previous player-following tiles.
  const EARTH_ELEVATION_MAX = 640;
  // One continuous globe: enough subdivisions to distribute real elevation
  // worldwide without laying a second, flickering surface over the first.
  const earthElevation = {
    data:null,w:4096,h:2048,segW:1280,segH:640,grid:null,
    rugged:null,ruggedW:1024,ruggedH:512,ready:false
  };
  const earthSurfaceCutaway={center:{value:new THREE.Vector3(0,1,0)},cosRadius:{value:2}};
  earth.mesh.material.onBeforeCompile=shader=>{
    shader.uniforms.earthSurfaceCenter=earthSurfaceCutaway.center;
    shader.uniforms.earthSurfaceCosRadius=earthSurfaceCutaway.cosRadius;
    shader.vertexShader=shader.vertexShader
      .replace('#include <common>','#include <common>\nvarying vec3 vEarthLocalDir;')
      .replace('#include <begin_vertex>','#include <begin_vertex>\nvEarthLocalDir=normalize(position);');
    shader.fragmentShader=shader.fragmentShader
      .replace('#include <common>','#include <common>\nvarying vec3 vEarthLocalDir;\nuniform vec3 earthSurfaceCenter;\nuniform float earthSurfaceCosRadius;')
      .replace('#include <clipping_planes_fragment>','#include <clipping_planes_fragment>\nif(dot(normalize(vEarthLocalDir),earthSurfaceCenter)>earthSurfaceCosRadius)discard;');
  };
  earth.mesh.material.customProgramCacheKey=()=> 'earth-surface-cutaway-v1';
  earth.mesh.material.needsUpdate=true;
  const EARTH_MOUNTAIN_SITES=[
    {name:'Everest',file:'everest.png',mapLon:86.925,mapLat:27.764,baseLon:86.925,baseLat:27.54,peakLon:86.925,peakLat:27.9881,peakM:8848.86},
    {name:'Aconcagua',file:'aconcagua.png',mapLon:-69.745,mapLat:-32.653,baseLon:-69.48,baseLat:-32.653,peakLon:-70.0109,peakLat:-32.6532,peakM:6961},
    {name:'Denali',file:'denali.png',mapLon:-151.007,mapLat:62.845,baseLon:-151.007,baseLat:62.62,peakLon:-151.0074,peakLat:63.0695,peakM:6190},
    {name:'Kilimanjaro',file:'kilimanjaro.png',mapLon:37.128,mapLat:-3.067,baseLon:36.90,baseLat:-3.067,peakLon:37.3556,peakLat:-3.0674,peakM:5895},
    {name:'Elbrus',file:'elbrus.png',mapLon:42.439,mapLat:43.125,baseLon:42.439,baseLat:42.90,peakLon:42.4392,peakLat:43.3499,peakM:5642},
    {name:'Puncak Jaya',file:'puncak-jaya.png',mapLon:137.384,mapLat:-4.079,baseLon:137.61,baseLat:-4.079,peakLon:137.1583,peakLat:-4.0785,peakM:4884},
    {name:'Mont Blanc',file:'mont-blanc.png',mapLon:6.543,mapLat:45.832,baseLon:6.22,baseLat:45.832,peakLon:6.8652,peakLat:45.8326,peakM:4806}
  ];
  for(const s of EARTH_MOUNTAIN_SITES){
    const lo=(s.peakLon+180)/360*Math.PI*2,la=s.peakLat*Math.PI/180,cl=Math.cos(la);
    s.peakLocal=V3(-Math.cos(lo)*cl,Math.sin(la),Math.sin(lo)*cl).normalize();
    const blo=(s.baseLon+180)/360*Math.PI*2,bla=s.baseLat*Math.PI/180,bcl=Math.cos(bla);
    s.baseLocal=V3(-Math.cos(blo)*bcl,Math.sin(bla),Math.sin(blo)*bcl).normalize();
    s.spanLat=3.6;s.spanLon=3.6/Math.max(.2,Math.cos(bla));s.regionCos=Math.cos(20000/earth.r*.98);s.data=null;s.summitLift=0;
  }
  const earthMountainPatches=[];
  const elevationLocalN=new THREE.Vector3(),elevationQ=new THREE.Quaternion();
  function sampleEarthElevationBaseRaster(n){
    if(!earthElevation.data)return 0;
    const theta=Math.acos(Math.max(-1,Math.min(1,n.y)));
    let phi=Math.atan2(n.z,-n.x);if(phi<0)phi+=Math.PI*2;
    const fx=phi/(Math.PI*2)*earthElevation.w,fy=theta/Math.PI*(earthElevation.h-1);
    const x0=Math.floor(fx)%earthElevation.w,x1=(x0+1)%earthElevation.w,y0=Math.floor(fy),y1=Math.min(earthElevation.h-1,y0+1);
    const tx=fx-Math.floor(fx),ty=fy-y0,d=earthElevation.data,w=earthElevation.w;
    const a=d[(y0*w+x0)*4],b=d[(y0*w+x1)*4],c=d[(y1*w+x0)*4],e=d[(y1*w+x1)*4];
    return ((a*(1-tx)+b*tx)*(1-ty)+(c*(1-tx)+e*tx)*ty)/255*EARTH_ELEVATION_MAX;
  }
  function sampleEarthRuggednessLocal(n){
    if(!earthElevation.rugged)return 0;
    const theta=Math.acos(Math.max(-1,Math.min(1,n.y)));
    let phi=Math.atan2(n.z,-n.x);if(phi<0)phi+=Math.PI*2;
    const fx=phi/(Math.PI*2)*earthElevation.ruggedW,fy=theta/Math.PI*(earthElevation.ruggedH-1);
    const x0=Math.floor(fx)%earthElevation.ruggedW,x1=(x0+1)%earthElevation.ruggedW;
    const y0=Math.floor(fy),y1=Math.min(earthElevation.ruggedH-1,y0+1),tx=fx-Math.floor(fx),ty=fy-y0;
    const d=earthElevation.rugged,w=earthElevation.ruggedW;
    return (d[y0*w+x0]*(1-tx)+d[y0*w+x1]*tx)*(1-ty)+(d[y1*w+x0]*(1-tx)+d[y1*w+x1]*tx)*ty;
  }
  function sampleMountainRegionBase(s,n){
    if(!s.data)return sampleEarthElevationBaseRaster(n);
    const lat=Math.asin(Math.max(-1,Math.min(1,n.y)))*180/Math.PI;
    let a=Math.atan2(n.z,-n.x);if(a<0)a+=Math.PI*2;
    const lon=a*180/Math.PI-180;
    let dl=lon-s.mapLon;if(dl>180)dl-=360;if(dl<-180)dl+=360;
    const u=.5+dl/s.spanLon,v=.5-(lat-s.mapLat)/s.spanLat;
    if(u<0||u>1||v<0||v>1)return sampleEarthElevationBaseRaster(n);
    const fx=u*255,fy=v*255,x0=Math.floor(fx),y0=Math.floor(fy),x1=Math.min(255,x0+1),y1=Math.min(255,y0+1),tx=fx-x0,ty=fy-y0,d=s.data;
    const a0=d[(y0*256+x0)*4],b=d[(y0*256+x1)*4],c=d[(y1*256+x0)*4],e=d[(y1*256+x1)*4];
    return ((a0*(1-tx)+b*tx)*(1-ty)+(c*(1-tx)+e*tx)*ty)/255*EARTH_ELEVATION_MAX;
  }
  function sampleEarthElevationRaster(n){
    let elevation=sampleEarthElevationBaseRaster(n);
    for(const s of EARTH_MOUNTAIN_SITES)if(s.data&&n.dot(s.baseLocal)>s.regionCos){elevation=sampleMountainRegionBase(s,n);break;}
    // The source raster is capped at 6400 m. Restore the surveyed summit
    // height only inside each summit's real, kilometre-scale footprint.
    for(const s of EARTH_MOUNTAIN_SITES){
      if(!s.summitLift)continue;
      const dot=Math.max(-1,Math.min(1,n.dot(s.peakLocal)));
      if(dot<.99996)continue;
      const distance=Math.acos(dot)*earth.r;
      elevation+=s.summitLift*Math.exp(-(distance*distance)/(2*700*700));
    }
    return elevation;
  }
  function sampleEarthElevationLocal(n){
    if(!earthElevation.grid)return sampleEarthElevationRaster(n);
    const theta=Math.acos(Math.max(-1,Math.min(1,n.y)));
    let phi=Math.atan2(n.z,-n.x);if(phi<0)phi+=Math.PI*2;
    const fu=Math.min(phi/(Math.PI*2)*earthElevation.segW,earthElevation.segW-1e-7);
    const fv=Math.min(theta/Math.PI*earthElevation.segH,earthElevation.segH-1e-7);
    const i=Math.floor(fu),j=Math.floor(fv),tu=fu-i,tv=fv-j,w=earthElevation.segW+1,g=earthElevation.grid;
    const g00=g[j*w+i],g10=g[j*w+i+1],g01=g[(j+1)*w+i],g11=g[(j+1)*w+i+1];
    return tu>=tv?(1-tu)*g00+(tu-tv)*g10+tv*g11:(1-tv)*g00+(tv-tu)*g01+tu*g11;
  }
  function earthElevationAtWorld(nWorld){
    elevationQ.copy(earth.mesh.quaternion).invert();
    elevationLocalN.copy(nWorld).applyQuaternion(elevationQ).normalize();
    return sampleEarthElevationLocal(elevationLocalN);
  }
  function buildStableEarthMountains(){
    const geo=new THREE.SphereGeometry(earth.r,earthElevation.segW,earthElevation.segH),a=geo.attributes.position;
    for(let i=0;i<a.count;i++){
      elevationLocalN.set(a.getX(i),a.getY(i),a.getZ(i)).normalize();
      const rr=earth.r+earthElevation.grid[i];
      a.setXYZ(i,elevationLocalN.x*rr,elevationLocalN.y*rr,elevationLocalN.z*rr);
    }
    a.needsUpdate=true;geo.computeVertexNormals();geo.computeBoundingSphere();
    earth._baseTerrainPositions=new Float32Array(a.array);
    earth.mesh.geometry.dispose();earth.mesh.geometry=geo;
    earth.mesh.material.bumpMap=null;
    earth.mesh.material.normalMap=null;
    earth.mesh.material.emissive.setHex(0x07101b);
    earth.mesh.material.emissiveIntensity=.3;
    earth.mesh.material.needsUpdate=true;
    if(earth.craters&&earth.craters.length){
      for(const cr of earth.craters){cr._earthVertexIndices=null;cr._earthVertexRadius=0;reapplyCraters(earth,cr);}
    }
    // A planet-sized receiver exceeds the precision of the character's tiny
    // shadow frustum and produces crawling stipple (“shadow acne”). Earth keeps
    // normal PBR lighting, but does not cast onto or receive from that map.
    earth.mesh.castShadow=false;
    earth.mesh.receiveShadow=false;
  }
  function buildPermanentMountainPatches(){
    const R=20000,S=160,N=S+1;
    for(const site of EARTH_MOUNTAIN_SITES){
      const lon=(site.baseLon+180)/360*Math.PI*2,lat=site.baseLat*Math.PI/180,cl=Math.cos(lat);
      const centerLocal=V3(-Math.cos(lon)*cl,Math.sin(lat),Math.sin(lon)*cl).normalize();
      const anchorHeight=sampleEarthElevationRaster(centerLocal);
      const q=new THREE.Quaternion().setFromUnitVectors(V3(0,1,0),centerLocal),qi=q.clone().invert();
      const tx=V3(1,0,0).applyQuaternion(q),tz=V3(0,0,1).applyQuaternion(q),dir=new THREE.Vector3(),point=new THREE.Vector3();
      const positions=new Float32Array(N*N*3),uvs=new Float32Array(N*N*2),indices=[];
      for(let j=0;j<N;j++)for(let i=0;i<N;i++){
        const x=-R+i/S*R*2,z=-R+j/S*R*2,k=j*N+i;
        dir.copy(centerLocal).addScaledVector(tx,x/earth.r).addScaledVector(tz,z/earth.r).normalize();
        const elevation=sampleEarthElevationRaster(dir);
        point.copy(dir).multiplyScalar(earth.r+elevation+.22).addScaledVector(centerLocal,-(earth.r+anchorHeight)).applyQuaternion(qi);
        positions[k*3]=point.x;positions[k*3+1]=point.y;positions[k*3+2]=point.z;
        const theta=Math.acos(Math.max(-1,Math.min(1,dir.y)));let phi=Math.atan2(dir.z,-dir.x);if(phi<0)phi+=Math.PI*2;
        uvs[k*2]=phi/(Math.PI*2);uvs[k*2+1]=1-theta/Math.PI;
      }
      for(let j=0;j<S;j++)for(let i=0;i<S;i++){const a=j*N+i,b=a+1,c=a+N,d=c+1;indices.push(a,c,b,b,c,d);}
      const geo=new THREE.BufferGeometry();geo.setAttribute('position',new THREE.BufferAttribute(positions,3));geo.setAttribute('uv',new THREE.BufferAttribute(uvs,2));geo.setIndex(indices);geo.computeVertexNormals();geo.computeBoundingSphere();
      const mesh=new THREE.Mesh(geo,earth.mesh.material);mesh.position.copy(centerLocal).multiplyScalar(earth.r+anchorHeight);mesh.quaternion.copy(q);mesh.castShadow=true;mesh.receiveShadow=true;mesh.renderOrder=1;
      earth.mesh.add(mesh);earthMountainPatches.push({mesh,centerLocal,cosRadius:Math.cos(R/earth.r*.92)});
    }
  }
  (function loadEarthElevation(){
    function finish(){
      for(const s of EARTH_MOUNTAIN_SITES)s.summitLift=Math.max(0,s.peakM/10-sampleMountainRegionBase(s,s.peakLocal));
      // Precompute a low-cost global relief mask from the full NASA raster.
      // It marks real mountain belts and escarpments, so walking-scale ridges
      // are added where the topography is genuinely rugged, not everywhere.
      const rw=earthElevation.ruggedW,rh=earthElevation.ruggedH,src=earthElevation.data,sw=earthElevation.w,sh=earthElevation.h;
      earthElevation.rugged=new Float32Array(rw*rh);
      for(let y=0;y<rh;y++)for(let x=0;x<rw;x++){
        const sx=Math.floor(x/rw*sw),sy=Math.floor(y/(rh-1)*(sh-1));let lo=255,hi=0;
        for(let oy=-4;oy<=4;oy+=4)for(let ox=-4;ox<=4;ox+=4){
          const xx=(sx+ox+sw)%sw,yy=Math.max(0,Math.min(sh-1,sy+oy)),v=src[(yy*sw+xx)*4];
          lo=Math.min(lo,v);hi=Math.max(hi,v);
        }
        earthElevation.rugged[y*rw+x]=(hi-lo)/255*EARTH_ELEVATION_MAX;
      }
      const gw=earthElevation.segW+1,gh=earthElevation.segH+1;
      earthElevation.grid=new Float32Array(gw*gh);
      for(let j=0;j<gh;j++)for(let i=0;i<gw;i++){
        const theta=j/earthElevation.segH*Math.PI,phi=i/earthElevation.segW*Math.PI*2,st=Math.sin(theta);
        elevationLocalN.set(-Math.cos(phi)*st,Math.cos(theta),Math.sin(phi)*st);
        earthElevation.grid[j*gw+i]=sampleEarthElevationRaster(elevationLocalN);
      }
      earthElevation.ready=true;
      buildStableEarthMountains();
      setTimeout(()=>{if(grounded&&groundPlanet===earth)spawnOn(earth);},0);
    }
    function loadRegions(){
      let pending=EARTH_MOUNTAIN_SITES.length;
      const done=()=>{if(--pending===0)finish();};
      for(const s of EARTH_MOUNTAIN_SITES){
        const regional=new Image();
        regional.onload=()=>{const c=document.createElement('canvas');c.width=c.height=256;const x=c.getContext('2d');x.drawImage(regional,0,0,256,256);s.data=x.getImageData(0,0,256,256).data;done();};
        regional.onerror=done;regional.src='assets/earth/mountains/'+s.file;
      }
    }
    const img=new Image();
    img.onload=()=>{
      const c=document.createElement('canvas');c.width=earthElevation.w;c.height=earthElevation.h;
      const x=c.getContext('2d');x.drawImage(img,0,0,c.width,c.height);
      earthElevation.data=x.getImageData(0,0,c.width,c.height).data;
      loadRegions();
    };
    img.src='assets/earth/earth_elevation_nasa_4096.png';
  })();
  tryRealTexture(moon, TXP + 'moonmap1k.jpg');
  tryRealTexture(mars, TXP + 'marsmap1k.jpg');
  tryRealTexture(jupiter, TXP + 'jupitermap.jpg');
  tryRealTexture(saturn, TXP + 'saturnmap.jpg');
  tryRealTexture(saturn, TXP + 'saturnringcolor.jpg', 'ring');
  tryRealTexture(uranus, TXP + 'uranusmap.jpg');
  tryRealTexture(neptune, TXP + 'neptunemap.jpg');

  function nearestStarTo(point) {
    let best = stars[0], bd = Infinity;
    for (const s of stars) {
      if(s.blackhole)continue;
      const d = point.distanceTo(s.center);
      if (d < bd) { bd = d; best = s; }
    }
    return best;
  }

  const eclipseStarVector=new THREE.Vector3(),eclipseBodyVector=new THREE.Vector3();
  function stellarVisibility(observer,star,standingBody){
    eclipseStarVector.copy(star.center).sub(observer);
    const starDistance=eclipseStarVector.length();
    if(starDistance<=star.r)return 1;
    eclipseStarVector.divideScalar(starDistance);
    const starAngular=Math.asin(Math.min(.9999,star.r/starDistance));
    let visibility=1;
    for(const body of planets){
      if(body===star||body===standingBody||body.isStar||body.destroyed)continue;
      eclipseBodyVector.copy(body.center).sub(observer);
      const bodyDistance=eclipseBodyVector.length();
      if(bodyDistance<=body.r*1.01||bodyDistance>=starDistance)continue;
      eclipseBodyVector.divideScalar(bodyDistance);
      const separation=Math.acos(Math.max(-1,Math.min(1,eclipseBodyVector.dot(eclipseStarVector))));
      const bodyAngular=Math.asin(Math.min(.9999,body.r/bodyDistance));
      if(separation>=starAngular+bodyAngular)continue;
      let cover;
      if(bodyAngular>=starAngular&&separation<=bodyAngular-starAngular)cover=1;
      else cover=Math.max(0,Math.min(1,(starAngular+bodyAngular-separation)/(starAngular*2)));
      visibility*=1-cover;
      if(visibility<.002)return 0;
    }
    return visibility;
  }

  // ---------- Astronaut rig ----------
  const player = new THREE.Group();
  const PSCALE = 0.45;
  const rig = {};
  let flame;
  function buildAstronautLegacy() {
    const suit  = new THREE.MeshStandardMaterial({ color: 0xe8e9e6, roughness: 0.72, metalness: 0.02 });
    const shade = new THREE.MeshStandardMaterial({ color: 0xb8bdc3, roughness: 0.8, metalness: 0.03 });
    const joint = new THREE.MeshStandardMaterial({ color: 0x747b83, roughness: 0.68, metalness: 0.12 });
    const dark  = new THREE.MeshStandardMaterial({ color: 0x20262c, roughness: 0.62, metalness: 0.18 });
    const glass = new THREE.MeshStandardMaterial({ color: 0x07101b, emissive: 0x03070d, roughness: 0.08, metalness: 0.25 });
    const accent = new THREE.MeshStandardMaterial({ color: 0xb94d20, roughness: 0.62, metalness: 0.04 });
    const glowBlue = new THREE.MeshBasicMaterial({ color: 0x66ccff });
    const glowGreen = new THREE.MeshBasicMaterial({ color: 0x7dffa8 });

    function add(parent, mesh, x, y, z) { mesh.position.set(x, y, z); parent.add(mesh); return mesh; }

    // hips
    add(player, new THREE.Mesh(new THREE.SphereGeometry(0.74, 16, 12), shade), 0, 1.2, 0).scale.set(1, 0.6, 0.85);
    add(player, new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.8, 0.2, 16), accent), 0, 1.5, 0); // belt

    // torso group — leans, sways, bobs
    const torso = new THREE.Group();
    torso.position.set(0, 1.55, 0);
    player.add(torso);
    rig.torso = torso;
    add(torso, new THREE.Mesh(new THREE.CylinderGeometry(0.95, 0.78, 1.5, 18), suit), 0, 0.75, 0);
    add(torso, new THREE.Mesh(new THREE.SphereGeometry(0.95, 18, 14), suit), 0, 1.5, 0).scale.set(1, 0.55, 1);
    // chest control panel
    add(torso, new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.6, 0.24), dark), 0, 0.95, -0.82);
    add(torso, new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.1, 0.06), accent), -0.24, 1.05, -0.97);
    add(torso, new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.1, 0.06), glowBlue), 0, 1.05, -0.97);
    add(torso, new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.1, 0.06), glowGreen), 0.24, 1.05, -0.97);
    add(torso, new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.14, 0.06), shade), 0, 0.8, -0.97);
    // shoulders
    add(torso, new THREE.Mesh(new THREE.SphereGeometry(0.42, 12, 10), joint), -1.05, 1.18, 0);
    add(torso, new THREE.Mesh(new THREE.SphereGeometry(0.42, 12, 10), joint), 1.05, 1.18, 0);
    // neck
    add(torso, new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.4, 0.24, 12), shade), 0, 1.66, 0);

    // head group — pitches to look around
    const head = new THREE.Group();
    head.position.set(0, 1.9, 0);
    head.scale.setScalar(0.62); // human helmet/body proportion instead of an oversized character head
    torso.add(head);
    rig.head = head;
    add(head, new THREE.Mesh(new THREE.SphereGeometry(0.84, 22, 18), suit), 0, 0, 0);
    const visor = add(head, new THREE.Mesh(new THREE.SphereGeometry(0.76, 22, 18), glass), 0, 0.02, -0.2);
    visor.scale.set(0.95, 0.8, 0.9);
    add(head, new THREE.Mesh(new THREE.TorusGeometry(0.56, 0.05, 8, 20), shade), 0, -0.25, -0.28).rotation.x = 1.3;
    add(head, new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), glowBlue), -0.72, 0.1, -0.3);
    add(head, new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), glowBlue), 0.72, 0.1, -0.3);

    // backpack on the torso (leans with the body)
    add(torso, new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.8, 0.72), dark), 0, 0.85, 0.95);
    add(torso, new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.14, 0.05), glowBlue), 0, 0.85, 1.33);
    add(torso, new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 1.5, 10), shade), -0.45, 0.85, 1.45);
    add(torso, new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 1.5, 10), shade), 0.45, 0.85, 1.45);
    add(torso, new THREE.Mesh(new THREE.SphereGeometry(0.28, 10, 8), accent), -0.45, 1.62, 1.45);
    add(torso, new THREE.Mesh(new THREE.SphereGeometry(0.28, 10, 8), accent), 0.45, 1.62, 1.45);
    add(torso, new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.24, 0.32, 8), dark), -0.45, 0.02, 1.45);
    add(torso, new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.24, 0.32, 8), dark), 0.45, 0.02, 1.45);
    // life-support hoses, pack to helmet
    const hoseL = add(torso, new THREE.Mesh(new THREE.TorusGeometry(0.48, 0.055, 6, 12, 2.2), joint), -0.62, 1.35, 0.5);
    hoseL.rotation.y = Math.PI / 2;
    const hoseR = add(torso, new THREE.Mesh(new THREE.TorusGeometry(0.48, 0.055, 6, 12, 2.2), joint), 0.62, 1.35, 0.5);
    hoseR.rotation.y = Math.PI / 2;
    // thruster flame
    flame = new THREE.Mesh(
      new THREE.ConeGeometry(0.3, 1.5, 8),
      new THREE.MeshBasicMaterial({ color: 0xff9a2e, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending })
    );
    flame.rotation.x = Math.PI;
    flame.position.set(0, -0.5, 1.45);
    flame.visible = false;
    torso.add(flame);

    // two-segment arms (shoulder + elbow)
    function arm(side) {
      const sh = new THREE.Group();
      sh.position.set(side * 1.05, 1.18, 0);
      torso.add(sh);
      const upper = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.21, 0.55, 10), suit);
      upper.position.y = -0.3;
      sh.add(upper);
      const elJoint = new THREE.Mesh(new THREE.SphereGeometry(0.23, 8, 6), joint);
      elJoint.position.set(0, -0.58, 0);
      sh.add(elJoint);
      const el = new THREE.Group();
      el.position.set(0, -0.58, 0);
      sh.add(el);
      const fore = new THREE.Mesh(new THREE.CylinderGeometry(0.21, 0.18, 0.5, 10), suit);
      fore.position.y = -0.27;
      el.add(fore);
      const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.12, 10), accent);
      cuff.position.y = -0.5;
      el.add(cuff);
      const glove = new THREE.Mesh(new THREE.SphereGeometry(0.24, 10, 8), dark);
      glove.position.y = -0.62;
      el.add(glove);
      return { sh: sh, el: el };
    }
    rig.armL = arm(-1);
    rig.armR = arm(1);
    rig.armL.sh.rotation.z = -0.12;
    rig.armR.sh.rotation.z = 0.12;

    // laser blaster, gripped in the right hand — hidden until equipped with L.
    // The barrel runs along -Y (the forearm's pointing axis) so it aims wherever
    // the hand points when the arm is raised.
    (function buildGun() {
      const metal = new THREE.MeshPhongMaterial({ color: 0x2a2f3a, shininess: 60, specular: 0x8895a8 });
      const trim  = new THREE.MeshPhongMaterial({ color: 0x444b58, shininess: 40 });
      const hot   = new THREE.MeshBasicMaterial({ color: 0xff4a2a });
      const g = new THREE.Group();
      const body   = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.5, 0.28), metal); body.position.y = -0.12; g.add(body);
      const sight  = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.12, 0.16), trim); sight.position.set(0, 0.06, -0.02); g.add(sight);
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 0.6, 14), metal); barrel.position.y = -0.6; g.add(barrel);
      const ring   = new THREE.Mesh(new THREE.TorusGeometry(0.11, 0.03, 8, 16), trim); ring.position.y = -0.78; ring.rotation.x = Math.PI/2; g.add(ring);
      const emit   = new THREE.Mesh(new THREE.SphereGeometry(0.1, 12, 10), hot); emit.position.y = -0.92; g.add(emit);
      const grip   = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.34, 0.18), metal); grip.position.set(0, 0.0, 0.22); grip.rotation.x = 0.35; g.add(grip);
      const muzzle = new THREE.Object3D(); muzzle.position.y = -1.02; g.add(muzzle);
      g.position.set(0, -0.66, 0);   // sit in the glove at the end of the forearm
      g.visible = false;
      rig.armR.el.add(g);
      rig.gun = g; rig.gunTip = muzzle;
    })();

    // two-segment legs (hip + knee) with boots
    function leg(side) {
      const hip = new THREE.Group();
      hip.position.set(side * 0.42, 1.15, 0);
      player.add(hip);
      const hipJoint = new THREE.Mesh(new THREE.SphereGeometry(0.3, 8, 6), joint);
      hip.add(hipJoint);
      const thigh = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.26, 0.55, 10), suit);
      thigh.position.y = -0.3;
      hip.add(thigh);
      const kneeJoint = new THREE.Mesh(new THREE.SphereGeometry(0.26, 8, 6), joint);
      kneeJoint.position.set(0, -0.58, 0);
      hip.add(kneeJoint);
      const knee = new THREE.Group();
      knee.position.set(0, -0.58, 0);
      hip.add(knee);
      const shin = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.22, 0.5, 10), suit);
      shin.position.y = -0.27;
      knee.add(shin);
      const boot = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.28, 0.85), dark);
      boot.position.set(0, -0.56, -0.18);
      knee.add(boot);
      return { hip: hip, knee: knee };
    }
    rig.legL = leg(-1);
    rig.legR = leg(1);
  }

  // High-detail EVA suit assembled from smooth, shaped components while
  // retaining the lightweight articulated rig used by the game animation.
  function buildAstronautPrevious() {
    const fabricColor = canvasTex((x,w,h)=>{
      x.fillStyle='#cbc8bf';x.fillRect(0,0,w,h);
      for(let y=0;y<h;y+=4){
        x.fillStyle=y%8?'rgba(255,255,255,.055)':'rgba(38,43,45,.035)';x.fillRect(0,y,w,1);
      }
      for(let i=0;i<900;i++){
        const v=165+Math.floor(Math.random()*45);x.fillStyle=`rgba(${v},${v},${v-3},.08)`;
        x.fillRect(Math.random()*w,Math.random()*h,1,1);
      }
    },128,128);
    const fabricBump = canvasTex((x, w, h) => {
      x.fillStyle = '#888'; x.fillRect(0, 0, w, h);
      for (let i = 0; i < w; i += 4) {
        x.fillStyle = i % 8 ? '#929292' : '#777'; x.fillRect(i, 0, 1, h);
      }
      for (let j = 0; j < h; j += 4) {
        x.fillStyle = j % 8 ? 'rgba(255,255,255,.12)' : 'rgba(0,0,0,.1)'; x.fillRect(0, j, w, 1);
      }
    }, 128, 128);
    fabricBump.wrapS = fabricBump.wrapT = THREE.RepeatWrapping;
    fabricBump.repeat.set(7, 10);
    fabricColor.wrapS=fabricColor.wrapT=THREE.RepeatWrapping;
    fabricColor.repeat.set(7,10);fabricColor.encoding=THREE.sRGBEncoding;

    const suit = new THREE.MeshPhysicalMaterial({ color: 0xf1eee5, map:fabricColor, roughness: 0.76, metalness: 0, clearcoat:.09, clearcoatRoughness:.68, bumpMap: fabricBump, bumpScale: 0.022 });
    const softShade = new THREE.MeshPhysicalMaterial({ color: 0xaaa9a4, map:fabricColor, roughness: 0.86, metalness: 0, clearcoat:.025, clearcoatRoughness:.9, bumpMap: fabricBump, bumpScale: 0.019 });
    const seam = new THREE.MeshStandardMaterial({ color: 0x777b79, roughness: 0.92, metalness: 0.01 });
    const rubber = new THREE.MeshStandardMaterial({ color: 0x090d10, roughness: 0.8, metalness: 0.02 });
    const hardware = new THREE.MeshPhysicalMaterial({ color: 0x8e9697, roughness: 0.42, metalness: 0.54, clearcoat:.18,clearcoatRoughness:.3 });
    const ceramic = new THREE.MeshPhysicalMaterial({color:0xe8e4da,roughness:.42,metalness:.04,clearcoat:.46,clearcoatRoughness:.3});
    const orange = new THREE.MeshPhysicalMaterial({color:0x9c2921,roughness:.62,metalness:.02,clearcoat:.08,clearcoatRoughness:.55});
    const gold = new THREE.MeshPhysicalMaterial({ color: 0xb57a2b, roughness: 0.12, metalness: 0.9, emissive: 0x100600, clearcoat:.72,clearcoatRoughness:.08 });
    const visorMat = new THREE.MeshPhysicalMaterial({color:0x87663c,roughness:.035,metalness:.14,clearcoat:1,clearcoatRoughness:.012,reflectivity:1,transparent:true,opacity:.34,transmission:.52,depthWrite:false});
    const visorGlass = new THREE.MeshPhysicalMaterial({color:0xb8d5de,roughness:.012,metalness:0,transparent:true,opacity:.075,transmission:.9,reflectivity:1,clearcoat:1,clearcoatRoughness:.008,depthWrite:false});
    const panelMat = new THREE.MeshPhysicalMaterial({ color: 0x11181c, roughness: 0.42, metalness: 0.5, clearcoat:.24,clearcoatRoughness:.3 });
    const red = new THREE.MeshStandardMaterial({ color: 0xa12d22, roughness: 0.5 });
    const lightBlue = new THREE.MeshBasicMaterial({ color: 0x80d8e8 });
    const lightAmber = new THREE.MeshBasicMaterial({ color: 0xffb34f });
    const skin = new THREE.MeshPhysicalMaterial({color:0xb47f66,roughness:.72,metalness:0,clearcoat:.018});
    const hood = new THREE.MeshStandardMaterial({color:0x07090b,roughness:.96,metalness:0});
    const eyeWhite = new THREE.MeshPhysicalMaterial({color:0xe6dfd5,roughness:.42,clearcoat:.15});
    const eye = new THREE.MeshPhysicalMaterial({color:0x3a2618,roughness:.12,clearcoat:1,clearcoatRoughness:.03});
    const browMat=new THREE.MeshStandardMaterial({color:0x2b1a13,roughness:.9});
    const lipMat=new THREE.MeshStandardMaterial({color:0x6f342f,roughness:.78});

    function add(parent, mesh, x, y, z) {
      mesh.position.set(x || 0, y || 0, z || 0);
      parent.add(mesh);
      return mesh;
    }
    function lathe(profile, material, segments) {
      return new THREE.Mesh(new THREE.LatheGeometry(profile.map(p => new THREE.Vector2(p[0], p[1])), segments || 36), material);
    }
    function roundedBox(w, h, d, radius, material) {
      const r = Math.min(radius, w * 0.45, h * 0.45);
      const s = new THREE.Shape();
      s.moveTo(-w/2 + r, -h/2);
      s.lineTo(w/2 - r, -h/2); s.quadraticCurveTo(w/2, -h/2, w/2, -h/2 + r);
      s.lineTo(w/2, h/2 - r); s.quadraticCurveTo(w/2, h/2, w/2 - r, h/2);
      s.lineTo(-w/2 + r, h/2); s.quadraticCurveTo(-w/2, h/2, -w/2, h/2 - r);
      s.lineTo(-w/2, -h/2 + r); s.quadraticCurveTo(-w/2, -h/2, -w/2 + r, -h/2);
      const g = new THREE.ExtrudeGeometry(s, { depth: d, bevelEnabled: true, bevelSegments: 3, bevelSize: r * 0.28, bevelThickness: r * 0.28, curveSegments: 8 });
      g.translate(0, 0, -d / 2);
      return new THREE.Mesh(g, material);
    }
    function seamRing(parent, radius, y, material, tube) {
      const m = add(parent, new THREE.Mesh(new THREE.TorusGeometry(radius, tube || 0.018, 8, 30), material), 0, y, 0);
      m.rotation.x = Math.PI / 2;
      return m;
    }
    function taperedLimb(topR, bottomR, length, material) {
      const g = new THREE.Group();
      const core = add(g, new THREE.Mesh(new THREE.CylinderGeometry(topR, bottomR, length, 28, 4), material), 0, -length / 2, 0);
      core.scale.z = 0.92;
      const top = add(g, new THREE.Mesh(new THREE.SphereGeometry(topR, 24, 16), material), 0, 0, 0);
      top.scale.set(1, 0.55, 0.92);
      const bottom = add(g, new THREE.Mesh(new THREE.SphereGeometry(bottomR, 24, 16), material), 0, -length, 0);
      bottom.scale.set(1, 0.52, 0.92);
      return g;
    }

    // Lower pressure garment and waist bearing.
    const pelvis = add(player, lathe([[0.46,0],[0.57,0.12],[0.62,0.32],[0.58,0.5],[0.48,0.58]], softShade, 40), 0, 0.94, 0);
    pelvis.scale.z = 0.82;
    seamRing(player, 0.57, 1.48, hardware, 0.035);
    const beltBuckle = add(player, roundedBox(0.32, 0.16, 0.09, 0.035, hardware), 0, 1.48, -0.55);
    add(beltBuckle, new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.045, 0.025), lightAmber), 0, 0, -0.065);

    // Hard upper torso with a cloth pressure cover and shaped shoulder line.
    const torso = new THREE.Group();
    torso.position.set(0, 1.55, 0);
    player.add(torso); rig.torso = torso;
    const shell = add(torso, lathe([[0.56,0],[0.7,0.16],[0.78,0.52],[0.8,1.02],[0.7,1.42],[0.55,1.54]], suit, 48), 0, 0, 0);
    shell.scale.z = 0.72;
    seamRing(torso, 0.57, 0.08, seam, 0.025);
    seamRing(torso, 0.58, 1.46, hardware, 0.03);
    // Sculpted ceramic load-bearing plates create a recognizable modern EVA
    // silhouette while the pressure garment remains visible between them.
    for(const side of [-1,1]){
      const torsoPlate=add(torso,roundedBox(.43,.98,.065,.085,softShade),side*.255,.8,-.53);
      torsoPlate.rotation.z=side*-.055;
      add(torsoPlate,roundedBox(.04,.68,.018,.014,orange),side*-.15,.02,-.046);
    }
    const collarGuard=add(torso,new THREE.Mesh(new THREE.TorusGeometry(.57,.075,16,48,Math.PI*1.5),ceramic),0,1.43,-.02);
    collarGuard.rotation.x=Math.PI/2;collarGuard.rotation.z=Math.PI*.25;

    // Layered chest control unit, connectors, gauges and restraint webbing.
    const chest = add(torso, roundedBox(0.72, 0.46, 0.16, 0.068, panelMat), 0, 0.82, -0.61);
    add(chest, roundedBox(0.57, 0.09, 0.025, 0.016, softShade), 0, 0.115, -0.1);
    const screen = add(chest, roundedBox(0.23, 0.13, 0.028, 0.014, rubber), -0.14, -0.045, -0.1);
    add(screen, new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.018, 0.012), lightBlue), 0, 0.02, -0.03);
    add(screen, new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.012, 0.012), lightBlue), -0.03, -0.025, -0.03);
    for (let i = 0; i < 3; i++) add(chest, new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.026, 0.02, 16), i === 0 ? red : hardware), 0.13 + i * 0.078, -0.015, -0.105).rotation.x = Math.PI / 2;
    const strapL = add(torso, roundedBox(0.07, 1.15, 0.035, 0.02, seam), -0.43, 0.85, -0.53); strapL.rotation.z = -0.12;
    const strapR = add(torso, roundedBox(0.07, 1.15, 0.035, 0.02, seam), 0.43, 0.85, -0.53); strapR.rotation.z = 0.12;
    for (const x of [-0.58, 0.58]) {
      const port = add(torso, new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.08, 24), hardware), x, 0.48, -0.56);
      port.rotation.x = Math.PI / 2;
    }

    // Shoulder bearings are recessed into the torso rather than floating balls.
    for (const side of [-1, 1]) {
      const bearing = add(torso, new THREE.Mesh(new THREE.TorusGeometry(0.24, 0.055, 12, 32), hardware), side * 0.82, 1.18, 0);
      bearing.rotation.y = Math.PI / 2;
      const cover = add(torso, new THREE.Mesh(new THREE.SphereGeometry(0.29, 28, 20), softShade), side * 0.78, 1.18, 0);
      cover.scale.set(0.72, 1, 1);
      const shoulderArmor=add(torso,new THREE.Mesh(new THREE.SphereGeometry(.285,36,22,0,Math.PI*2,0,Math.PI*.55),suit),side*.8,1.2,0);
      shoulderArmor.scale.set(.72,.64,.96);shoulderArmor.rotation.z=side*.12;
    }

    // Helmet: pressure neck ring, smooth shell, metal locking ring and layered gold visor.
    const head = new THREE.Group();
    head.position.set(0, 1.87, 0);
    torso.add(head); rig.head = head;
    const neckRing = add(head, new THREE.Mesh(new THREE.TorusGeometry(0.4, 0.075, 14, 40), hardware), 0, -0.39, 0);
    neckRing.rotation.x = Math.PI / 2;
    // Separate rear pressure shell and forward visor dome prevent intersecting
    // spheres from producing the old jagged black slit at close range.
    const helmet = add(head, new THREE.Mesh(new THREE.SphereGeometry(0.56,48,32,0,Math.PI,0,Math.PI),ceramic),0,.02,0);
    helmet.scale.set(.94,1.02,.94);
    const pressureHood=add(head,new THREE.Mesh(new THREE.SphereGeometry(.39,36,24),hood),0,-.035,-.045);
    pressureHood.scale.set(.86,1,.72);
    const face=add(head,new THREE.Mesh(new THREE.SphereGeometry(.31,40,28),skin),0,-.06,-.155);
    face.scale.set(.73,.96,.54);face.renderOrder=5;
    const chin=add(head,new THREE.Mesh(new THREE.SphereGeometry(.11,28,18),skin),0,-.285,-.252);chin.scale.set(1.05,.62,.68);chin.renderOrder=5;
    for(const side of [-1,1]){
      const sclera=add(head,new THREE.Mesh(new THREE.SphereGeometry(.031,20,14),eyeWhite),side*.081,.012,-.315);
      sclera.scale.set(1.15,.62,.45);sclera.renderOrder=6;
      const iris=add(head,new THREE.Mesh(new THREE.SphereGeometry(.0135,18,12),eye),side*.081,.011,-.335);iris.scale.z=.48;iris.renderOrder=6;
      const brow=add(head,roundedBox(.105,.016,.018,.007,browMat),side*.081,.071,-.322);brow.rotation.z=side*.08;brow.renderOrder=6;
      const ear=add(head,new THREE.Mesh(new THREE.SphereGeometry(.045,20,14),skin),side*.225,-.07,-.19);ear.scale.set(.55,1,.5);ear.renderOrder=5;
    }
    const nose=add(head,new THREE.Mesh(new THREE.SphereGeometry(.026,22,16),skin),0,-.055,-.348);nose.scale.set(.78,1.08,.58);nose.renderOrder=6;
    const mouth=add(head,roundedBox(.105,.014,.018,.007,lipMat),0,-.145,-.335);mouth.renderOrder=6;
    const visorGeometry=new THREE.SphereGeometry(.53,48,30,Math.PI,Math.PI,.16,Math.PI-.32);
    const visor=add(head,new THREE.Mesh(visorGeometry,visorMat),0,.035,-.015);
    visor.scale.set(.9,.84,.78);
    visor.renderOrder=7;
    const outerVisor=add(head,new THREE.Mesh(new THREE.SphereGeometry(.538,48,30,Math.PI,Math.PI,.16,Math.PI-.32),visorGlass),0,.04,-.022);
    outerVisor.scale.set(.905,.845,.785);outerVisor.renderOrder=8;
    const visorGold = add(head, new THREE.Mesh(new THREE.TorusGeometry(0.405, 0.035, 10, 48), gold), 0, -0.02, -0.34);
    visorGold.scale.set(1, 0.73, 1); visorGold.rotation.x = 0.05;
    const brow = add(head, roundedBox(0.72, 0.09, 0.08, 0.025, softShade), 0, 0.4, -0.23);
    brow.rotation.x = -0.18;
    for (const side of [-1, 1]) {
      add(head, new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.08, 20), hardware), side * 0.48, -0.03, -0.05).rotation.z = Math.PI / 2;
    }
    const comms=add(head,roundedBox(.13,.18,.08,.03,panelMat),-.48,.13,-.03);
    add(comms,new THREE.Mesh(new THREE.CircleGeometry(.025,18),lightBlue),0,.035,-.046);

    // Portable life-support system with rounded housing, tanks, plumbing and thrusters.
    const pack = add(torso, roundedBox(.94, 1.24, .42, .15, suit), 0, .76, .64);
    const packPanel = add(pack, roundedBox(.68, .84, .06, .07, ceramic), 0, .02, .245);
    for (const x of [-0.255, 0.255]) {
      const tank = add(pack, new THREE.Mesh(new THREE.CylinderGeometry(.135,.135,.78,28),softShade),x,0,.205);
      seamRing(tank,.15,.25,seam,.015);seamRing(tank,.15,-.25,seam,.015);
      add(pack,new THREE.Mesh(new THREE.CylinderGeometry(.055,.085,.13,20),hardware),x,-.51,.22);
    }
    add(packPanel, roundedBox(0.46, 0.14, 0.025, 0.02, rubber), 0, 0.39, 0.08);
    add(packPanel, new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.025, 0.012), lightBlue), 0, 0.39, 0.105);
    for(let fin=-2;fin<=2;fin++){
      const radiator=add(packPanel,new THREE.Mesh(new THREE.BoxGeometry(.64,.035,.035),softShade),0,fin*.16,.075);
      radiator.rotation.z=.01*fin;
    }
    for(const side of [-1,1]){
      const thruster=add(pack,new THREE.Mesh(new THREE.CylinderGeometry(.075,.11,.18,24),hardware),side*.43,-.58,.29);
      thruster.rotation.x=Math.PI/2;
      add(pack,new THREE.Mesh(new THREE.TorusGeometry(.11,.02,10,28),orange),side*.42,.52,.28).rotation.x=Math.PI/2;
    }
    function hose(points) {
      return new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 28, 0.032, 8, false), rubber);
    }
    add(torso, hose([V3(-0.5,1.3,0.48),V3(-0.7,1.55,0.3),V3(-0.52,1.72,0.05)]), 0, 0, 0);
    add(torso, hose([V3(0.5,1.3,0.48),V3(0.7,1.55,0.3),V3(0.52,1.72,0.05)]), 0, 0, 0);

    flame = new THREE.Group();
    const flameOuter = add(flame, new THREE.Mesh(new THREE.ConeGeometry(0.21, 1.0, 24, 1, true), new THREE.MeshBasicMaterial({ color: 0x5a9dff, transparent: true, opacity: 0.38, blending: THREE.AdditiveBlending, depthWrite: false })), 0, -0.35, 0);
    const flameInner = add(flame, new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.68, 20), new THREE.MeshBasicMaterial({ color: 0xeaf7ff, transparent: true, opacity: 0.78, blending: THREE.AdditiveBlending, depthWrite: false })), 0, -0.2, 0);
    flameOuter.rotation.x = flameInner.rotation.x = Math.PI;
    flame.position.set(0, -0.38, 1.13); flame.visible = false; torso.add(flame);

    // Multi-layer articulated arms with fabric bellows and shaped gloves.
    function arm(side) {
      const sh = new THREE.Group(); sh.position.set(side * 0.79, 1.18, 0); torso.add(sh);
      const upper = taperedLimb(0.25, 0.205, 0.62, suit); upper.rotation.z = side * 0.03; sh.add(upper);
      seamRing(upper, 0.245, -0.09, seam, 0.018);
      if(side<0)seamRing(upper,.232,-.3,orange,.038);
      if(side>0){
        const missionPatch=add(upper,roundedBox(.16,.12,.018,.018,ceramic),0,-.23,-.225);
        add(missionPatch,new THREE.Mesh(new THREE.BoxGeometry(.14,.035,.008),red),0,-.035,-.02);
        add(missionPatch,new THREE.Mesh(new THREE.BoxGeometry(.055,.045,.008),panelMat),-.038,.026,-.02);
      }
      const el = new THREE.Group(); el.position.set(0, -0.64, 0); sh.add(el);
      const elbowBellows = add(el, new THREE.Mesh(new THREE.SphereGeometry(0.215, 28, 18), seam), 0, 0, 0); elbowBellows.scale.set(1, 0.7, 0.95);
      for (let i = -1; i <= 1; i++) seamRing(el, 0.205 - Math.abs(i) * 0.012, i * 0.055, rubber, 0.012);
      const fore = taperedLimb(0.205, 0.165, 0.56, suit); fore.position.y = -0.02; el.add(fore);
      const gauntlet=add(el,roundedBox(.31,.34,.12,.055,ceramic),0,-.37,-.18);
      if(side<0)add(gauntlet,roundedBox(.23,.055,.025,.012,orange),0,.02,-.075);
      seamRing(el, 0.17, -0.57, hardware, 0.022);
      const glove = add(el, roundedBox(0.3, 0.3, 0.24, 0.09, softShade), 0, -0.69, -0.015);
      for (let f = 0; f < 4; f++) {
        const finger = add(glove, new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.023, 0.12, 12), softShade), -0.09 + f * 0.06, -0.17, -0.03);
        finger.scale.z = 0.8;
      }
      return { sh: sh, el: el };
    }
    rig.armL = arm(-1); rig.armR = arm(1);
    rig.armL.sh.rotation.z = -0.12; rig.armR.sh.rotation.z = 0.12;

    // Hidden orbital-laser tool, rebuilt with the same PBR hardware language.
    (function buildGun() {
      const g = new THREE.Group();
      add(g, roundedBox(0.2, 0.46, 0.24, 0.045, hardware), 0, -0.12, 0);
      add(g, new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.085, 0.58, 24), hardware), 0, -0.58, 0);
      const ring = add(g, new THREE.Mesh(new THREE.TorusGeometry(0.09, 0.02, 10, 24), rubber), 0, -0.8, 0); ring.rotation.x = Math.PI / 2;
      add(g, new THREE.Mesh(new THREE.SphereGeometry(0.07, 18, 12), red), 0, -0.9, 0);
      const muzzle = new THREE.Object3D(); muzzle.position.y = -0.98; g.add(muzzle);
      g.position.set(0, -0.68, 0); g.visible = false; rig.armR.el.add(g);
      rig.gun = g; rig.gunTip = muzzle;
    })();

    // Anatomical leg taper, flexible knee bellows, protective pads and bevelled boots.
    function leg(side) {
      const hip = new THREE.Group(); hip.position.set(side * 0.3, 1.19, 0); player.add(hip);
      const hipSeal = add(hip, new THREE.Mesh(new THREE.SphereGeometry(0.285, 30, 20), seam), 0, 0, 0); hipSeal.scale.set(1, 0.78, 0.92);
      const thigh = taperedLimb(0.285, 0.235, 0.66, suit); thigh.position.y = -0.02; hip.add(thigh);
      const thighPlate=add(hip,roundedBox(.34,.42,.11,.06,ceramic),0,-.31,-.235);
      if(side>0)add(thighPlate,roundedBox(.24,.045,.025,.012,orange),0,.11,-.07);
      seamRing(thigh, 0.265, -0.12, seam, 0.018);
      const knee = new THREE.Group(); knee.position.set(0, -0.69, 0); hip.add(knee);
      const kneeBellows = add(knee, new THREE.Mesh(new THREE.SphereGeometry(0.235, 28, 18), seam), 0, 0, 0); kneeBellows.scale.set(1, 0.72, 0.95);
      for (let i = -1; i <= 1; i++) seamRing(knee, 0.225 - Math.abs(i) * 0.012, i * 0.055, rubber, 0.012);
      add(knee, roundedBox(0.34, 0.23, 0.13, 0.055, ceramic), 0, -0.02, -0.22);
      const shin = taperedLimb(0.23, 0.19, 0.58, suit); shin.position.y = -0.04; knee.add(shin);
      seamRing(knee, 0.19, -0.61, hardware, 0.022);
      const boot = add(knee, roundedBox(0.43, 0.27, 0.68, 0.085, softShade), 0, -0.73, -0.13);
      boot.rotation.x = -0.05;
      add(boot,roundedBox(.39,.16,.3,.05,ceramic),0,.035,-.3);
      add(boot, roundedBox(0.4, 0.055, 0.7, 0.018, rubber), 0, -0.16, 0);
      for(let tread=-2;tread<=2;tread++)add(boot,new THREE.Mesh(new THREE.BoxGeometry(.38,.035,.055),rubber),0,-.205,tread*.12);
      return { hip: hip, knee: knee };
    }
    rig.legL = leg(-1); rig.legR = leg(1);
  }
  // Reference-inspired expedition suit, built from scratch as a lightweight
  // articulated Three.js model. It shares no visible geometry with the former
  // white EVA suit; only the animation rig contract is retained.
  (function buildEmberAstronaut() {
    const weave=canvasTex((x,w,h)=>{
      x.fillStyle='#7a2b14';x.fillRect(0,0,w,h);
      for(let i=0;i<w;i+=3){x.fillStyle=i%6?'#943a1d':'#542011';x.fillRect(i,0,1,h);}
      for(let y=0;y<h;y+=5){x.fillStyle='rgba(235,145,85,.10)';x.fillRect(0,y,w,1);}
    },128,128);
    weave.wrapS=weave.wrapT=THREE.RepeatWrapping;weave.repeat.set(8,12);
    const under=new THREE.MeshPhysicalMaterial({color:0xb34920,map:weave,roughness:.86,metalness:.01,clearcoat:.035,clearcoatRoughness:.82});
    const flex=new THREE.MeshStandardMaterial({color:0x080a0c,roughness:.94,metalness:.01});
    const joint=new THREE.MeshStandardMaterial({color:0x4e1c11,map:weave,roughness:.94,metalness:.01});
    const utility=new THREE.MeshPhysicalMaterial({color:0x111417,roughness:.72,metalness:.12,clearcoat:.12,clearcoatRoughness:.56});
    const armor=new THREE.MeshPhysicalMaterial({color:0xa94420,roughness:.58,metalness:.1,clearcoat:.28,clearcoatRoughness:.35});
    const armorSoft=new THREE.MeshPhysicalMaterial({color:0x853016,roughness:.7,metalness:.04,clearcoat:.12,clearcoatRoughness:.52});
    const edge=new THREE.MeshPhysicalMaterial({color:0x272b2d,roughness:.48,metalness:.58,clearcoat:.24,clearcoatRoughness:.34});
    const bronze=new THREE.MeshPhysicalMaterial({color:0xb86a37,roughness:.3,metalness:.78,clearcoat:.5,clearcoatRoughness:.18});
    const visorBlack=new THREE.MeshPhysicalMaterial({color:0x010203,roughness:.035,metalness:.68,clearcoat:1,clearcoatRoughness:.008,reflectivity:1});
    const visorShell=new THREE.MeshPhysicalMaterial({color:0x17242b,roughness:.025,metalness:.18,transparent:true,opacity:.16,transmission:.12,clearcoat:1,clearcoatRoughness:.006,depthWrite:false});
    const sole=new THREE.MeshStandardMaterial({color:0x020304,roughness:.88,metalness:.05});
    const statusGlow=new THREE.MeshBasicMaterial({color:0xffb36a});

    function add(parent,mesh,x=0,y=0,z=0){mesh.position.set(x,y,z);parent.add(mesh);return mesh;}
    function roundedBox(w,h,d,r,material){
      r=Math.min(r,w*.42,h*.42);const s=new THREE.Shape();
      s.moveTo(-w/2+r,-h/2);s.lineTo(w/2-r,-h/2);s.quadraticCurveTo(w/2,-h/2,w/2,-h/2+r);
      s.lineTo(w/2,h/2-r);s.quadraticCurveTo(w/2,h/2,w/2-r,h/2);s.lineTo(-w/2+r,h/2);
      s.quadraticCurveTo(-w/2,h/2,-w/2,h/2-r);s.lineTo(-w/2,-h/2+r);s.quadraticCurveTo(-w/2,-h/2,-w/2+r,-h/2);
      const g=new THREE.ExtrudeGeometry(s,{depth:d,bevelEnabled:true,bevelSegments:3,bevelSize:r*.24,bevelThickness:r*.24,curveSegments:7});
      g.translate(0,0,-d/2);return new THREE.Mesh(g,material);
    }
    function lathe(profile,material){return new THREE.Mesh(new THREE.LatheGeometry(profile.map(p=>new THREE.Vector2(p[0],p[1])),44),material);}
    function ring(parent,r,y,material,t=.018){const m=add(parent,new THREE.Mesh(new THREE.TorusGeometry(r,t,8,32),material),0,y,0);m.rotation.x=Math.PI/2;return m;}
    // Build a closed, UV-mapped elliptical loft from hand-authored body
    // sections. Unlike a scaled cylinder, every section can change width,
    // front/back depth and centre independently, which gives the suit an
    // anatomical silhouette while remaining one efficient indexed mesh.
    function loft(profile,segments,material,shapePower=1){
      const positions=[],uvs=[],indices=[];
      for(let i=0;i<profile.length;i++){
        const s=profile[i],v=i/(profile.length-1);
        for(let j=0;j<segments;j++){
          const u=j/segments,a=u*Math.PI*2,c=Math.cos(a),sn=Math.sin(a);
          const px=Math.sign(c)*Math.pow(Math.abs(c),shapePower)*s[1];
          const pz=Math.sign(sn)*Math.pow(Math.abs(sn),shapePower)*s[2]+(s[3]||0);
          positions.push(px,s[0],pz);uvs.push(u,v);
        }
      }
      for(let i=0;i<profile.length-1;i++)for(let j=0;j<segments;j++){
        const a=i*segments+j,b=i*segments+(j+1)%segments,c=(i+1)*segments+(j+1)%segments,d=(i+1)*segments+j;
        indices.push(a,b,d,b,c,d);
      }
      const bottom=positions.length/3;positions.push(0,profile[0][0],profile[0][3]||0);uvs.push(.5,0);
      const top=positions.length/3,last=profile.length-1;positions.push(0,profile[last][0],profile[last][3]||0);uvs.push(.5,1);
      for(let j=0;j<segments;j++){
        const next=(j+1)%segments;
        indices.push(bottom,next,j);
        indices.push(top,last*segments+j,last*segments+next);
      }
      const geometry=new THREE.BufferGeometry();
      geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
      geometry.setAttribute('uv',new THREE.Float32BufferAttribute(uvs,2));
      geometry.setIndex(indices);geometry.computeVertexNormals();geometry.computeBoundingSphere();
      return new THREE.Mesh(geometry,material);
    }
    function tapered(top,bottom,length,material,depth=.88){
      const g=new THREE.Group();
      // Muscle and garment volume change independently down the limb. The
      // slight forward bow keeps elbows and knees from reading as straight
      // mechanical pistons when the animation is at rest.
      add(g,loft([
        [0,top*.93,top*depth*.92,0],
        [-length*.12,top*1.04,top*depth, -.008],
        [-length*.38,top*.98,(top*.9)*depth,-.016],
        [-length*.68,bottom*1.08,bottom*depth*.98,-.012],
        [-length,bottom*.94,bottom*depth*.9,0]
      ],24,material,.9));
      return g;
    }
    function armorPanel(parent,w,h,d,x,y,z,rz=0,material=armor){const p=add(parent,roundedBox(w,h,d,Math.min(w,h)*.13,material),x,y,z);p.rotation.z=rz;return p;}
    function hose(points,r=.022){return new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points),30,r,8,false),flex);}

    // Narrow armored pelvis and equipment belt establish adult human proportions.
    const pelvis=add(player,lathe([[.35,0],[.44,.08],[.49,.28],[.45,.48],[.36,.56]],under),0,.92,0);pelvis.scale.z=.72;
    armorPanel(player,.7,.32,.17,0,1.13,-.24,0,armorSoft);
    const belt=add(player,new THREE.Mesh(new THREE.TorusGeometry(.45,.065,10,42),flex),0,1.48,0);belt.rotation.x=Math.PI/2;belt.scale.z=.77;
    const buckle=armorPanel(player,.28,.18,.09,0,1.48,-.43,0,edge);armorPanel(buckle,.16,.075,.018,0,0,-.062,0,armor);
    for(const side of [-1,1]){
      armorPanel(player,.22,.28,.13,side*.43,1.43,-.05,side*.06,utility);
      armorPanel(player,.17,.22,.12,side*.35,1.45,.34,side*-.04,utility);
    }

    // Continuous pressure garment with thin protective chest inserts. Keeping
    // these surfaces close to the body avoids the segmented robot silhouette.
    const torso=new THREE.Group();torso.position.set(0,1.55,0);player.add(torso);rig.torso=torso;
    const abdomen=add(torso,loft([
      [.05,.34,.245,.025],[.17,.40,.275,.025],[.38,.445,.305,.018],
      [.62,.475,.335,.005],[.84,.54,.375,-.012],[1.06,.585,.395,-.02],
      [1.25,.525,.355,-.01],[1.40,.405,.29,.015]
    ],36,under,.86));
    for(let i=0;i<3;i++)ring(torso,.405+i*.01,.24+i*.15,armorSoft,.01);
    armorPanel(torso,.3,.52,.035,-.2,1.02,-.447,-.1,armor);
    armorPanel(torso,.3,.52,.035,.2,1.02,-.447,.1,armor);
    armorPanel(torso,.41,.24,.04,0,.7,-.49,0,under);
    armorPanel(torso,.3,.17,.038,0,1.31,-.42,0,armor);
    // Floating clavicle and lower-rib shells break the flat vest surface into
    // overlapping load-bearing pieces with small expansion gaps.
    for(const side of [-1,1]){
      const clavicle=armorPanel(torso,.35,.14,.055,side*.205,1.27,-.43,side*-.16,armorSoft);
      clavicle.rotation.x=side*.018;
      for(let row=0;row<3;row++){
        const rib=armorPanel(torso,.31-row*.018,.075,.038,side*(.19+row*.008),.81-row*.105,-.445,side*(.08+row*.015),armorSoft);
        rib.rotation.x=-.04;
      }
    }
    const sternum=armorPanel(torso,.105,.58,.055,0,1.02,-.474,0,edge);
    for(let i=0;i<4;i++)add(sternum,new THREE.Mesh(new THREE.CylinderGeometry(.011,.011,.018,10),bronze),0,-.21+i*.14,-.04).rotation.x=Math.PI/2;
    // Low-profile black restraint harness over the pressure shell.
    armorPanel(torso,.055,.98,.026,-.22,.99,-.57,-.31,utility);
    armorPanel(torso,.055,.98,.026,.22,.99,-.57,.31,utility);
    armorPanel(torso,.62,.052,.026,0,.72,-.585,0,utility);
    for(const side of [-1,1]){
      const rail=armorPanel(torso,.04,.98,.02,side*.39,.96,-.575,side*-.13,utility);
      for(let i=0;i<2;i++)add(rail,new THREE.Mesh(new THREE.CylinderGeometry(.015,.015,.014,12),bronze),0,-.25+i*.5,-.025).rotation.x=Math.PI/2;
    }
    const chestModule=armorPanel(torso,.2,.25,.085,0,1.03,-.63,0,utility);
    armorPanel(chestModule,.075,.09,.018,0,.02,-.055,0,statusGlow);

    // Rounded textile shoulders, with only a thin abrasion cap.
    for(const side of [-1,1]){
      const socket=add(torso,new THREE.Mesh(new THREE.SphereGeometry(.275,32,22),under),side*.69,1.22,0);socket.scale.set(.72,1,.86);
      const cap=add(torso,new THREE.Mesh(new THREE.SphereGeometry(.34,36,24,0,Math.PI*2,0,Math.PI*.56),armorSoft),side*.73,1.3,0);cap.scale.set(.66,.34,.68);cap.rotation.z=side*.18;
    }

    // A close-fitting dark life-support spine preserves the human back shape;
    // it does not read as a large toy-like capsule from the normal chase camera.
    const pack=add(torso,new THREE.Mesh(new THREE.SphereGeometry(.5,40,28),utility),0,.84,.41);
    pack.scale.set(.5,.72,.24);
    armorPanel(torso,.24,.58,.045,0,.84,.54,0,utility);
    for(let i=-2;i<=2;i++)armorPanel(torso,.28,.022,.016,0,.58+i*.12,.57,0,edge);
    armorPanel(torso,.12,.5,.04,-.19,.84,.52,-.06,utility);
    armorPanel(torso,.12,.5,.04,.19,.84,.52,.06,utility);
    for(const side of [-1,1]){
      const nozzle=add(torso,new THREE.Mesh(new THREE.CylinderGeometry(.05,.075,.14,20),edge),side*.27,.39,.61);nozzle.rotation.x=Math.PI/2;
    }

    // Large uninterrupted visor and soft orange helmet shell. The convex oval
    // is a complete front lens rather than a partial sphere, so it stays visible
    // from normal third-person camera angles.
    const head=new THREE.Group();head.position.set(0,1.92,0);torso.add(head);rig.head=head;
    for(let i=0;i<4;i++)ring(head,.315+i*.012,-.38+i*.065,flex,.023);
    const helmet=add(head,loft([
      [-.43,.30,.27,.08],[-.34,.40,.36,.05],[-.16,.48,.43,.025],
      [.08,.50,.46,.015],[.31,.43,.405,.035],[.49,.25,.25,.06]
    ],48,armorSoft,.92));
    // A true convex half-dome replaces the former paper-thin flattened sphere.
    // Its changing surface normals produce a continuous reflected horizon and
    // retain the visor silhouette from side and three-quarter views.
    const visorGeometry=new THREE.SphereGeometry(.475,64,36,Math.PI,Math.PI,.12,Math.PI-.24);
    const visor=add(head,new THREE.Mesh(visorGeometry,visorBlack),0,.055,-.01);visor.scale.set(.94,1.04,.86);
    const glassGeometry=new THREE.SphereGeometry(.482,64,36,Math.PI,Math.PI,.12,Math.PI-.24);
    const glass=add(head,new THREE.Mesh(glassGeometry,visorShell),0,.058,-.014);glass.scale.set(.945,1.045,.865);glass.renderOrder=8;
    const visorRim=add(head,new THREE.Mesh(new THREE.TorusGeometry(.425,.027,12,64),bronze),0,.045,-.43);visorRim.scale.y=1.08;
    const brow=add(head,new THREE.Mesh(new THREE.TorusGeometry(.432,.016,10,56,Math.PI),armor),0,.06,-.438);brow.rotation.z=Math.PI;
    const reflection=new THREE.MeshBasicMaterial({color:0xffe2bf,transparent:true,opacity:.2,depthWrite:false,blending:THREE.AdditiveBlending});
    const visorGlint=add(head,new THREE.Mesh(new THREE.CircleGeometry(.12,32),reflection),-.16,.22,-.505);visorGlint.scale.set(.62,1.5,1);visorGlint.rotation.z=-.32;visorGlint.renderOrder=9;
    for(const side of [-1,1]){
      const hinge=add(head,new THREE.Mesh(new THREE.CylinderGeometry(.07,.07,.08,24),bronze),side*.45,.01,0);hinge.rotation.z=Math.PI/2;
      const temple=armorPanel(head,.07,.36,.06,side*.425,.03,-.315,side*.045,edge);temple.rotation.x=-.08;
      add(head,hose([V3(side*.35,-.28,.15),V3(side*.49,-.45,.08),V3(side*.43,-.58,-.02)]),0,0,0);
    }
    const chinGuard=armorPanel(head,.42,.105,.075,0,-.37,-.295,0,armorSoft);chinGuard.rotation.x=-.16;
    armorPanel(chinGuard,.18,.035,.025,0,0,-.055,0,bronze);
    for(const x of [-.12,.12]){
      const intake=add(head,new THREE.Mesh(new THREE.CylinderGeometry(.025,.025,.028,14),edge),x,-.31,-.39);intake.rotation.x=Math.PI/2;
    }

    // Long, human-proportioned arms with the under-suit visible at the joints.
    function arm(side){
      const sh=new THREE.Group();sh.position.set(side*.73,1.22,0);torso.add(sh);
      const upper=tapered(.215,.18,.66,under,.83);upper.rotation.z=side*.025;sh.add(upper);
      armorPanel(upper,.28,.38,.045,0,-.25,-.205,side*.025,armorSoft);ring(upper,.205,-.08,armorSoft,.012);
      armorPanel(upper,.095,.34,.038,side*.165,-.28,-.035,side*.02,utility);
      const el=new THREE.Group();el.position.set(0,-.68,0);sh.add(el);
      const elbow=add(el,new THREE.Mesh(new THREE.SphereGeometry(.19,28,18),joint));elbow.scale.set(1,.7,.88);
      for(let i=-2;i<=2;i++)ring(el,.175-Math.abs(i)*.008,i*.036,joint,.009);
      for(const flank of [-1,1]){
        const pivot=add(el,new THREE.Mesh(new THREE.CylinderGeometry(.075,.075,.035,20),edge),flank*.172,0,0);pivot.rotation.z=Math.PI/2;
        add(pivot,new THREE.Mesh(new THREE.CylinderGeometry(.034,.034,.04,16),bronze),0,.02,0).rotation.z=Math.PI/2;
      }
      const fore=tapered(.18,.145,.6,under,.82);fore.position.y=-.025;el.add(fore);
      armorPanel(el,.27,.42,.05,0,-.34,-.19,side*.02,armorSoft);
      armorPanel(el,.08,.34,.04,side*.145,-.34,-.025,side*-.02,utility);
      ring(el,.15,-.61,utility,.014);
      const glove=new THREE.Group();glove.position.set(0,-.69,-.018);el.add(glove);
      add(glove,loft([[0,.145,.12,0],[-.10,.158,.13,-.012],[-.22,.13,.105,-.025]],20,utility,.82));
      armorPanel(glove,.22,.12,.035,0,-.095,-.13,0,armorSoft);
      for(let f=0;f<4;f++){
        const finger=tapered(.024,.017,.17-(Math.abs(1.5-f)*.012),utility,.82);
        finger.position.set(-.073+f*.049,-.205,-.025);finger.rotation.x=-.09-Math.abs(1.5-f)*.018;glove.add(finger);
      }
      const thumb=tapered(.031,.02,.16,utility,.86);thumb.position.set(side*.145,-.095,-.005);thumb.rotation.z=side*-.72;thumb.rotation.x=-.22;glove.add(thumb);
      return {sh,el};
    }
    rig.armL=arm(-1);rig.armR=arm(1);rig.armL.sh.rotation.z=-.1;rig.armR.sh.rotation.z=.1;

    // Hidden tool retains the existing laser gameplay while matching the suit.
    (function buildGun(){
      const g=new THREE.Group();armorPanel(g,.17,.4,.19,0,-.12,0,0,armor);
      add(g,new THREE.Mesh(new THREE.CylinderGeometry(.045,.06,.54,22),edge),0,-.54,0);
      const muzzle=new THREE.Object3D();muzzle.position.y=-.86;g.add(muzzle);g.position.set(0,-.7,0);g.visible=false;rig.armR.el.add(g);rig.gun=g;rig.gunTip=muzzle;
    })();

    // Long legs, strapped thigh equipment, articulated knees and plated boots.
    function leg(side){
      const hip=new THREE.Group();hip.position.set(side*.245,1.18,0);player.add(hip);
      const hipJoint=add(hip,new THREE.Mesh(new THREE.SphereGeometry(.25,30,20),under));hipJoint.scale.set(1,.75,.82);
      const thigh=tapered(.25,.205,.72,under,.78);thigh.position.y=-.02;hip.add(thigh);
      armorPanel(hip,.32,.48,.05,0,-.34,-.205,side*.025,armorSoft);ring(thigh,.225,-.12,armorSoft,.011);
      const thighPouch=armorPanel(hip,.18,.32,.13,side*.19,-.37,.02,side*.04,utility);
      ring(thighPouch,.095,-.13,bronze,.012);
      const knee=new THREE.Group();knee.position.set(0,-.75,0);hip.add(knee);
      const kneeJoint=add(knee,new THREE.Mesh(new THREE.SphereGeometry(.205,28,18),joint));kneeJoint.scale.set(1,.7,.84);
      for(let i=-2;i<=2;i++)ring(knee,.19-Math.abs(i)*.008,i*.035,joint,.009);
      armorPanel(knee,.32,.25,.07,0,-.01,-.2,0,armorSoft);
      for(const flank of [-1,1]){
        const kneePivot=add(knee,new THREE.Mesh(new THREE.CylinderGeometry(.085,.085,.042,22),edge),flank*.19,-.005,0);kneePivot.rotation.z=Math.PI/2;
        add(kneePivot,new THREE.Mesh(new THREE.CylinderGeometry(.038,.038,.048,16),bronze),0,.024,0).rotation.z=Math.PI/2;
      }
      const shin=tapered(.205,.165,.67,under,.78);shin.position.y=-.035;knee.add(shin);
      armorPanel(knee,.29,.53,.05,0,-.38,-.19,0,armorSoft);ring(knee,.17,-.68,utility,.014);
      const boot=new THREE.Group();boot.position.set(0,-.79,-.08);boot.rotation.x=-.055;knee.add(boot);
      add(boot,loft([[.13,.17,.15,.08],[.02,.19,.19,.03],[-.15,.195,.205,-.02]],22,utility,.82));
      const foot=armorPanel(boot,.38,.22,.58,0,-.18,-.14,0,utility);
      const toe=add(boot,new THREE.Mesh(new THREE.SphereGeometry(.205,28,18),armorSoft),0,-.16,-.43);toe.scale.set(.94,.58,1.05);
      armorPanel(foot,.32,.11,.25,0,.025,-.27,0,armorSoft);
      armorPanel(boot,.40,.06,.66,0,-.31,-.10,0,sole);
      armorPanel(boot,.38,.14,.15,0,-.22,.22,0,sole);
      for(const sideRail of [-1,1])armorPanel(boot,.035,.17,.5,sideRail*.19,-.18,-.11,0,edge);
      for(let i=-2;i<=2;i++)add(boot,new THREE.Mesh(new THREE.BoxGeometry(.36,.03,.045),sole),0,-.35,-.1+i*.1);
      return {hip,knee};
    }
    rig.legL=leg(-1);rig.legR=leg(1);

    flame=new THREE.Group();
    const outer=add(flame,new THREE.Mesh(new THREE.ConeGeometry(.16,.82,22,1,true),new THREE.MeshBasicMaterial({color:0x547dff,transparent:true,opacity:.3,blending:THREE.AdditiveBlending,depthWrite:false})),0,-.28,0);
    const inner=add(flame,new THREE.Mesh(new THREE.ConeGeometry(.07,.52,18),new THREE.MeshBasicMaterial({color:0xeaf4ff,transparent:true,opacity:.75,blending:THREE.AdditiveBlending,depthWrite:false})),0,-.15,0);
    outer.rotation.x=inner.rotation.x=Math.PI;flame.position.set(0,-.28,.79);flame.visible=false;torso.add(flame);
  })();

  // The visible player is a genuinely rigged, authored character. Its source
  // GLB contains a 94-bone humanoid skeleton (including five articulated
  // fingers per hand) and motion-captured animation clips. No runtime vertex
  // classification or synthetic skinning is used here.
  const proceduralCharacterRoots=player.children.slice();
  let authoredSuitRoot=null,authoredSuitModel=null,authoredSuitMixer=null;
  let authoredSuitAction=null,authoredLaserTool=null;
  const authoredSuitActions={};
  const authoredSuitBones={};
  const authoredRepulsors=[];
  let characterMotion=null,repulsorBlend=0;
  let spacePoseBlend=0;
  const flightLocalDirection=new THREE.Vector3(),flightInverse=new THREE.Quaternion();
  const repulsorAxis=new THREE.Vector3(0,-1,0);
  const repulsorDirection=new THREE.Vector3(),repulsorPosition=new THREE.Vector3();
  const repulsorAverage=new THREE.Vector3(),repulsorFrame=new THREE.Quaternion();
  const repulsorLight=new THREE.PointLight(0x65bfff,0,8,2);
  scene.add(repulsorLight);

  function createAuthoredRepulsor(bone,type,side){
    if(!bone)return;
    const locator=window.GodmanRepulsorAnchor(authoredSuitRoot,bone,type);
    const fx=new THREE.Group();fx.visible=false;scene.add(fx);
    const plume=window.GodmanRepulsorPlume(type);
    const nozzle=new THREE.Mesh(new THREE.SphereGeometry(type==='hand'?.031:.044,12,8),
      new THREE.MeshBasicMaterial({color:0xd8efff,transparent:true,depthWrite:false,blending:THREE.AdditiveBlending}));
    nozzle.scale.y=.28;
    fx.add(plume,nozzle);
    authoredRepulsors.push({locator,fx,plume,nozzle,type});
  }

  function updateAuthoredRepulsors(dt,active){
    const braking=!grounded&&!earthInWater?flightBrake:0;
    repulsorBlend=damp(repulsorBlend,active?Math.max(.25,flightThrottle):braking*.65,active?8:12,dt);
    if(!authoredRepulsors.length)return;
    player.updateMatrixWorld(true);
    repulsorAverage.set(0,0,0);
    // Exhaust follows each actual palm/sole normal, including wrist steering.
    let count=0;
    for(const r of authoredRepulsors){
      r.locator.getWorldPosition(repulsorPosition);
      r.fx.position.copy(repulsorPosition);
      r.locator.parent.getWorldQuaternion(repulsorFrame);
      repulsorDirection.copy(r.locator.userData.exhaustAxis).applyQuaternion(repulsorFrame).normalize();
      r.fx.quaternion.setFromUnitVectors(repulsorAxis,repulsorDirection);
      const side=r.locator.parent.name.startsWith('L')?1:-1;
      const strength=repulsorBlend*(characterMotion?characterMotion.nozzleShare(r.type,side):1);
      r.fx.visible=strength>.012;
      r.fx.scale.setScalar(1);
      r.plume.scale.set(1+spacePoseBlend*.22,.25+strength*.95,1+spacePoseBlend*.22);
      r.plume.userData.material.uniforms.strength.value=strength;
      r.plume.userData.material.uniforms.time.value=elapsed;
      r.nozzle.material.opacity=strength;
      if(r.fx.visible){repulsorAverage.add(repulsorPosition);count++;}
    }
    if(count){repulsorLight.position.copy(repulsorAverage).multiplyScalar(1/count);}
    repulsorLight.intensity=count?repulsorBlend*2.1:0;
  }
  function useAuthoredSuitAction(name,fade=.3,speed=1,delta=.016){
    const next=authoredSuitActions[name];
    if(!next)return;
    if(next===authoredSuitAction){
      next.timeScale=damp(next.timeScale||speed,speed,5,Math.min(.05,delta));
      return;
    }
    next.reset();
    next.timeScale=speed;
    next.setEffectiveWeight(1).play();
    if(authoredSuitAction)authoredSuitAction.crossFadeTo(next,fade,true);
    authoredSuitAction=next;
  }
  function loadAuthoredAstronaut(){
    if(!THREE.GLTFLoader)return;
    const loader=new THREE.GLTFLoader();
    loader.load('assets/character/rigged-astronaut.glb',gltf=>{
      const model=gltf.scene;
      model.traverse(o=>{
        if(!o.isMesh)return;
        o.castShadow=true;o.receiveShadow=true;o.frustumCulled=false;
        const materials=Array.isArray(o.material)?o.material:[o.material];
        for(const m of materials){
          if(!m)continue;
          if(m.color&&m.map){
            // Tint the authored white fabric toward the burnt-orange suit in
            // the visual reference while retaining its baked seams, folds,
            // fasteners, normal map and roughness variation.
            m.color.set(0xc45a2a);
          }
          m.side=THREE.FrontSide;m.transparent=false;m.opacity=1;
          m.depthWrite=true;m.needsUpdate=true;
        }
      });
      model.updateMatrixWorld(true);
      const initialBox=new THREE.Box3().setFromObject(model);
      const initialSize=initialBox.getSize(new THREE.Vector3());
      const fit=4.48/Math.max(initialSize.y,.001);
      model.scale.setScalar(fit);model.updateMatrixWorld(true);
      const box=new THREE.Box3().setFromObject(model);
      const center=box.getCenter(new THREE.Vector3());
      model.position.x-=center.x;
      model.position.z-=center.z;
      model.position.y+=-.62-box.min.y;
      // The authored character faces +Z while the controller treats -Z as
      // forward. Rotate the imported visual once; physics and camera axes stay
      // untouched.
      const visual=new THREE.Group();visual.rotation.y=Math.PI;visual.add(model);
      player.add(visual);
      authoredSuitRoot=visual;authoredSuitModel=model;
      for(const root of proceduralCharacterRoots)root.visible=false;
      model.traverse(b=>{if(b.isBone)b.userData.motionBindQuaternion=b.quaternion.clone();});
      authoredSuitMixer=new THREE.AnimationMixer(model);
      const loadedBones=[];
      model.traverse(o=>{if(o.isBone){loadedBones.push(o);authoredSuitBones[o.name]=o;}});
      const canonicalBoneNames=['L_Arm.10','L_Elbow.11','L_Wrist.12','R_Arm.44','R_Elbow.45','R_Wrist.46',
        'L_Thigh.82','L_Knee.83','L_Ankle.84','R_Thigh.88','R_Knee.89','R_Ankle.90'];
      for(const expected of canonicalBoneNames){
        const stem=expected.slice(0,expected.lastIndexOf('.'));
        authoredSuitBones[expected]=loadedBones.find(b=>b.name===expected||b.name===expected.replace(/\./g,'_')||
          b.name===stem||b.name.startsWith(stem))||null;
      }
      for(const clip of gltf.animations){
        const key=(clip.name||'').toLowerCase();
        authoredSuitActions[key]=authoredSuitMixer.clipAction(clip);
      }
      useAuthoredSuitAction('idle',0,1);
      authoredSuitMixer.update(0);
      player.updateMatrixWorld(true);
      characterMotion=new window.GodmanCharacterMotion(visual,authoredSuitBones);
      createAuthoredRepulsor(authoredSuitBones['L_Wrist.12'],'hand',-1);
      createAuthoredRepulsor(authoredSuitBones['R_Wrist.46'],'hand',1);
      createAuthoredRepulsor(authoredSuitBones['L_Ankle.84'],'foot',-1);
      createAuthoredRepulsor(authoredSuitBones['R_Ankle.90'],'foot',1);

      // Parent the tool to the model's authored wrist bone rather than to an
      // approximation, so it follows every embedded animation exactly.
      const toolPivot=new THREE.Group();
      const wrist=authoredSuitBones['R_Wrist.46'];
      if(wrist)wrist.add(toolPivot);else visual.add(toolPivot);
      toolPivot.position.set(.01,.055,.025);toolPivot.rotation.set(0,0,-Math.PI*.5);
      const toolMat=new THREE.MeshPhysicalMaterial({color:0x15191d,roughness:.38,metalness:.62,clearcoat:.34,clearcoatRoughness:.24});
      const toolAccent=new THREE.MeshStandardMaterial({color:0xc65b28,roughness:.48,metalness:.22});
      const body=new THREE.Mesh(new THREE.BoxGeometry(.085,.20,.08),toolMat);body.position.set(0,-.10,.01);toolPivot.add(body);
      const barrel=new THREE.Mesh(new THREE.CylinderGeometry(.022,.027,.28,18),toolAccent);barrel.position.set(0,-.27,.01);toolPivot.add(barrel);
      const emitter=new THREE.Object3D();emitter.position.set(0,-.43,.01);toolPivot.add(emitter);rig.gunTip=emitter;
      authoredLaserTool=toolPivot;authoredLaserTool.visible=laserEquipped;
      toast('Rigged astronaut · authored motion loaded');
    },undefined,error=>{
      // The handcrafted rig remains a complete offline fallback.
      authoredSuitRoot=null;authoredSuitMixer=null;
      console.error('Rigged astronaut failed to load',error);
      toast('Rigged suit unavailable · using local fallback');
    });
  }
  loadAuthoredAstronaut();
  scene.add(player);

  // A compact studio-style light rig follows the astronaut. It adds readable
  // fabric folds, metal highlights and soft self-shadowing without a heavy
  // imported model or additional animation runtime.
  player.traverse(o => {
    if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
  });
  const characterKey = new THREE.DirectionalLight(0xfff4df, 1.15);
  characterKey.castShadow = true;
  characterKey.shadow.mapSize.set(1024,1024);
  characterKey.shadow.camera.left = characterKey.shadow.camera.bottom = -4.8;
  characterKey.shadow.camera.right = characterKey.shadow.camera.top = 4.8;
  characterKey.shadow.camera.near = 0.1; characterKey.shadow.camera.far = 28;
  characterKey.shadow.bias = -0.00035;
  const characterLightTarget = new THREE.Object3D();
  scene.add(characterKey,characterLightTarget);
  characterKey.target = characterLightTarget;
  const characterRim = new THREE.PointLight(0xa9c8e8,0.36,18,2);
  scene.add(characterRim);
  const physicalLighting=new window.GodmanPhysicalLighting(THREE,renderer,CONFIG.lighting,{
    ambient:ambient,sky:skyLight,key:characterKey,rim:characterRim,headlamp:headlamp
  });

  const PLAYER_FEET = 0.3;
  // Ground speed matches the retargeted suit's stride. Shared with the studio
  // so the preview and game do not show different foot-contact velocities.
  const WALK_SPEED = (window.GodmanMotionSettings||{}).walkSpeed||1.8;
  const RUN_SPEED = (window.GodmanMotionSettings||{}).runSpeed||4.4;
  const JUMP_MIN = 6;
  const JUMP_MAX = 12000;
  const CHARGE_TIME = 1.6;
  const FUEL_MAX = 100;
  const FUEL_REFILL_GROUND = 60;
  const FUEL_REFILL_AIR = 30;
  const FUEL_REGEN_DELAY = 2.5;
  const C_WORLD = 29979245.8;

  // ---------- State ----------
  const pos = new THREE.Vector3();
  const vel = new THREE.Vector3();
  const groundMotion = new THREE.Vector3();
  const prevPos = new THREE.Vector3();
  let grounded = true;
  let groundPlanet = earth;
  const up = V3(0, 1, 0);
  const smoothUp = V3(0, 1, 0);
  const fwdRef = V3(0, 0, -1);
  let yaw = 0, pitch = 0.3;
  let charge = 0, charging = false;
  let fuel = FUEL_MAX;
  let lastThrustTime = -99;
  let camDist = 8, camDistTarget = 8;
  let earthInWater = false;
  const camDir = V3(0, 0, -1);
  const activeThrustDirection=V3(0,0,-1);
  const lastFacing = V3(0, 0, -1);
  let walkPhase = 0, squash = 0, wasGrounded = true, groundSpeedNow = 0;
  let takeoffBlend = 0, landingImpact = 0, airborneTime = 0;
  let landingAge=99,landingStrength=0,swimBlend=0;
  const landingSlide=new THREE.Vector3();
  let flightThrottle=0,flightBrake=0;
  let jumpGrace = 0;
  let airCarry = null;   // the planet whose rotating frame we move in
  let lean = 0;
  let target = null;
  let approachAssist = 0;
  const approachTo=new THREE.Vector3(),approachDir=new THREE.Vector3();
  const approachVelocity=new THREE.Vector3(),approachLateral=new THREE.Vector3();
  let finderOpen = false;
  let lastFire = -9;
  const asteroids = [];
  // ---------- Orbital laser (the one science-fiction tool) ----------
  let laserEquipped = false, laserFiring = false, laserBeam = null, laserGlow = null;
  let laserHeatTarget=null,laserHeat=0;
  let lastLaserDeform=-99;
  const LASER_HEAT_TIME=2.6;
  const LASER_DEFORM_INTERVAL=.16;
  function ensureLaser() {
    if (laserBeam) return;
    const g = new THREE.CylinderGeometry(1, 1, 1, 10, 1, true);
    g.translate(0, 0.5, 0); // base at origin, grows along +Y
    laserBeam = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
      color: 0xffa15c, transparent: true, opacity: 0.68,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    laserBeam.renderOrder = 999; laserBeam.frustumCulled = false; laserBeam.visible = false;
    scene.add(laserBeam);
    laserGlow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: softSprite('rgba(255,235,200,1)', 'rgba(255,50,20,0.5)'),
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    laserGlow.visible = false; scene.add(laserGlow);
  }
  function toggleLaser() {
    laserEquipped = !laserEquipped; laserFiring = false;
    laserHeatTarget=null;laserHeat=0;
    const ch = document.getElementById('crosshair');
    if (ch) ch.style.borderColor = laserEquipped ? '#ff3020' : 'rgba(255,255,255,.7)';
    if (rig.gun) rig.gun.visible = laserEquipped;
    if (authoredLaserTool) authoredLaserTool.visible = laserEquipped;
    if (laserBeam) laserBeam.visible = false;
    if (laserGlow) laserGlow.visible = false;
    toast(laserEquipped?'Laser armed · hold click to fire':'Laser stowed');
  }
  const booms = [];
  let lastAtmoMat = null;
  let mouseSens = 0.0024, invertY = false;
  let overview = false, oyaw = 0, opitch = 0.5, overviewDist = 1e7, overviewZoomTarget = 1e7;

  // achievements (persisted)
  let visited = new Set(['Earth']);
  try {
    const saved = JSON.parse(localStorage.getItem('we_visited') || '[]');
    for (const n of saved) visited.add(n);
  } catch (e) {}
  function saveVisited() {
    try { localStorage.setItem('we_visited', JSON.stringify([...visited])); } catch (e) {}
  }

  // ---------- Land sampling ----------
  let earthSpawnFacing=null;
  function planetImgData(p) {
    if (p._imgData === undefined) {
      const img = p.tex.image;
      if (p.landFn && img && img.getContext) {
        try {
          p._imgData = { d: img.getContext('2d').getImageData(0, 0, img.width, img.height).data, w: img.width, h: img.height };
        } catch (e) { p._imgData = null; }
      } else p._imgData = null;
    }
    return p._imgData;
  }
  function sampleIsLand(p, n) {
    const id = planetImgData(p);
    if (!id) return true;
    tmpQ.copy(p.mesh.quaternion).invert();
    tmpV3.copy(n).applyQuaternion(tmpQ);
    const lx = tmpV3.x, ly = tmpV3.y, lz = tmpV3.z;
    const theta = Math.acos(Math.max(-1, Math.min(1, ly)));
    let phi = Math.atan2(lz, -lx);
    if (phi < 0) phi += Math.PI * 2;
    const pxl = Math.min(id.w - 1, Math.floor(phi / (Math.PI * 2) * id.w));
    const pyl = Math.min(id.h - 1, Math.floor(theta / Math.PI * id.h));
    const idx = (pyl * id.w + pxl) * 4;
    return p.landFn(id.d[idx], id.d[idx + 1], id.d[idx + 2]);
  }
  function findSpawnNormal(p) {
    const starC = nearestStarTo(p.center).center;
    const dirSun = new THREE.Vector3().copy(starC).sub(p.center).normalize();
    const n = new THREE.Vector3();
    let bestMountain=null,bestFacing=null,bestRise=-Infinity;
    const tangent=new THREE.Vector3(),side=new THREE.Vector3(),candidate=new THREE.Vector3(),neighbor=new THREE.Vector3(),axisUp=V3(0,1,0),axisX=V3(1,0,0);
    if(p===earth&&earthElevation.ready){
      // Real foothill/high-range pairs found directly in the NASA grid. Pick
      // whichever location is currently best lit, then face the measured rise.
      const sites=EARTH_MOUNTAIN_SITES;
      let chosen=null,chosenHigh=null,bestLight=-2;
      for(const s of sites){
        const lon=(s.baseLon+180)/360*Math.PI*2,lat=s.baseLat*Math.PI/180,cl=Math.cos(lat);
        const local=V3(-Math.cos(lon)*cl,Math.sin(lat),Math.sin(lon)*cl);
        const world=local.clone().applyQuaternion(earth.mesh.quaternion).normalize();
        const lonH=(s.peakLon+180)/360*Math.PI*2,latH=s.peakLat*Math.PI/180,clH=Math.cos(latH);
        const high=V3(-Math.cos(lonH)*clH,Math.sin(latH),Math.sin(lonH)*clH).applyQuaternion(earth.mesh.quaternion).normalize();
        const light=world.dot(dirSun);
        if(light>bestLight){bestLight=light;chosen=world;chosenHigh=high;}
      }
      earthSpawnFacing=chosenHigh.clone().addScaledVector(chosen,-chosenHigh.dot(chosen)).normalize();
      return chosen;
    }
    const tries=p===earth&&earthElevation.ready?9000:4000;
    for (let i = 0; i < tries; i++) {
      let x, y, z, l;
      do { x = Math.random()*2-1; y = Math.random()*2-1; z = Math.random()*2-1; l = x*x+y*y+z*z; } while (l > 1 || l < 1e-4);
      n.set(x, y, z).normalize();
      if (n.dot(dirSun) < 0.45) continue;
      if (Math.abs(n.y) > 0.75) continue;
      if(p===earth&&earthElevation.ready){
        const base=earthElevationAtWorld(n);if(base<3||base>145)continue;
        side.crossVectors(n,axisUp);if(side.lengthSq()<1e-5)side.crossVectors(n,axisX);side.normalize();
        tangent.crossVectors(side,n).normalize();
        let localHigh=base,localFacing=null;
        for(let k=0;k<12;k++){
          const a=k/12*Math.PI*2,dir=candidate.copy(tangent).multiplyScalar(Math.cos(a)).addScaledVector(side,Math.sin(a)).normalize();
          const angle=.0125;
          neighbor.copy(n).multiplyScalar(Math.cos(angle)).addScaledVector(dir,Math.sin(angle)).normalize();
          const high=earthElevationAtWorld(neighbor);
          if(high>localHigh){localHigh=high;localFacing=dir.clone();}
        }
        const rise=localHigh-base;
        if(rise>bestRise){bestRise=rise;bestMountain=n.clone();bestFacing=localFacing;}
        if(rise>230){earthSpawnFacing=localFacing;return n.clone();}
        continue;
      }
      if (sampleIsLand(p, n)) return n.clone();
    }
    if(p===earth&&bestMountain){earthSpawnFacing=bestFacing;return bestMountain;}
    return dirSun.clone();
  }


  function spawnOn(p) {
    groundPlanet = p;
    const n = findSpawnNormal(p);
    const srL = surfaceR(p, n);
    pos.copy(p.center).addScaledVector(n, (srL < 0 ? p.r : srL) + PLAYER_FEET);
    prevPos.copy(pos);
    vel.set(0, 0, 0);
    groundMotion.set(0,0,0);
    flightThrottle=0;flightBrake=0;
    grounded = true;
    up.copy(n); smoothUp.copy(n);
    earthInWater=p===earth&&earthWaterAtWorld(n);
    swimBlend=earthInWater?1:0;landingSlide.set(0,0,0);landingAge=99;landingStrength=0;
    if(p===earth&&earthSpawnFacing)fwdRef.copy(earthSpawnFacing).addScaledVector(n,-earthSpawnFacing.dot(n)).normalize();
    else fwdRef.set(0, 0, -1).addScaledVector(n, -n.dot(fwdRef)).normalize();
    if (fwdRef.lengthSq() < 1e-6) fwdRef.set(1, 0, 0);
    fwdRef.normalize();
    lastFacing.copy(fwdRef);
    yaw = 0; pitch = 0.3; charge = 0; charging = false;
    fuel = FUEL_MAX;
    target = null;
    document.getElementById('targetBanner').style.display = 'none';
  }

  // ---------- Input ----------
  const keys = {};
  function setUniverseAnnotationsHidden(hidden) {
    universeAnnotationsHidden = !!hidden;
    for (const line of orbitGuides) line.visible = !universeAnnotationsHidden;
    for (const entry of labels) if (entry.spr) entry.spr.visible = false;
    const marker = document.getElementById('youAreHere');
    if (marker) marker.style.display = (!universeAnnotationsHidden && overview) ? 'block' : 'none';
    toast(universeAnnotationsHidden
      ? 'Universe labels and orbit paths hidden'
      : 'Universe labels and orbit paths visible');
  }
  addEventListener('keydown', e => {
    if (finderOpen) {
      if (e.code === 'Escape' || (e.code === 'KeyF' && e.target !== document.getElementById('finderSearch'))) {
        closeFinder(false);
        e.preventDefault();
      }
      return;
    }
    if (e.code === 'KeyF' && !e.repeat) {
      openFinder();
      e.preventDefault();
      return;
    }
    if (e.code === 'Space' && !e.repeat && grounded) { charging = true; charge = 0; }
    if (e.code === 'KeyR') spawnOn(homePlanet());
    if (e.code === 'KeyT' && !e.repeat) toggleTarget();
    if (e.code === 'KeyC' && !e.repeat) toggleOverview();
    if (e.code === 'KeyH' && !e.repeat) setUniverseAnnotationsHidden(!universeAnnotationsHidden);
    if (e.code === 'KeyM' && !e.repeat) boostParker();
    if (e.code === 'KeyL' && !e.repeat) toggleLaser();
    keys[e.code] = true;
    if (e.code === 'Space') e.preventDefault();
  });
  addEventListener('keyup', e => {
    keys[e.code] = false;
    if (e.code === 'Space' && charging) {
      if (grounded) doJump();
      charging = false; charge = 0;
    }
  });
  addEventListener('wheel', e => {
    // While the destination finder is open, the wheel belongs to its list.
    // Returning here prevents both third-person and overview camera zoom.
    if (finderOpen) return;
    if (overview) {
      // Exponential wheel zoom stays consistent at planetary and human scales.
      // The four-metre minimum lets the overview travel right back to the player.
      overviewZoomTarget = Math.max(4, Math.min(1e21,
        overviewZoomTarget * Math.exp(e.deltaY * 0.006)));
    } else {
      camDistTarget = Math.max(3, Math.min(60, camDistTarget + e.deltaY * 0.01));
    }
  }, { passive: true });
  addEventListener('mousedown', e => {
    if (e.button === 0 && document.pointerLockElement) {
      if (laserEquipped) laserFiring = true; else fireAsteroid();
    }
  });
  addEventListener('mouseup', e => {
    if (e.button === 0) {laserFiring = false;finishEarthCraterNormals();}
  });

  // ---------- Music (solo piano, Interstellar-inspired) ----------
  let audioCtx = null, musicOn = true, musicNodes = null;
  function startMusic() {
    return; // sound disabled — space is silent
    if (!musicOn || musicNodes) return;
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      audioCtx.resume();
      const master = audioCtx.createGain();
      master.gain.value = 0;
      master.connect(audioCtx.destination);
      master.gain.linearRampToValueAtTime(0.5, audioCtx.currentTime + 3);
      const lp = audioCtx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 2600; lp.Q.value = 0.3;
      lp.connect(master);
      musicNodes = { master: master, lp: lp, step: 0, beat: 0, timer: null };

      // soft felt-piano voice: fundamental + quiet harmonics, fast attack, long decay
      function piano(freq, t, dur, vol) {
        const g = audioCtx.createGain();
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(vol, t + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        g.connect(lp);
        const partials = [[1, 1], [2, 0.4], [3, 0.12], [4.005, 0.05]];
        for (const p of partials) {
          const o = audioCtx.createOscillator();
          o.type = 'sine';
          o.frequency.value = freq * p[0];
          const pg = audioCtx.createGain();
          pg.gain.value = p[1];
          o.connect(pg); pg.connect(g);
          o.start(t); o.stop(t + dur + 0.1);
        }
      }

      // A-minor progression, arpeggiated like the Interstellar motif
      const A3 = 220.00, C4 = 261.63, E4 = 329.63, A4 = 440.00, B4 = 493.88, C5 = 523.25, E5 = 659.25;
      const F2 = 87.31, C3 = 130.81, G2 = 98.00, A2 = 110.00, E3 = 164.81, F3 = 174.61, G3 = 196.00;
      const bars = [
        { bass: [A2, E3], arp: [A3, C4, E4, A4, E4, C4] },
        { bass: [F2, F3], arp: [A3, C4, F3 * 2, A4, F3 * 2, C4] },
        { bass: [C3, G3], arp: [G3, C4, E4, C5, E4, C4] },
        { bass: [G2, G3], arp: [G3, B4 / 2, D_(), B4, D_(), B4 / 2] }
      ];
      function D_() { return 293.66; }
      function tick() {
        if (!musicNodes) return;
        const bar = bars[musicNodes.step % bars.length];
        const t = audioCtx.currentTime + 0.03;
        const b = musicNodes.beat % 6;
        if (b === 0) {
          piano(bar.bass[0], t, 5.5, 0.30);            // deep bass once per bar
          piano(bar.bass[1], t + 0.02, 4.5, 0.16);
        }
        piano(bar.arp[b], t, 2.8, 0.20);               // flowing arpeggio
        if (b === 3 && musicNodes.step % 2 === 1) {
          piano(bar.arp[0] * 2, t + 0.4, 2.2, 0.10);   // sparse high echo
        }
        musicNodes.beat++;
        if (musicNodes.beat % 6 === 0) musicNodes.step++;
      }
      tick();
      musicNodes.timer = setInterval(tick, 800);
    } catch (e) { /* audio unavailable */ }
  }
  function stopMusic() {
    if (!musicNodes) return;
    clearInterval(musicNodes.timer);
    const mn = musicNodes;
    musicNodes = null;
    mn.master.gain.setTargetAtTime(0, audioCtx.currentTime, 0.4);
    setTimeout(() => { try { mn.master.disconnect(); } catch (e) {} }, 2000);
  }

  // ---------- Sound effects ----------
  let noiseBuf = null;
  function ensureAudio() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    audioCtx.resume();
    if (!noiseBuf) {
      noiseBuf = audioCtx.createBuffer(1, audioCtx.sampleRate * 2, audioCtx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
  }
  function sfxWhoosh(dur) {
    return; // sound disabled
    try {
      ensureAudio();
      const t = audioCtx.currentTime;
      const src2 = audioCtx.createBufferSource();
      src2.buffer = noiseBuf; src2.loop = true;
      const bp = audioCtx.createBiquadFilter();
      bp.type = 'bandpass'; bp.Q.value = 0.8;
      bp.frequency.setValueAtTime(180, t);
      bp.frequency.exponentialRampToValueAtTime(950, t + dur);
      const g = audioCtx.createGain();
      g.gain.setValueAtTime(0.001, t);
      g.gain.exponentialRampToValueAtTime(0.35, t + dur * 0.85);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.25);
      src2.connect(bp); bp.connect(g); g.connect(audioCtx.destination);
      src2.start(t); src2.stop(t + dur + 0.3);
    } catch (e) {}
  }
  function sfxBoom() {
    return; // sound disabled
    try {
      ensureAudio();
      const t = audioCtx.currentTime;
      const src2 = audioCtx.createBufferSource();
      src2.buffer = noiseBuf;
      const lp = audioCtx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(900, t);
      lp.frequency.exponentialRampToValueAtTime(60, t + 1.4);
      const g = audioCtx.createGain();
      g.gain.setValueAtTime(0.8, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 1.6);
      src2.connect(lp); lp.connect(g); g.connect(audioCtx.destination);
      const o = audioCtx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(80, t);
      o.frequency.exponentialRampToValueAtTime(28, t + 1.2);
      const g2 = audioCtx.createGain();
      g2.gain.setValueAtTime(0.5, t);
      g2.gain.exponentialRampToValueAtTime(0.0001, t + 1.3);
      o.connect(g2); g2.connect(audioCtx.destination);
      src2.start(t); src2.stop(t + 1.7);
      o.start(t); o.stop(t + 1.4);
    } catch (e) {}
  }

  // ---------- Menu ----------
  const overlay = document.getElementById('overlay');
  const menuButtons = document.getElementById('menuButtons');
  const btnBack = document.getElementById('btnBack');
  const finderEl = document.getElementById('finder');
  const finderSearch = document.getElementById('finderSearch');
  const finderResults = document.getElementById('finderResults');
  const panels = { panelAch: document.getElementById('panelAch'), panelSet: document.getElementById('panelSet'), panelInfo: document.getElementById('panelInfo') };
  function showMenuHome() {
    menuButtons.style.display = 'block';
    btnBack.style.display = 'none';
    for (const k in panels) panels[k].style.display = 'none';
  }
  document.getElementById('btnResume').addEventListener('click', () => renderer.domElement.requestPointerLock());
  for (const btn of menuButtons.querySelectorAll('[data-panel]')) {
    btn.addEventListener('click', () => {
      menuButtons.style.display = 'none';
      btnBack.style.display = 'block';
      panels[btn.dataset.panel].style.display = 'block';
      if (btn.dataset.panel === 'panelAch') renderAchievements();
    });
  }
  btnBack.addEventListener('click', showMenuHome);
  finderSearch.addEventListener('input', () => renderFinder(finderSearch.value));
  finderEl.addEventListener('wheel', e => {
    finderResults.scrollTop += e.deltaY;
    e.preventDefault();
  }, { passive: false });
  document.addEventListener('pointerlockchange', () => {
    overlay.style.display = document.pointerLockElement || finderOpen ? 'none' : 'flex';
    if (!document.pointerLockElement) {
      showMenuHome();
      for (const k2 in keys) keys[k2] = false;
      charging = false; charge = 0;
    }
    if (document.pointerLockElement) startMusic();
  });

  function bodyKind(p) {
    if (p.blackhole) return 'BLACK HOLE';
    if (p.bodyType) return p.bodyType;
    if (p.isStar) return 'STAR';
    if (p.name === 'Moon') return 'MOON';
    return 'PLANET';
  }
  function proceduralMilkyFinderEntries(query){
    const raw=(query||'').trim(),exact=raw.match(/^(?:mw|milky\s*way)?[\s-]*(\d{1,8})$/i),ids=[];
    if(exact){
      const id=Math.max(1,Math.min(MILKY_SAMPLE_COUNT,Number(exact[1])));ids.push(id);
    }else if(!raw||/^(mw|milky|generated|numbered)/i.test(raw)){
      // A small deterministic window stands in for the full GPU catalogue.
      // Finder searches can address any of the 12m ids directly.
      const sx=Math.floor(pos.x/(32*LYS)),sy=Math.floor(pos.y/(32*LYS)),sz=Math.floor(pos.z/(32*LYS));
      for(let i=0;i<24;i++)ids.push(1+Math.floor(cellHash(sx,sy,sz,600+i)*MILKY_SAMPLE_COUNT));
    }
    return Array.from(new Set(ids)).map(id=>({
      name:'MW-'+String(id).padStart(8,'0'),bodyType:'NUMBERED MILKY WAY STAR',isStar:true,catalogOnly:true,
      proceduralStarId:id,r:5.8e7,center:milkySamplePosition(id,new THREE.Vector3()),
      searchAliases:['generated numbered star','milky way sample','procedural system']
    }));
  }
  function renderFinder(query) {
    const q = (query || '').trim().toLowerCase();
    // Named catalog and NASA host stars keep their real names.  Procedural GPU
    // samples use MW-####### designations and are materialized only when chosen.
    const searchable = Array.from(new Map(planets.concat(catalogStars,deepSkyObjects,proceduralMilkyFinderEntries(query)).map(p=>[p.name,p])).values());
    const matches = searchable.filter(p => {
      if(!q)return true;
      const aliases=p.searchAliases||[];
      return [p.name,bodyKind(p)].concat(aliases).join(' ').toLowerCase().includes(q);
    })
      .sort((a, b) => {
        const da = pos.distanceTo(a.center) - a.r;
        const db = pos.distanceTo(b.center) - b.r;
        return q ? a.name.localeCompare(b.name) : da - db;
      }).slice(0, 80);
    finderResults.textContent = '';
    for (const p of matches) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'finderResult';
      const name = document.createElement('span'); name.className = 'finderName'; name.textContent = p.name;
      const meta = document.createElement('span'); meta.className = 'finderMeta';
      const temperature=p.archiveData&&p.archiveData.eqTemp?'  ·  '+Math.round(p.archiveData.eqTemp)+' K':'';
      meta.textContent = bodyKind(p) + '  ·  ' + fmtDist(Math.max(0, pos.distanceTo(p.center) - p.r))+temperature;
      button.append(name, meta);
      button.addEventListener('click', () => {
        target = p.proceduralStarId ? materializeMilkySample(p.proceduralStarId) : p;
        document.getElementById('targetBanner').style.display = 'block';
        toast('Locked: ' + target.name);
        closeFinder(true);
      });
      finderResults.appendChild(button);
    }
  }
  function openFinder() {
    finderOpen = true;
    for (const k in keys) keys[k] = false;
    charging = false; charge = 0;
    finderEl.style.display = 'flex';
    overlay.style.display = 'none';
    finderSearch.value = '';
    renderFinder('');
    if (document.pointerLockElement) document.exitPointerLock();
    setTimeout(() => finderSearch.focus(), 0);
  }
  function closeFinder(resume) {
    finderOpen = false;
    finderEl.style.display = 'none';
    finderSearch.blur();
    if (resume) renderer.domElement.requestPointerLock();
    else overlay.style.display = document.pointerLockElement ? 'none' : 'flex';
  }
  document.addEventListener('mousemove', e => {
    if (!document.pointerLockElement) return;
    if (overview) {
      oyaw += e.movementX * mouseSens;
      opitch = Math.max(-1.5, Math.min(1.5, opitch + (invertY ? -e.movementY : e.movementY) * mouseSens));
      return;
    }
    if (target) return;
    yaw += e.movementX * mouseSens;
    // Full vertical orbit remains available. Terrain intersection is handled
    // at the camera's final world position instead of limiting player input.
    pitch = Math.max(-1.45, Math.min(1.45, pitch + (invertY ? -e.movementY : e.movementY) * mouseSens));
  });
  document.getElementById('setSens').addEventListener('input', e => { mouseSens = e.target.value / 10000; });
  document.getElementById('setInvert').addEventListener('change', e => { invertY = e.target.checked; });
  document.getElementById('setQuality').addEventListener('change', e => {
    const q = parseFloat(e.target.value);
    adaptiveQuality.setPreference(q);
    characterKey.castShadow = q >= 1.5;
    const shadowSize=q>=2.2?2048:1024;
    if(characterKey.shadow.mapSize.x!==shadowSize){
      characterKey.shadow.mapSize.set(shadowSize,shadowSize);
      if(characterKey.shadow.map){characterKey.shadow.map.dispose();characterKey.shadow.map=null;}
    }
  });
  terrainRangeControl.addEventListener('change',e=>{
    terrainRadiusPreference=Math.max(CONFIG.terrain.minRadius,Math.min(CONFIG.terrain.maxRadius,parseInt(e.target.value,10)||CONFIG.terrain.defaultRadius));
    earthSurfaceTiles.activeRadius=terrainRadiusPreference;
    earthSurfaceTiles.committedKeys.clear();earthSurfaceTiles.pendingKeys.clear();earthSurfaceTiles.pendingSignature='';
    for(const tile of earthSurfaceTiles.tiles.values())tile.group.visible=false;
    earthSurfaceCutaway.cosRadius.value=2;
    try{localStorage.setItem('godman_terrain_radius',String(terrainRadiusPreference));}catch(err){}
    const width=terrainRadiusPreference*2+1;
    toast('Terrain distance: '+width+' × '+width+' chunks — streaming global mountains');
  });
  const _setMusic = document.getElementById('setMusic');
  if (_setMusic) _setMusic.addEventListener('change', e => {
    musicOn = e.target.checked;
    if (musicOn && document.pointerLockElement) startMusic();
    else if (!musicOn) stopMusic();
  });
  function renderAchievements() {
    const list = document.getElementById('achList');
    const worlds = planets.filter(p => !p.isStar);
    let html = '<div style="text-align:center;margin-bottom:10px;font-size:16px;color:#ffd27d">' +
      worlds.filter(p => visited.has(p.name)).length + ' / ' + worlds.length + ' worlds explored</div>';
    for (const p of worlds) {
      const ok = visited.has(p.name);
      html += '<div class="achRow"><span>' + p.name + '</span><span class="' +
        (ok ? 'ok">visited' : 'no">not yet') + '</span></div>';
    }
    list.innerHTML = html;
  }

  // ---------- Helpers ----------
  const tmpQ = new THREE.Quaternion();
  const tmpV = new THREE.Vector3();
  const tmpV2 = new THREE.Vector3();
  const tmpV3 = new THREE.Vector3();
  const tmpC = new THREE.Color();

  function damp(cur, tgt, k, dt) { return cur + (tgt - cur) * (1 - Math.exp(-k * dt)); }
  function dampAngle(cur, tgt, k, dt) {
    let delta = (tgt - cur + Math.PI) % (Math.PI * 2);
    if (delta < 0) delta += Math.PI * 2;
    delta -= Math.PI;
    return cur + delta * (1 - Math.exp(-k * dt));
  }

  const fvA = new THREE.Vector3(), fvB = new THREE.Vector3();
  function frameVel(p, at, out) {
    out.copy(p.velNow);
    if (p.spinW) {
      fvA.copy(at).sub(p.center);
      fvB.crossVectors(p.spinAxis, fvA);
      out.addScaledVector(fvB, p.spinW * TIME_SCALE);
    }
    return out;
  }

  function moveInput(h, right, out) {
    out.set(0, 0, 0);
    if (keys.KeyW) out.add(h);
    if (keys.KeyS) out.sub(h);
    if (keys.KeyD) out.add(right);
    if (keys.KeyA) out.sub(right);
    if (out.lengthSq() > 0) out.normalize();
    return out;
  }

  // The old player-following surface-chunk experiment is intentionally kept
  // unreachable during this local iteration. Earth now uses only fixed,
  // georeferenced elevation geometry; no vegetation or rocks are instantiated.
  if(false){
  // ---------- Retired Earth surface chunks ----------
  // Terrain is divided into fixed latitude/longitude cells. A cell's geometry
  // and prop seed depend only on its Earth coordinates, never on the player.
  // Nearby cells are cached and transformed with Earth's rotation, so a tree
  // stays rooted to the same place and revisiting restores the same landscape.
  const earthTerrain = {
    root:new THREE.Group(),chunks:new Map(),tileSize:220,segments:24,
    activeRadius:2,phase:0,frame:0
  };
  earthTerrain.root.visible=false;
  scene.add(earthTerrain.root);
  const etQ = new THREE.Quaternion(), etN = new THREE.Vector3(), etWorldN = new THREE.Vector3();
  const etX = new THREE.Vector3(), etZ = new THREE.Vector3(), etDir = new THREE.Vector3();
  const etUV=[0,0,0,0];
  const etSampleA = { ground:0, waterHeight:0, water:false, ocean:false, river:false, height:0 };
  const etSampleB = { ground:0, waterHeight:0, water:false, ocean:false, river:false, height:0 };
  function earthUV(nWorld) {
    etQ.copy(earth.mesh.quaternion).invert();
    etN.copy(nWorld).applyQuaternion(etQ).normalize();
    const lat=Math.asin(Math.max(-1,Math.min(1,etN.y)));
    let lon=Math.atan2(etN.z,-etN.x); if(lon<0) lon+=Math.PI*2;
    etUV[0]=lon/(Math.PI*2);etUV[1]=0.5-lat/Math.PI;etUV[2]=lon;etUV[3]=lat;return etUV;
  }
  function earthOceanAtUV(u,v,nWorld) {
    const wd=earth._waterData;
    if(wd){
      const x=Math.min(wd.w-1,Math.max(0,(u*wd.w)|0));
      const y=Math.min(wd.h-1,Math.max(0,(v*wd.h)|0));
      const i=(y*wd.w+x)*4;
      return (wd.d[i]+wd.d[i+1]+wd.d[i+2])/3>72;
    }
    return !sampleIsLand(earth,nWorld);
  }
  function earthSurfaceSample(nWorld,out) {
    const uv=earthUV(nWorld), lon=uv[2], lat=uv[3];
    const ocean=earthOceanAtUV(uv[0],uv[1],nWorld);
    const large=0.5+0.5*Math.sin(lon*31+Math.sin(lat*19)*2.1)*Math.cos(lat*27-lon*13);
    const ridge=Math.pow(Math.max(0,1-Math.abs(Math.sin(lon*118+Math.sin(lat*83)*2.7))),3.2);
    const detail=0.5+0.28*Math.sin(lon*920+lat*710)+0.16*Math.sin(lon*2410-lat*1780)+0.06*Math.sin(lon*6900+lat*5120);
    let h=1.2+large*8+Math.max(0,detail)*10+ridge*(28+large*82)
      +Math.sin(lon*4180+lat*3270)*3.8+Math.sin(lon*8120-lat*6540)*1.7;
    const riverSignal=Math.abs(Math.sin(lon*5750+Math.sin(lat*2860)*1.8+Math.sin(lon*730)*0.7));
    const river=!ocean&&riverSignal<0.042&&h<58;
    out.ocean=ocean; out.river=river; out.water=ocean||river; out.height=h;
    if(ocean){ out.ground=-12-large*18; out.waterHeight=0; }
    else if(river){ out.waterHeight=Math.max(0.45,h-1.15); out.ground=out.waterHeight-1.6; }
    else { out.ground=h; out.waterHeight=h; }
    return out;
  }
  const earthGroundTex=canvasTex((x,w,h)=>{
    x.fillStyle='#566448'; x.fillRect(0,0,w,h);
    for(let i=0;i<7000;i++){
      const g=45+((Math.random()*70)|0); x.fillStyle='rgb('+((g*.78)|0)+','+g+','+((g*.55)|0)+')';
      const s=1+Math.random()*3; x.fillRect(Math.random()*w,Math.random()*h,s,s);
    }
  },512,512);
  earthGroundTex.wrapS=earthGroundTex.wrapT=THREE.RepeatWrapping; earthGroundTex.repeat.set(28,28);
  earthGroundTex.anisotropy=Math.min(8,renderer.capabilities.getMaxAnisotropy());
  const earthTerrainMat=new THREE.MeshStandardMaterial({map:earthGroundTex,vertexColors:true,roughness:0.96,metalness:0});
  const earthWaterMat=new THREE.MeshPhysicalMaterial({color:0x176da0,roughness:0.13,metalness:0,transparent:true,opacity:0.73,clearcoat:1,clearcoatRoughness:0.08,depthWrite:false,side:THREE.DoubleSide});
  const treeTrunkMat=new THREE.MeshStandardMaterial({color:0x4b321f,roughness:1});
  const treeFoliageTex=canvasTex((x,w,h)=>{
    x.clearRect(0,0,w,h);x.strokeStyle='rgba(70,48,28,.78)';x.lineWidth=7;x.beginPath();x.moveTo(w*.5,h);x.lineTo(w*.5,h*.28);x.stroke();
    const cols=['#173d22','#245c2e','#36743b','#4f8444'];
    for(let i=0;i<150;i++){const yy=h*.08+Math.random()*h*.72;const spread=Math.sin((yy/h)*Math.PI)*w*.44;const xx=w*.5+(Math.random()*2-1)*spread;const r=8+Math.random()*20;x.globalAlpha=.35+Math.random()*.55;x.fillStyle=cols[(Math.random()*cols.length)|0];x.beginPath();x.ellipse(xx,yy,r,r*(.55+Math.random()*.55),Math.random()*6.28,0,Math.PI*2);x.fill();}
    x.globalAlpha=1;
  },256,256);treeFoliageTex.encoding=THREE.sRGBEncoding;
  const treeLeafMat=new THREE.MeshStandardMaterial({map:treeFoliageTex,color:0xffffff,roughness:0.94,transparent:true,alphaTest:.24,side:THREE.DoubleSide});
  const rockMat=new THREE.MeshStandardMaterial({color:0x77736c,roughness:0.92});
  const earthGrassMat=new THREE.PointsMaterial({color:0x8dae62,size:.16,sizeAttenuation:true});
  function crossedFoliageGeometry(){
    const p=[],uv=[],idx=[];let base=0;
    for(let k=0;k<3;k++){const a=k*Math.PI/3,c=Math.cos(a)*1.45,s=Math.sin(a)*1.45;p.push(-c,-2,-s,c,-2,s,-c,2,-s,c,2,s);uv.push(0,0,1,0,0,1,1,1);idx.push(base,base+1,base+2,base+1,base+3,base+2);base+=4;}
    const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(p,3));g.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));g.setIndex(idx);g.computeVertexNormals();return g;
  }
  function earthDirectionAt(anchorN,q,x,z,out){
    etX.set(1,0,0).applyQuaternion(q); etZ.set(0,0,1).applyQuaternion(q);
    return out.copy(anchorN).addScaledVector(etX,x/earth.r).addScaledVector(etZ,z/earth.r).normalize();
  }
  function disposeEarthChunk(chunk){
    earthTerrain.root.remove(chunk.group);
    chunk.group.traverse(o=>{if(o.geometry)o.geometry.dispose();});
  }
  function buildEarthChunk(ix,iy){
    const step=earthTerrain.tileSize/earth.r;
    const lonCells=Math.ceil(Math.PI*2/step),latCells=Math.ceil(Math.PI/step);
    ix=((ix%lonCells)+lonCells)%lonCells;iy=Math.max(0,Math.min(latCells-1,iy));
    const key=ix+':'+iy;
    if(earthTerrain.chunks.has(key))return earthTerrain.chunks.get(key);
    const lon=(ix+.5)*step,lat=-Math.PI*.5+(iy+.5)*step;
    const centerLocal=V3(-Math.cos(lon)*Math.cos(lat),Math.sin(lat),Math.sin(lon)*Math.cos(lat)).normalize();
    const centerWorld=centerLocal.clone().applyQuaternion(earth.mesh.quaternion).normalize();
    const q=new THREE.Quaternion().setFromUnitVectors(V3(0,1,0),centerWorld);
    const anchor=earthSurfaceSample(centerWorld,etSampleA);
    const anchorHeight=anchor.water?anchor.waterHeight:anchor.ground;
    const group=new THREE.Group();group.name='Earth terrain '+key;earthTerrain.root.add(group);
    const R=earthTerrain.tileSize*.535,S=earthTerrain.segments,N=S+1;
    const positions=new Float32Array(N*N*3),colors=new Float32Array(N*N*3),indices=[];
    const waterCells=[],color=new THREE.Color();
    for(let j=0;j<N;j++)for(let i=0;i<N;i++){
      const x=-R+i/S*R*2,z=-R+j/S*R*2,k=(j*N+i)*3;
      earthDirectionAt(centerWorld,q,x,z,etDir);const s=earthSurfaceSample(etDir,etSampleA);
      positions[k]=x;positions[k+1]=s.ground-anchorHeight;positions[k+2]=z;
      if(s.ocean)color.setRGB(.09,.12,.1);else if(s.height>78)color.setRGB(.55,.53,.49);else if(s.height>45)color.setRGB(.34,.39,.28);else color.setRGB(.25,.44,.22);
      colors[k]=color.r;colors[k+1]=color.g;colors[k+2]=color.b;
    }
    for(let j=0;j<S;j++)for(let i=0;i<S;i++){
      const a=j*N+i,b=a+1,c=a+N,d=c+1;indices.push(a,c,b,b,c,d);
      const x=-R+(i+.5)/S*R*2,z=-R+(j+.5)/S*R*2;
      earthDirectionAt(centerWorld,q,x,z,etDir);const s=earthSurfaceSample(etDir,etSampleA);
      if(s.water)waterCells.push([x,z,s.waterHeight-anchorHeight,R*2/S*1.08]);
    }
    const geo=new THREE.BufferGeometry();geo.setAttribute('position',new THREE.BufferAttribute(positions,3));geo.setAttribute('color',new THREE.BufferAttribute(colors,3));geo.setIndex(indices);geo.computeVertexNormals();
    const terrainMesh=new THREE.Mesh(geo,earthTerrainMat);terrainMesh.receiveShadow=true;terrainMesh.castShadow=true;group.add(terrainMesh);
    let waterMesh=null;
    if(waterCells.length){
      const wp=new Float32Array(waterCells.length*12),wi=[];let v=0;
      for(const c of waterCells){const h=c[3]*.5;wp.set([c[0]-h,c[2]+.08,c[1]-h,c[0]+h,c[2]+.08,c[1]-h,c[0]-h,c[2]+.08,c[1]+h,c[0]+h,c[2]+.08,c[1]+h],v*3);wi.push(v,v+2,v+1,v+1,v+2,v+3);v+=4;}
      const wg=new THREE.BufferGeometry();wg.setAttribute('position',new THREE.BufferAttribute(wp,3));wg.setIndex(wi);wg.computeVertexNormals();waterMesh=new THREE.Mesh(wg,earthWaterMat);waterMesh.renderOrder=4;group.add(waterMesh);
    }
    let seed=(Math.imul(ix+1,73856093)^Math.imul(iy+1,19349663))|0;
    const rnd=()=>{seed=(Math.imul(seed,1664525)+1013904223)|0;return(seed>>>0)/4294967296;};
    const maxTrees=42,maxRocks=14;
    const trunks=new THREE.InstancedMesh(new THREE.CylinderGeometry(.12,.2,2.2,7),treeTrunkMat,maxTrees);
    const crowns=new THREE.InstancedMesh(crossedFoliageGeometry(),treeLeafMat,maxTrees);
    const rocks=new THREE.InstancedMesh(new THREE.DodecahedronGeometry(.7,0),rockMat,maxRocks);
    const dummy=new THREE.Object3D();let tc=0,rc=0;
    for(let tries=0;tries<240&&(tc<maxTrees||rc<maxRocks);tries++){
      const x=(rnd()*2-1)*R*.93,z=(rnd()*2-1)*R*.93;
      earthDirectionAt(centerWorld,q,x,z,etDir);const s=earthSurfaceSample(etDir,etSampleA),y=s.ground-anchorHeight;
      if(!s.water&&s.height<67&&tc<maxTrees&&rnd()>.28){
        const scale=.72+rnd()*1.15;dummy.position.set(x,y+1.05*scale,z);dummy.rotation.set(0,rnd()*Math.PI*2,0);dummy.scale.set(scale,scale,scale);dummy.updateMatrix();trunks.setMatrixAt(tc,dummy.matrix);
        dummy.position.y=y+(2.45+.45*rnd())*scale;dummy.scale.set(scale*(.8+rnd()*.35),scale*(1+rnd()*.45),scale*(.8+rnd()*.35));dummy.updateMatrix();crowns.setMatrixAt(tc,dummy.matrix);tc++;
      }else if(!s.water&&rc<maxRocks&&rnd()>.6){dummy.position.set(x,y+.35,z);dummy.rotation.set(rnd()*1.2,rnd()*6.28,rnd()*.5);const rs=.35+rnd()*1.4;dummy.scale.set(rs,rs*(.45+rnd()*.5),rs);dummy.updateMatrix();rocks.setMatrixAt(rc++,dummy.matrix);}
    }
    trunks.count=crowns.count=tc;rocks.count=rc;trunks.castShadow=crowns.castShadow=true;trunks.receiveShadow=crowns.receiveShadow=rocks.receiveShadow=true;group.add(trunks,crowns,rocks);
    const grassPos=[];for(let i=0;i<190;i++){const x=(rnd()*2-1)*R,z=(rnd()*2-1)*R;earthDirectionAt(centerWorld,q,x,z,etDir);const s=earthSurfaceSample(etDir,etSampleA);if(!s.water&&s.height<60)grassPos.push(x,s.ground-anchorHeight+.08,z);}
    const gg=new THREE.BufferGeometry();gg.setAttribute('position',new THREE.Float32BufferAttribute(grassPos,3));group.add(new THREE.Points(gg,earthGrassMat));
    const chunk={key,ix,iy,group,centerLocal,anchorHeight,waterMesh,lastUsed:earthTerrain.frame};
    earthTerrain.chunks.set(key,chunk);return chunk;
  }
  function updateEarthTerrain(dt){
    earthTerrain.frame++;earthTerrain.phase+=dt;
    const altitude=pos.distanceTo(earth.center)-earth.r,active=!earth.destroyed&&altitude<2500;
    earthTerrain.root.visible=active;if(!active)return;
    const worldN=etWorldN.copy(pos).sub(earth.center).normalize();
    etQ.copy(earth.mesh.quaternion).invert();const localN=etN.copy(worldN).applyQuaternion(etQ).normalize();
    let lon=Math.atan2(localN.z,-localN.x);if(lon<0)lon+=Math.PI*2;const lat=Math.asin(Math.max(-1,Math.min(1,localN.y)));
    const step=earthTerrain.tileSize/earth.r,lonCells=Math.ceil(Math.PI*2/step),latCells=Math.ceil(Math.PI/step);
    const cx=Math.floor(lon/step),cy=Math.floor((lat+Math.PI*.5)/step),wanted=new Set(),missing=[];
    for(const ch of earthTerrain.chunks.values())ch.group.visible=false;
    for(let dy=-earthTerrain.activeRadius;dy<=earthTerrain.activeRadius;dy++)for(let dx=-earthTerrain.activeRadius;dx<=earthTerrain.activeRadius;dx++){
      const ix=((cx+dx)%lonCells+lonCells)%lonCells,iy=Math.max(0,Math.min(latCells-1,cy+dy)),key=ix+':'+iy;wanted.add(key);
      const chunk=earthTerrain.chunks.get(key);if(chunk){chunk.group.visible=true;chunk.lastUsed=earthTerrain.frame;}else missing.push({ix,iy,d:dx*dx+dy*dy});
    }
    missing.sort((a,b)=>a.d-b.d);
    const buildBudget=earthTerrain.chunks.size?2:1;
    for(let i=0;i<Math.min(buildBudget,missing.length);i++){const c=buildEarthChunk(missing[i].ix,missing[i].iy);c.group.visible=true;c.lastUsed=earthTerrain.frame;wanted.add(c.key);}
    for(const chunk of earthTerrain.chunks.values())if(chunk.group.visible){
      const wn=etDir.copy(chunk.centerLocal).applyQuaternion(earth.mesh.quaternion).normalize();
      chunk.group.quaternion.setFromUnitVectors(V3(0,1,0),wn);
      chunk.group.position.copy(earth.center).addScaledVector(wn,earth.r+chunk.anchorHeight).sub(pos);
      if(chunk.waterMesh)chunk.waterMesh.position.y=Math.sin(earthTerrain.phase*1.35)*.045;
    }
    if(earthTerrain.chunks.size>64){
      const old=[...earthTerrain.chunks.values()].filter(c=>!wanted.has(c.key)).sort((a,b)=>a.lastUsed-b.lastUsed);
      while(earthTerrain.chunks.size>56&&old.length){const c=old.shift();disposeEarthChunk(c);earthTerrain.chunks.delete(c.key);}
    }
  }
  }

  // ---------- Earth walking-scale terrain ----------
  // Fixed latitude/longitude tiles add metre-scale relief near the player.
  // They are children of the rotating Earth, so camera movement never changes
  // their world coordinates. The deterministic height function is also used
  // by collision, and every tile sits slightly above the orbital globe.
  const EARTH_SEA_LEVEL=.42;
  const earthSurfaceTiles={
    tiles:new Map(),tileSize:480,lodSegments:[128,64,32,16],activeRadius:terrainRadiusPreference,frame:0,
    committedKeys:new Set(),committedCenter:new THREE.Vector3(0,1,0),
    pendingKeys:new Set(),pendingCenter:new THREE.Vector3(0,1,0),pendingSignature:''
  };
  const earthTileQ=new THREE.Quaternion(),earthTileN=new THREE.Vector3();
  function earthHash3(x,y,z){
    let h=Math.imul(x|0,374761393)^Math.imul(y|0,668265263)^Math.imul(z|0,2147483647);
    h=Math.imul(h^(h>>>13),1274126177);return((h^(h>>>16))>>>0)/4294967295;
  }
  function earthValueNoise3(x,y,z){
    const ix=Math.floor(x),iy=Math.floor(y),iz=Math.floor(z),fx=x-ix,fy=y-iy,fz=z-iz;
    const sx=fx*fx*(3-2*fx),sy=fy*fy*(3-2*fy),sz=fz*fz*(3-2*fz),mix=(a,b,t)=>a+(b-a)*t;
    const a=mix(earthHash3(ix,iy,iz),earthHash3(ix+1,iy,iz),sx),b=mix(earthHash3(ix,iy+1,iz),earthHash3(ix+1,iy+1,iz),sx);
    const c=mix(earthHash3(ix,iy,iz+1),earthHash3(ix+1,iy,iz+1),sx),d=mix(earthHash3(ix,iy+1,iz+1),earthHash3(ix+1,iy+1,iz+1),sx);
    return mix(mix(a,b,sy),mix(c,d,sy),sz);
  }
  function earthRasterPixel(id,n){
    const theta=Math.acos(Math.max(-1,Math.min(1,n.y)));let phi=Math.atan2(n.z,-n.x);if(phi<0)phi+=Math.PI*2;
    const x=Math.min(id.w-1,Math.max(0,Math.floor(phi/(Math.PI*2)*id.w))),y=Math.min(id.h-1,Math.max(0,Math.floor(theta/Math.PI*id.h)));
    return (y*id.w+x)*4;
  }
  function earthWaterLocal(n){
    const wd=earth._waterData;
    if(wd){const k=earthRasterPixel(wd,n);return (wd.d[k]+wd.d[k+1]+wd.d[k+2])/3>86;}
    const id=earth._surfaceData||planetImgData(earth);
    if(!id)return sampleEarthElevationRaster(n)<.35;
    const k=earthRasterPixel(id,n),r=id.d[k],g=id.d[k+1],b=id.d[k+2];
    return b>58&&b>r*1.18&&b>g*1.06&&b-r>16;
  }
  function earthWaterAtWorld(nWorld){
    earthTileQ.copy(earth.mesh.quaternion).invert();earthTileN.copy(nWorld).applyQuaternion(earthTileQ).normalize();
    return earthWaterLocal(earthTileN);
  }
  function earthFineReliefLocal(n,baseElevation){
    if(!earthElevation.ready)return .18;
    if(earthWaterLocal(n)){
      const x=n.x*earth.r,y=n.y*earth.r,z=n.z*earth.r;
      return -2.2-earthValueNoise3(x/95,y/95,z/95)*1.8;
    }
    const x=n.x*earth.r,y=n.y*earth.r,z=n.z*earth.r;
    const continental=earthValueNoise3(x/1500,y/1500,z/1500);
    const rangeRidge=1-Math.abs(continental*2-1);
    const midRidge=1-Math.abs(earthValueNoise3(x/480,y/480,z/480)*2-1);
    const foothill=earthValueNoise3(x/135,y/135,z/135);
    const fine=earthValueNoise3(x/38,y/38,z/38),micro=earthValueNoise3(x/11,y/11,z/11);
    const reliefRange=sampleEarthRuggednessLocal(n);
    const rugged=Math.max(0,Math.min(1,(reliefRange-5)/135));
    const highland=Math.max(0,Math.min(1,(baseElevation-18)/210));
    // Every fixed land coordinate receives a persistent ridge hierarchy. Real
    // ruggedness still controls the largest relief, but low-ruggedness regions
    // now become foothill country instead of an empty flat plane.
    const continentalMountain=.28+.18*continental;
    const mountainMask=Math.max(continentalMountain,rugged,highland*.42);
    const ranges=mountainMask*(Math.pow(rangeRidge,3.15)*72+Math.pow(midRidge,2.35)*24+foothill*8.5);
    const lowland=(1-mountainMask)*(1.2+Math.pow(rangeRidge,2)*5.5+foothill*3.2);
    const regionalLift=Math.pow(earthValueNoise3(x/4200,y/4200,z/4200),2.2)*(8+mountainMask*28);
    return lowland+ranges+regionalLift+fine*(1.4+mountainMask*3.6)+micro*(.45+mountainMask*1.2);
  }
  function earthFineReliefWorld(nWorld){
    if(!earthElevation.ready)return 0;
    earthTileQ.copy(earth.mesh.quaternion).invert();earthTileN.copy(nWorld).applyQuaternion(earthTileQ).normalize();
    return earthFineReliefLocal(earthTileN,sampleEarthElevationRaster(earthTileN));
  }
  function earthCraterDispLocal(nLocal){
    if(!earth.craters||earth.craters.length===0)return 0;
    let displacement=0;
    for(const cr of earth.craters)displacement+=craterDisp(cr,nLocal.distanceTo(cr.n)*earth.r);
    return Math.max(displacement,-earth.r*.998);
  }
  const earthMeltSample={strength:0,birth:-1000};
  function sampleEarthMeltLocal(nLocal,out=earthMeltSample){
    out.strength=0;out.birth=-1000;
    if(!earth.craters)return out;
    for(const cr of earth.craters){
      if(!cr.laser)continue;
      const t=nLocal.distanceTo(cr.n)*earth.r/cr.R;
      if(t>=1.18)continue;
      const strength=1-THREE.MathUtils.smoothstep(t,.72,1.18);
      if(strength>out.strength)out.strength=strength;
      out.birth=Math.max(out.birth,cr.lastHeat||0);
    }
    return out;
  }
  function earthSurfaceRadiusWorld(nWorld,solidOnly){
    earthTileQ.copy(earth.mesh.quaternion).invert();earthTileN.copy(nWorld).applyQuaternion(earthTileQ).normalize();
    if(!solidOnly&&earthWaterLocal(earthTileN))return earth.r+EARTH_SEA_LEVEL;
    const base=sampleEarthElevationRaster(earthTileN);
    return earth.r+base+earthFineReliefLocal(earthTileN,base);
  }
  function earthAlbedoLocal(n,out){
    const id=earth._surfaceData||planetImgData(earth);
    if(!id)return false;
    const k=earthRasterPixel(id,n);
    out.setRGB(id.d[k]/255,id.d[k+1]/255,id.d[k+2]/255).convertSRGBToLinear();return true;
  }
  const earthTileCenterWorld={value:new THREE.Vector3(0,1,0)},earthTileRenderCenter={value:new THREE.Vector3()};
  const earthRockTint=new THREE.Color(0x68645d),earthSnowTint=new THREE.Color(0xd8d9d5);
  const earthTerrainTime={value:0};
  const earthTileMat=new THREE.MeshStandardMaterial({vertexColors:true,roughness:.96,metalness:0,emissive:0x030608,emissiveIntensity:.2});
  earthTileMat.onBeforeCompile=shader=>{
    shader.uniforms.earthTileCenterWorld=earthTileCenterWorld;
    shader.uniforms.earthTileRenderCenter=earthTileRenderCenter;
    shader.uniforms.earthTileCosRadius=earthSurfaceCutaway.cosRadius;
    shader.uniforms.earthTerrainTime=earthTerrainTime;
    shader.vertexShader=shader.vertexShader
      .replace('#include <common>','#include <common>\nvarying vec3 vEarthTileDir;\nvarying float vEarthMeltStrength,vEarthMeltBirth;\nattribute float earthMeltStrength,earthMeltBirth;\nuniform vec3 earthTileRenderCenter;')
      .replace('#include <begin_vertex>','#include <begin_vertex>\nvEarthTileDir=normalize((modelMatrix*vec4(position,1.0)).xyz-earthTileRenderCenter);\nvEarthMeltStrength=earthMeltStrength;vEarthMeltBirth=earthMeltBirth;');
    shader.fragmentShader=shader.fragmentShader
      .replace('#include <common>','#include <common>\nvarying vec3 vEarthTileDir;\nvarying float vEarthMeltStrength,vEarthMeltBirth;\nuniform vec3 earthTileCenterWorld;\nuniform float earthTileCosRadius,earthTerrainTime;')
      .replace('#include <clipping_planes_fragment>','#include <clipping_planes_fragment>\nif(dot(normalize(vEarthTileDir),earthTileCenterWorld)<earthTileCosRadius)discard;')
      .replace('#include <color_fragment>','#include <color_fragment>\nfloat earthMeltAge=max(0.0,earthTerrainTime-vEarthMeltBirth);float earthMeltHeat=exp(-earthMeltAge/18.0)*vEarthMeltStrength;\ndiffuseColor.rgb=mix(diffuseColor.rgb,vec3(.018,.014,.013),vEarthMeltStrength*.9);\ndiffuseColor.rgb=mix(diffuseColor.rgb,vec3(.42,.055,.008),earthMeltHeat*.42);')
      .replace('#include <roughnessmap_fragment>','#include <roughnessmap_fragment>\nroughnessFactor=mix(roughnessFactor,.34,vEarthMeltStrength);')
      .replace('#include <metalnessmap_fragment>','#include <metalnessmap_fragment>\nmetalnessFactor=mix(metalnessFactor,.08,vEarthMeltStrength);')
      .replace('#include <emissivemap_fragment>','#include <emissivemap_fragment>\ntotalEmissiveRadiance+=vec3(1.25,.16,.012)*earthMeltHeat*(.35+.65*sin(earthTerrainTime*2.7+vEarthMeltStrength*19.0)*sin(earthTerrainTime*2.7+vEarthMeltStrength*19.0));');
  };
  earthTileMat.customProgramCacheKey=()=> 'earth-walking-tiles-v4-melt';
  const earthWaterTime={value:0};
  const earthWaterMat=new THREE.MeshPhysicalMaterial({
    color:0x095570,roughness:.27,metalness:0,transparent:true,opacity:.84,
    clearcoat:.72,clearcoatRoughness:.16,reflectivity:.3,depthWrite:false,side:THREE.DoubleSide
  });
  earthWaterMat.onBeforeCompile=shader=>{
    shader.uniforms.earthWaterTime=earthWaterTime;
    shader.vertexShader=shader.vertexShader
      .replace('#include <common>','#include <common>\nuniform float earthWaterTime;\nattribute float earthWaterEdge;\nvarying float vEarthWaterEdge;')
      .replace('#include <begin_vertex>','#include <begin_vertex>\nvEarthWaterEdge=earthWaterEdge;\nfloat earthWave=(sin(uv.x*.034+earthWaterTime*1.15)+sin(uv.y*.052-earthWaterTime*.87)+sin((uv.x+uv.y)*.019+earthWaterTime*.63))*.018;\ntransformed+=objectNormal*earthWave;');
    shader.fragmentShader=shader.fragmentShader
      .replace('#include <common>','#include <common>\nvarying float vEarthWaterEdge;')
      .replace('#include <color_fragment>','#include <color_fragment>\nfloat shoreFade=smoothstep(.06,.82,vEarthWaterEdge);\ndiffuseColor.a*=shoreFade;\nif(diffuseColor.a<.025)discard;')
      .replace('#include <normal_fragment_begin>','#include <normal_fragment_begin>\nfloat waterFacing=clamp(abs(dot(normalize(normal),normalize(vViewPosition))),0.0,1.0);\nfloat waterFresnel=pow(1.0-waterFacing,4.0);\ndiffuseColor.rgb=mix(diffuseColor.rgb,vec3(.035,.19,.27),waterFresnel*.72);');
  };
  earthWaterMat.customProgramCacheKey=()=> 'earth-water-v2';
  function resetEarthSurfaceTiles(){
    for(const tile of earthSurfaceTiles.tiles.values()){
      earth.mesh.remove(tile.group);
      tile.group.traverse(o=>{if(o.geometry)o.geometry.dispose();});
    }
    earthSurfaceTiles.tiles.clear();
    earthSurfaceTiles.committedKeys.clear();earthSurfaceTiles.pendingKeys.clear();earthSurfaceTiles.pendingSignature='';
    earthSurfaceCutaway.cosRadius.value=2;
  }
  function buildEarthSurfaceTile(ix,iy,lonCells,latCells,lod){
    const key=ix+':'+iy+':'+lod;if(earthSurfaceTiles.tiles.has(key))return earthSurfaceTiles.tiles.get(key);
    const lonStep=Math.PI*2/lonCells,latStep=Math.PI/latCells,lon0=ix*lonStep,lat0=-Math.PI*.5+iy*latStep;
    const lonC=lon0+lonStep*.5,latC=lat0+latStep*.5,cl=Math.cos(latC),center=V3(-Math.cos(lonC)*cl,Math.sin(latC),Math.sin(lonC)*cl).normalize();
    const anchorBase=sampleEarthElevationRaster(center),anchor=earth.r+anchorBase+earthFineReliefLocal(center,anchorBase);
    const q=new THREE.Quaternion().setFromUnitVectors(V3(0,1,0),center),qi=q.clone().invert(),S=earthSurfaceTiles.lodSegments[lod],N=S+1;
    const positions=new Float32Array(N*N*3),localDirs=new Float32Array(N*N*3),baseRadii=new Float32Array(N*N),meltStrengths=new Float32Array(N*N),meltBirths=new Float32Array(N*N),waterPositions=new Float32Array(N*N*3),waterEdges=new Float32Array(N*N),uvs=new Float32Array(N*N*2),colors=new Float32Array(N*N*3),indices=[],waterIndices=[];
    meltBirths.fill(-1000);
    const dir=new THREE.Vector3(),cellDir=new THREE.Vector3(),point=new THREE.Vector3(),col=new THREE.Color();
    for(let j=0;j<N;j++)for(let i=0;i<N;i++){
      const lon=lon0+i/S*lonStep,lat=lat0+j/S*latStep,c=Math.cos(lat),k=j*N+i;
      dir.set(-Math.cos(lon)*c,Math.sin(lat),Math.sin(lon)*c).normalize();
      const base=sampleEarthElevationRaster(dir),water=earthWaterLocal(dir),relief=earthFineReliefLocal(dir,base),baseRadius=earth.r+base+relief,rr=baseRadius+earthCraterDispLocal(dir);
      localDirs[k*3]=dir.x;localDirs[k*3+1]=dir.y;localDirs[k*3+2]=dir.z;baseRadii[k]=baseRadius;
      const melt=sampleEarthMeltLocal(dir);meltStrengths[k]=melt.strength;meltBirths[k]=melt.birth;
      point.copy(dir).multiplyScalar(rr).addScaledVector(center,-anchor).applyQuaternion(qi);
      positions[k*3]=point.x;positions[k*3+1]=point.y;positions[k*3+2]=point.z;
      point.copy(dir).multiplyScalar(earth.r+EARTH_SEA_LEVEL).addScaledVector(center,-anchor).applyQuaternion(qi);
      waterPositions[k*3]=point.x;waterPositions[k*3+1]=point.y;waterPositions[k*3+2]=point.z;
      waterEdges[k]=water?1:0;
      uvs[k*2]=lon*earth.r;uvs[k*2+1]=lat*earth.r;
      if(water)col.setRGB(.018,.045,.055);else if(!earthAlbedoLocal(dir,col)){
        if(base<2)col.setRGB(.055,.11,.16);else if(base>500)col.setRGB(.48,.48,.45);else if(base>300)col.setRGB(.25,.24,.21);else if(base>150)col.setRGB(.17,.21,.14);else if(Math.abs(lat)>.85)col.setRGB(.24,.25,.21);else col.setRGB(.12,.23,.1);
      }
      const rugged=Math.max(0,Math.min(1,sampleEarthRuggednessLocal(dir)/150));
      const tone=.63+.28*earthValueNoise3(dir.x*earth.r/18,dir.y*earth.r/18,dir.z*earth.r/18)+.09*earthValueNoise3(dir.x*earth.r/6,dir.y*earth.r/6,dir.z*earth.r/6);
      col.multiplyScalar(tone);
      if(!water&&rugged>.35)col.lerp(base>420?earthSnowTint:earthRockTint,Math.min(.52,rugged*.42));
      colors[k*3]=col.r;colors[k*3+1]=col.g;colors[k*3+2]=col.b;
    }
    for(let j=0;j<S;j++)for(let i=0;i<S;i++){
      const a=j*N+i,b=a+1,c=a+N,d=c+1;indices.push(a,b,c,b,d,c);
      const lon=lon0+(i+.5)/S*lonStep,lat=lat0+(j+.5)/S*latStep,cc=Math.cos(lat);
      cellDir.set(-Math.cos(lon)*cc,Math.sin(lat),Math.sin(lon)*cc).normalize();
      if(earthWaterLocal(cellDir))waterIndices.push(a,b,c,b,d,c);
    }
    const geo=new THREE.BufferGeometry();geo.setAttribute('position',new THREE.BufferAttribute(positions,3));geo.setAttribute('uv',new THREE.BufferAttribute(uvs,2));geo.setAttribute('color',new THREE.BufferAttribute(colors,3));geo.setAttribute('earthMeltStrength',new THREE.BufferAttribute(meltStrengths,1));geo.setAttribute('earthMeltBirth',new THREE.BufferAttribute(meltBirths,1));geo.setIndex(indices);geo.computeVertexNormals();
    // Independently triangulated LODs produce slightly different edge normals.
    // Use the same planet-radial normal on every shared border so lighting does
    // not reveal the chunk grid as a dark dotted line.
    const edgeNormals=geo.getAttribute('normal'),edgeDir=new THREE.Vector3();
    for(let j=0;j<N;j++)for(let i=0;i<N;i++)if(i===0||j===0||i===S||j===S){
      const lon=lon0+i/S*lonStep,lat=lat0+j/S*latStep,ct=Math.cos(lat),k=j*N+i;
      edgeDir.set(-Math.cos(lon)*ct,Math.sin(lat),Math.sin(lon)*ct).applyQuaternion(qi).normalize();
      edgeNormals.setXYZ(k,edgeDir.x,edgeDir.y,edgeDir.z);
    }
    edgeNormals.needsUpdate=true;geo.computeBoundingSphere();
    const group=new THREE.Group();group.position.copy(center).multiplyScalar(anchor);group.quaternion.copy(q);group.name='Earth surface '+key;
    const mesh=new THREE.Mesh(geo,earthTileMat);mesh.castShadow=false;mesh.receiveShadow=true;mesh.renderOrder=2;group.add(mesh);
    // Downward skirts overlap neighbouring LODs. Their top edge is identical
    // to the tile border, while the lower edge hides the small gap caused when
    // a coarse neighbour interpolates over detail vertices present here.
    const perimeter=[];
    for(let i=0;i<=S;i++)perimeter.push(i);
    for(let j=1;j<=S;j++)perimeter.push(j*N+S);
    for(let i=S-1;i>=0;i--)perimeter.push(S*N+i);
    for(let j=S-1;j>0;j--)perimeter.push(j*N);
    const skirtPositions=new Float32Array(perimeter.length*2*3),skirtColors=new Float32Array(perimeter.length*2*3),skirtMeltStrengths=new Float32Array(perimeter.length*2),skirtMeltBirths=new Float32Array(perimeter.length*2),skirtRadials=new Float32Array(perimeter.length*3),skirtIndices=[];
    skirtMeltBirths.fill(-1000);
    const skirtDepth=lod===0?2.5:(lod===1?5:(lod===2?9:14)),radialLocal=new THREE.Vector3();
    for(let e=0;e<perimeter.length;e++){
      const vertex=perimeter[e],i=vertex%N,j=Math.floor(vertex/N),src=vertex*3,dst=e*6;
      const lon=lon0+i/S*lonStep,lat=lat0+j/S*latStep,ct=Math.cos(lat);
      radialLocal.set(-Math.cos(lon)*ct,Math.sin(lat),Math.sin(lon)*ct).applyQuaternion(qi).normalize();
      skirtRadials[e*3]=radialLocal.x;skirtRadials[e*3+1]=radialLocal.y;skirtRadials[e*3+2]=radialLocal.z;
      skirtPositions[dst]=positions[src];skirtPositions[dst+1]=positions[src+1];skirtPositions[dst+2]=positions[src+2];
      skirtPositions[dst+3]=positions[src]-radialLocal.x*skirtDepth;skirtPositions[dst+4]=positions[src+1]-radialLocal.y*skirtDepth;skirtPositions[dst+5]=positions[src+2]-radialLocal.z*skirtDepth;
      skirtColors[dst]=colors[src];skirtColors[dst+1]=colors[src+1];skirtColors[dst+2]=colors[src+2];
      skirtColors[dst+3]=colors[src]*.9;skirtColors[dst+4]=colors[src+1]*.9;skirtColors[dst+5]=colors[src+2]*.9;
      skirtMeltStrengths[e*2]=skirtMeltStrengths[e*2+1]=meltStrengths[vertex];
      skirtMeltBirths[e*2]=skirtMeltBirths[e*2+1]=meltBirths[vertex];
      const next=(e+1)%perimeter.length,a=e*2,b=a+1,c=next*2,d=c+1;skirtIndices.push(a,c,b,c,d,b);
    }
    const skirtGeo=new THREE.BufferGeometry();skirtGeo.setAttribute('position',new THREE.BufferAttribute(skirtPositions,3));skirtGeo.setAttribute('color',new THREE.BufferAttribute(skirtColors,3));skirtGeo.setAttribute('earthMeltStrength',new THREE.BufferAttribute(skirtMeltStrengths,1));skirtGeo.setAttribute('earthMeltBirth',new THREE.BufferAttribute(skirtMeltBirths,1));skirtGeo.setIndex(skirtIndices);skirtGeo.computeVertexNormals();skirtGeo.computeBoundingSphere();
    const skirtMesh=new THREE.Mesh(skirtGeo,earthTileMat);skirtMesh.receiveShadow=true;skirtMesh.renderOrder=1;group.add(skirtMesh);
    if(waterIndices.length){
      const wg=new THREE.BufferGeometry();wg.setAttribute('position',new THREE.BufferAttribute(waterPositions,3));wg.setAttribute('uv',new THREE.BufferAttribute(uvs.slice(),2));wg.setAttribute('earthWaterEdge',new THREE.BufferAttribute(waterEdges,1));wg.setIndex(waterIndices);wg.computeVertexNormals();wg.computeBoundingSphere();
      const waterMesh=new THREE.Mesh(wg,earthWaterMat);waterMesh.renderOrder=3;group.add(waterMesh);
    }
    earth.mesh.add(group);
    const tile={key,group,mesh,skirtMesh,lastUsed:earthSurfaceTiles.frame,center:center.clone(),anchor,qi:qi.clone(),N,localDirs,baseRadii,perimeter,skirtRadials,skirtDepth};earthSurfaceTiles.tiles.set(key,tile);return tile;
  }
  const earthDeformDir=new THREE.Vector3(),earthDeformPoint=new THREE.Vector3(),earthDeformRadial=new THREE.Vector3();
  function refreshEarthTileDeformation(tile,cr){
    const tileReach=earthSurfaceTiles.tileSize*.78;
    if(tile.center.distanceTo(cr.n)*earth.r>cr.R*1.35+tileReach)return;
    const attr=tile.mesh.geometry.attributes.position,meltStrengthAttr=tile.mesh.geometry.attributes.earthMeltStrength,meltBirthAttr=tile.mesh.geometry.attributes.earthMeltBirth;
    for(let k=0;k<tile.baseRadii.length;k++){
      const i=k*3;
      earthDeformDir.set(tile.localDirs[i],tile.localDirs[i+1],tile.localDirs[i+2]);
      const rr=tile.baseRadii[k]+earthCraterDispLocal(earthDeformDir);
      earthDeformPoint.copy(earthDeformDir).multiplyScalar(rr).addScaledVector(tile.center,-tile.anchor).applyQuaternion(tile.qi);
      attr.setXYZ(k,earthDeformPoint.x,earthDeformPoint.y,earthDeformPoint.z);
      const melt=sampleEarthMeltLocal(earthDeformDir);meltStrengthAttr.setX(k,melt.strength);meltBirthAttr.setX(k,melt.birth);
    }
    attr.needsUpdate=true;meltStrengthAttr.needsUpdate=true;meltBirthAttr.needsUpdate=true;tile.mesh.geometry.computeVertexNormals();tile.mesh.geometry.computeBoundingSphere();
    const skirtAttr=tile.skirtMesh.geometry.attributes.position,skirtMeltStrength=tile.skirtMesh.geometry.attributes.earthMeltStrength,skirtMeltBirth=tile.skirtMesh.geometry.attributes.earthMeltBirth;
    for(let e=0;e<tile.perimeter.length;e++){
      const vertex=tile.perimeter[e],dst=e*2;
      earthDeformRadial.set(tile.skirtRadials[e*3],tile.skirtRadials[e*3+1],tile.skirtRadials[e*3+2]);
      const x=attr.getX(vertex),y=attr.getY(vertex),z=attr.getZ(vertex);
      skirtAttr.setXYZ(dst,x,y,z);
      skirtAttr.setXYZ(dst+1,x-earthDeformRadial.x*tile.skirtDepth,y-earthDeformRadial.y*tile.skirtDepth,z-earthDeformRadial.z*tile.skirtDepth);
      const strength=meltStrengthAttr.getX(vertex),birth=meltBirthAttr.getX(vertex);
      skirtMeltStrength.setX(dst,strength);skirtMeltStrength.setX(dst+1,strength);skirtMeltBirth.setX(dst,birth);skirtMeltBirth.setX(dst+1,birth);
    }
    skirtAttr.needsUpdate=true;skirtMeltStrength.needsUpdate=true;skirtMeltBirth.needsUpdate=true;tile.skirtMesh.geometry.computeVertexNormals();tile.skirtMesh.geometry.computeBoundingSphere();
  }
  function refreshEarthTerrainDeformation(cr){
    for(const tile of earthSurfaceTiles.tiles.values())refreshEarthTileDeformation(tile,cr);
  }
  function updateEarthSurfaceTiles(){
    earthSurfaceTiles.frame++;
    const altitude=pos.distanceTo(earth.center)-earth.r,active=!earth.destroyed&&earthElevation.ready&&altitude<5000;
    if(!active){
      for(const tile of earthSurfaceTiles.tiles.values())tile.group.visible=false;
      earthSurfaceTiles.committedKeys.clear();earthSurfaceTiles.pendingKeys.clear();earthSurfaceTiles.pendingSignature='';
      earthSurfaceCutaway.cosRadius.value=2;return;
    }
    earthTileQ.copy(earth.mesh.quaternion).invert();earthTileN.copy(pos).sub(earth.center).normalize().applyQuaternion(earthTileQ).normalize();
    let lon=Math.atan2(earthTileN.z,-earthTileN.x);if(lon<0)lon+=Math.PI*2;const lat=Math.asin(Math.max(-1,Math.min(1,earthTileN.y)));
    const angular=earthSurfaceTiles.tileSize/earth.r,lonCells=Math.ceil(Math.PI*2/angular),latCells=Math.ceil(Math.PI/angular),lonStep=Math.PI*2/lonCells,latStep=Math.PI/latCells;
    const cx=Math.floor(lon/lonStep),cy=Math.max(0,Math.min(latCells-1,Math.floor((lat+Math.PI*.5)/latStep)));
    const signature=cx+':'+cy+':'+earthSurfaceTiles.activeRadius;
    const wanted=new Set(),missing=[];
    // Latitude/longitude cells narrow toward the poles. Expand the horizontal
    // ring there so the selected distance remains approximately circular.
    const lonRadius=Math.min(earthSurfaceTiles.activeRadius+4,Math.max(earthSurfaceTiles.activeRadius,Math.ceil(earthSurfaceTiles.activeRadius/Math.max(.35,Math.cos(lat)))));
    for(let dy=-earthSurfaceTiles.activeRadius;dy<=earthSurfaceTiles.activeRadius;dy++)for(let dx=-lonRadius;dx<=lonRadius;dx++){
      const ix=((cx+dx)%lonCells+lonCells)%lonCells,iy=Math.max(0,Math.min(latCells-1,cy+dy)),d=dx*dx+dy*dy,lod=d<=2?0:(d<=12?1:(d<=36?2:3)),key=ix+':'+iy+':'+lod;wanted.add(key);
      if(!earthSurfaceTiles.tiles.has(key))missing.push({ix,iy,lod,d});
    }
    if(signature!==earthSurfaceTiles.pendingSignature){
      earthSurfaceTiles.pendingSignature=signature;
      earthSurfaceTiles.pendingKeys=wanted;
      earthSurfaceTiles.pendingCenter.copy(earthTileN);
    }else earthSurfaceTiles.pendingKeys=wanted;

    // Keep the last fully built ring visible while its replacement streams.
    // This transactional handoff prevents missing rectangles when a jump or
    // fast landing crosses a tile boundary before the new LODs are ready.
    for(const tile of earthSurfaceTiles.tiles.values()){
      tile.group.visible=earthSurfaceTiles.committedKeys.has(tile.key);
      if(tile.group.visible)tile.lastUsed=earthSurfaceTiles.frame;
    }
    missing.sort((a,b)=>a.d-b.d||a.lod-b.lod);
    // Build outward from the player under a small per-frame budget. Ultra can
    // cover far more land without turning a single frame into a long pause.
    const buildStart=performance.now(),buildLimit=earthSurfaceTiles.activeRadius>=7?2:3;
    for(let i=0;i<Math.min(buildLimit,missing.length);i++){
      const m=missing[i],tile=buildEarthSurfaceTile(m.ix,m.iy,lonCells,latCells,m.lod);tile.group.visible=false;tile.lastUsed=earthSurfaceTiles.frame;
      if(i>0&&performance.now()-buildStart>6)break;
    }
    let complete=true;for(const key of earthSurfaceTiles.pendingKeys)if(!earthSurfaceTiles.tiles.has(key)){complete=false;break;}
    if(complete){
      for(const key of earthSurfaceTiles.committedKeys){const old=earthSurfaceTiles.tiles.get(key);if(old)old.group.visible=false;}
      earthSurfaceTiles.committedKeys=new Set(earthSurfaceTiles.pendingKeys);
      earthSurfaceTiles.committedCenter.copy(earthSurfaceTiles.pendingCenter);
      for(const key of earthSurfaceTiles.committedKeys){const tile=earthSurfaceTiles.tiles.get(key);if(tile){tile.group.visible=true;tile.lastUsed=earthSurfaceTiles.frame;}}
      earthSurfaceCutaway.center.value.copy(earthSurfaceTiles.committedCenter);
      earthSurfaceCutaway.cosRadius.value=Math.cos(earthSurfaceTiles.tileSize*(earthSurfaceTiles.activeRadius+.9)/earth.r);
    }
    // The tiles rotate with Earth, so their circular clipping centre must do
    // the same every frame. A frozen world-space value was the main source of
    // moving rectangular cut-outs during airborne camera movement.
    earthTileCenterWorld.value.copy(earthSurfaceTiles.committedCenter).applyQuaternion(earth.mesh.quaternion).normalize();
    const cacheMargin=Math.max(24,earthSurfaceTiles.activeRadius*8),cacheLimit=wanted.size+cacheMargin;
    if(earthSurfaceTiles.tiles.size>cacheLimit){
      const protectedKeys=new Set([...earthSurfaceTiles.committedKeys,...earthSurfaceTiles.pendingKeys]);
      const old=[...earthSurfaceTiles.tiles.values()].filter(t=>!protectedKeys.has(t.key)&&!t.group.visible).sort((a,b)=>a.lastUsed-b.lastUsed);
      const cacheTarget=wanted.size+Math.floor(cacheMargin*.5);
      while(earthSurfaceTiles.tiles.size>cacheTarget&&old.length){const tile=old.shift();earth.mesh.remove(tile.group);tile.group.traverse(o=>{if(o.geometry)o.geometry.dispose();});earthSurfaceTiles.tiles.delete(tile.key);}
    }
  }

  function horizDir() {
    tmpQ.setFromAxisAngle(smoothUp, -yaw);
    return tmpV.copy(fwdRef).applyQuaternion(tmpQ).normalize();
  }

  function doJump() {
    const power = JUMP_MIN + (JUMP_MAX - JUMP_MIN) * charge * charge;
    const dir = camDir.clone();
    const rc = dir.dot(up);
    if (rc < 0.25) dir.addScaledVector(up, 0.25 - rc).normalize();
    const h = horizDir().clone();
    const right = tmpV2.crossVectors(h, smoothUp).normalize();
    const mv = moveInput(h, right, new THREE.Vector3());
    vel.copy(dir).multiplyScalar(power).add(groundMotion).addScaledVector(mv, WALK_SPEED*.25);
    groundMotion.set(0,0,0);
    flightThrottle=0;flightBrake=0;
    grounded = false;
    jumpGrace = 0.25;
    takeoffBlend = 1;
    airborneTime = 0;
  }

  // M: the fastest speed HUMANS have ever travelled — Apollo 10's re-entry
  // record of 39,937.7 km/h (11,094 m/s; here in 1:10 scale units)
  function boostParker() {
    const dir = new THREE.Vector3();
    if (!grounded && vel.lengthSq() > 25) {
      dir.copy(vel).normalize(); // already moving: keep the heading, change ONLY the speed
    } else {
      dir.copy(camDir);
      if (grounded) {
        const rc = dir.dot(up);
        if (rc < 0.4) dir.addScaledVector(up, 0.4 - rc).normalize(); // climb out properly
        grounded = false;
        jumpGrace = 0.5;
      }
    }
    vel.copy(dir).multiplyScalar(1109.4);
    fuel = Math.max(0, fuel - 10);
  }

  function segHitsSphere(a, b, c, R) {
    const ab = tmpV3.copy(b).sub(a);
    const len2 = ab.lengthSq();
    if (len2 < 1e-9) return false;
    let t = tmpV.copy(c).sub(a).dot(ab) / len2;
    t = Math.max(0, Math.min(1, t));
    const closest = tmpV.copy(a).addScaledVector(ab, t);
    return closest.distanceTo(c) < R;
  }

  function findSurfaceContact(p,a,b,out){
    // Binary-search the actual displaced surface along the travelled segment.
    // This removes the old early-landing snap and remains reliable at high speed.
    let lo=0,hi=1;
    for(let i=0;i<10;i++){
      const t=(lo+hi)*.5;
      out.copy(a).lerp(b,t);
      const n=tmpV3.copy(out).sub(p.center),r=n.length();
      if(r<1e-7){hi=t;continue;}
      n.divideScalar(r);
      const sr=surfaceR(p,n);
      if(sr>=0&&r<=sr+PLAYER_FEET)hi=t;else lo=t;
    }
    return out.copy(a).lerp(b,hi);
  }

  // true ground height including crater deformation. Interpolated on the SAME
  // vertex grid as the rendered mesh, so the physics floor IS the visible floor.
  const srV = new THREE.Vector3(), srQ = new THREE.Quaternion(), srA = new THREE.Vector3();
  const SR_W = 192, SR_H = 144;
  function dispAt(p, i, j) {
    const phi = i / SR_W * Math.PI * 2;
    const theta = j / SR_H * Math.PI;
    const st = Math.sin(theta);
    srA.set(-Math.cos(phi) * st, Math.cos(theta), Math.sin(phi) * st);
    let d2 = 0;
    for (const cr of p.craters) d2 += craterDisp(cr, srA.distanceTo(cr.n) * p.r);
    return Math.max(d2, -p.r * 0.998);
  }
  function surfaceR(p, nWorld) {
    if (p === earth) {
      let base=earthSurfaceRadiusWorld(nWorld,false);
      if (!p.craters || p.craters.length===0) return base;
      srQ.copy(p.mesh.quaternion).invert();srV.copy(nWorld).applyQuaternion(srQ);
      let disp=0;
      for(const cr of p.craters){
        const distance=srV.distanceTo(cr.n)*p.r;
        if(cr.pierced&&distance<cr.R*.55)return -1;
        disp+=craterDisp(cr,distance);
      }
      return Math.max(p.r*.002,base+disp)+.18;
    }
    if (!p.craters || p.craters.length === 0) return p.r;
    srQ.copy(p.mesh.quaternion).invert();
    srV.copy(nWorld).applyQuaternion(srQ);
    for (const cr of p.craters) {
      if (cr.pierced && srV.distanceTo(cr.n) * p.r < cr.R * 0.55) return -1; // open tunnel
    }
    const theta = Math.acos(Math.max(-1, Math.min(1, srV.y)));
    let phi = Math.atan2(srV.z, -srV.x);
    if (phi < 0) phi += Math.PI * 2;
    const fu = Math.min(phi / (Math.PI * 2) * SR_W, SR_W - 1e-6);
    const fv = Math.min(theta / Math.PI * SR_H, SR_H - 1e-6);
    const i0 = Math.floor(fu), j0 = Math.floor(fv);
    const tu = fu - i0, tv = fv - j0;
    const d00 = dispAt(p, i0, j0), d10 = dispAt(p, i0 + 1, j0);
    const d01 = dispAt(p, i0, j0 + 1), d11 = dispAt(p, i0 + 1, j0 + 1);
    let disp;
    if (tu >= tv) disp = (1 - tu) * d00 + (tu - tv) * d10 + tv * d11; // upper triangle
    else disp = (1 - tv) * d00 + (tv - tu) * d01 + tu * d11;          // lower triangle
    return Math.max(p.r * 0.002, p.r + disp) + 1.5;                   // safety lift
  }

  let toastTimer = null;
  function toast(text) {
    const el = document.getElementById('toast');
    el.textContent = text;
    el.style.opacity = 1;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.style.opacity = 0; }, 2200);
  }

  function enterBlackhole() {
    // A classical event horizon is one-way. The old mirrored-universe
    // teleport was a visual fantasy, not a result of general relativity.
    // Treat horizon crossing as loss of the mission and restore the player at
    // the home body, just like every other unrecoverable encounter.
    renderer.domElement.style.filter = '';
    toast('EVENT HORIZON CROSSED · NO OUTWARD TRAJECTORY');
    spawnOn(homePlanet());
  }

  function landOn(p,contactPoint) {
    if (p.blackhole) { enterBlackhole(); return; }
    if (p.deadly) {
      spawnOn(homePlanet());
      return;
    }
    if(contactPoint)pos.copy(contactPoint);
    groundPlanet = p;
    const n = tmpV.copy(pos).sub(p.center).normalize();
    const relativeLandingVel = p === airCarry ? vel : tmpV2.copy(vel).sub(p.velNow);
    const impactSpeed = Math.max(0, -relativeLandingVel.dot(n));
    earthInWater=p===earth&&earthWaterAtWorld(n);
    // Legs absorb ordinary landings over a short compression interval. Impact
    // animation begins gently below 2 m/s and reaches full depth around the
    // upper edge of survivable feet-first landing speed.
    landingImpact = earthInWater
      ? Math.max(.05,Math.min(.34,impactSpeed/12))
      : THREE.MathUtils.clamp((impactSpeed-1.4)/7.2,.08,1);
    landingStrength=landingImpact;landingAge=0;
    const tangentVelocity=landingSlide.copy(relativeLandingVel).addScaledVector(n,-relativeLandingVel.dot(n));
    if(tangentVelocity.length()>18)tangentVelocity.setLength(18);
    groundMotion.copy(tangentVelocity);
    if(groundMotion.length()>RUN_SPEED)groundMotion.setLength(RUN_SPEED);
    landingSlide.sub(groundMotion);
    vel.set(0, 0, 0);
    groundMotion.set(0,0,0);flightThrottle=0;flightBrake=0;
    if(!contactPoint){
      const srL = surfaceR(p, n);
      pos.copy(p.center).addScaledVector(n, (srL < 0 ? p.r : srL) + PLAYER_FEET);
    }
    grounded = true;
    up.copy(n);
    if (target === p) { target = null; document.getElementById('targetBanner').style.display = 'none'; }
    if (!visited.has(p.name)) {
      visited.add(p.name);
      saveVisited();
    }
  }

  function toggleTarget() {
    const banner = document.getElementById('targetBanner');
    if (target) { target = null; banner.style.display = 'none'; return; }
    let best = null, bestAng = 0.45;
    for (const p of planets) {
      if (grounded && p === groundPlanet) continue;
      const dir = tmpV.copy(p.center).sub(pos).normalize();
      const ang = Math.acos(Math.max(-1, Math.min(1, dir.dot(camDir))));
      if (ang < bestAng) { bestAng = ang; best = p; }
    }
    if (best) {
      target = best;
      banner.style.display = 'block';
      toast('Locked: ' + best.name);
    } else {
      toast('No planet in the crosshair');
    }
  }

  // ---------- Overview camera (C) ----------
  function toggleOverview() {
    overview = !overview;
    if (overview) {
      oyaw = yaw; opitch = 0.5;
      let dBest = Infinity, rr = 6.371e5;
      for (const p of planets) {
        const ds = pos.distanceTo(p.center) - p.r;
        if (ds < dBest) { dBest = ds; rr = p.r; }
      }
      overviewDist = Math.max((dBest + rr) * 3, rr * 12);
      overviewZoomTarget = overviewDist;
    }
    document.getElementById('crosshair').style.display = overview ? 'none' : 'block';
    document.getElementById('youAreHere').style.display = overview && !universeAnnotationsHidden ? 'block' : 'none';
  }
  // ---------- Asteroid strikes ----------
  function raySphere(o, d, c, R) {
    const oc = tmpV.copy(o).sub(c);
    const b = oc.dot(d);
    const disc = b * b - (oc.lengthSq() - R * R);
    if (disc < 0) return -1;
    const s = Math.sqrt(disc);
    const t1 = -b - s;
    if (t1 > 0) return t1;
    const t2 = -b + s;
    return t2 > 0 ? t2 : -1;
  }
  function fireAsteroid() {
    if (elapsed - lastFire < 0.25) return;
    let tgt = target, hitT = -1;
    if (!tgt) {
      let bestAng = 0.3;
      for (const p of planets) {
        const t = raySphere(pos, camDir, p.center, p.r);
        if (t > 0) { tgt = p; hitT = t; break; }
        const dir = tmpV2.copy(p.center).sub(pos).normalize();
        const ang = Math.acos(Math.max(-1, Math.min(1, dir.dot(camDir))));
        if (ang < bestAng) { bestAng = ang; tgt = p; }
      }
    }
    if (!tgt) { return; }
    lastFire = elapsed;
    let impactN;
    const t = hitT > 0 ? hitT : raySphere(pos, camDir, tgt.center, tgt.r);
    if (t > 0) {
      impactN = tmpV.copy(pos).addScaledVector(camDir, t).sub(tgt.center).normalize().clone();
    } else {
      const tc = Math.max(0, tmpV2.copy(tgt.center).sub(pos).dot(camDir));
      impactN = tmpV.copy(pos).addScaledVector(camDir, tc).sub(tgt.center).normalize().clone();
    }
    const impactW = tgt.center.clone().addScaledVector(impactN, tgt.r);
    const size = Math.max(2, Math.min(tgt.r * 0.002, 800));
    const tang = new THREE.Vector3().crossVectors(impactN, V3(0.3, 1, 0.2).normalize()).normalize();
    const startW = impactW.clone().addScaledVector(impactN, tgt.r * 1.6)
      .addScaledVector(tang, tgt.r * 0.04 * (Math.random() - 0.5));
    const flightT = 2.2;
    const velA = impactW.clone().sub(startW).divideScalar(flightT);
    const mesh = new THREE.Mesh(
      new THREE.DodecahedronGeometry(size, 1),
      new THREE.MeshPhongMaterial({ color: 0x6e5a48, emissive: 0x1a0d04, shininess: 8 })
    );
    const fire = new THREE.Sprite(new THREE.SpriteMaterial({
      map: softSprite('rgba(255,180,80,0.9)', 'rgba(255,90,20,0.4)'),
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
    }));
    fire.scale.set(size * 5, size * 5, 1);
    mesh.add(fire);
    scene.add(mesh);
    asteroids.push({ mesh: mesh, w: startW, vel: velA, tgt: tgt, size: size,
      n: impactN.clone(),
      nL: impactN.clone().applyQuaternion(tgt.mesh.quaternion.clone().invert()),
      tLeft: flightT });
    sfxWhoosh(flightT);
  }

  function deformCrater(p, nWorld, size, laser=false) {
    if (p.isStar || p.destroyed) return null;
    const invQ = p.mesh.quaternion.clone().invert();
    const nLocal = nWorld.clone().applyQuaternion(invQ);
    if (!p.craters) p.craters = [];
    let cr = null;
    if(laser){
      // A high-energy beam ablates a broad surface basin. It melts and ejects
      // crust, but it does not magically remove an entire planetary core in a
      // few seconds; the resulting floor remains solid and landable.
      let nearest=Infinity;
      for(const c of p.craters){
        if(!c.laser)continue;
        const d=c.n.distanceTo(nLocal)*p.r,tolerance=Math.max(c.R*1.8,p.r*.12);
        if(d<tolerance&&d<nearest){nearest=d;cr=c;}
      }
      if(!cr){
        const initialR=Math.max(120,Math.min(p.r*.032,28000));
        cr={n:nLocal.clone(),R:initialR,depth:initialR*.1,laser:true,lastHeat:elapsed};
        p.craters.push(cr);
      }
      cr.R=Math.min(Math.max(320,p.r*.045),cr.R+Math.max(24,p.r*.0025));
      cr.depth=Math.min(cr.R*.24,cr.depth+Math.max(12,p.r*.0008));
      cr.n.lerp(nLocal,.08).normalize();cr.lastHeat=elapsed;
    } else {
      // Realistic asteroid impact: a wide, shallow bowl.
      for (const c of p.craters) {
        if (!c.laser&&c.n.distanceTo(nLocal) * p.r < c.R * 0.9) { cr = c; break; }
      }
      if (cr) {
        cr.R = Math.min(p.r * 0.5, cr.R * 1.06);
        cr.depth = Math.min(cr.R * 0.2, cr.depth * 1.05);
      } else {
        const baseR = Math.min(p.r * 0.42, Math.max(p.r * 0.09, (size || 10) * 90));
        cr = { n: nLocal.clone(), R: baseR, depth: baseR * 0.18 };
        p.craters.push(cr);
      }
    }
    // Earth's walking-scale tiles have much more detail than its orbital mesh;
    // update those vertices in place so deformation is immediate and stable.
    if(p===earth){
      refreshEarthTerrainDeformation(cr);
      for(const patch of earthMountainPatches){
        if(patch.centerLocal.distanceTo(cr.n)*earth.r<cr.R+22000)patch.mesh.visible=false;
      }
    }
    reapplyCraters(p,cr);
    return cr;
  }
  // real impact-crater profile (bowl + raised rim), shared by visuals AND physics
  function craterDisp(cr, d) {
    const tt = d / cr.R;
    if(cr.laser){
      if(tt<=.3){const q=tt/.3;return-cr.depth*(1-.07*q*q);}
      if(tt<=1){const q=(tt-.3)/.7,s=q*q*(3-2*q);return-cr.depth*(.93*(1-s))+.035*cr.depth*Math.sin(q*Math.PI)*Math.sin(q*Math.PI);}
      if(tt<1.18){const q=(tt-1)/.18,c=Math.cos(q*Math.PI/2);return.045*cr.depth*c*c;}
      return 0;
    }
    if (tt <= 1) {
      const c = Math.cos(tt * Math.PI / 2);
      return -cr.depth * c * c + 0.18 * cr.depth * Math.sin(tt * Math.PI) * Math.sin(tt * Math.PI);
    } else if (tt < 1.3) {
      const e2 = (tt - 1) / 0.3;
      const c = Math.cos(e2 * Math.PI / 2);
      return 0.15 * cr.depth * c * c;
    }
    return 0;
  }
  const earthCraterVertexDirection=new THREE.Vector3();
  function prepareEarthCraterVertices(p,cr,base){
    const neededRadius=cr.laser?p.r*.058:Math.min(p.r*.68,Math.max(cr.R*1.4,p.r*.14));
    if(cr._earthVertexIndices&&cr._earthVertexRadius>=neededRadius)return;
    const maxChord=neededRadius/p.r,indices=[];
    for(let i=0;i<base.length;i+=3){
      const x=base[i],y=base[i+1],z=base[i+2],inv=1/Math.sqrt(x*x+y*y+z*z);
      const dx=x*inv-cr.n.x,dy=y*inv-cr.n.y,dz=z*inv-cr.n.z;
      if(dx*dx+dy*dy+dz*dz<=maxChord*maxChord)indices.push(i/3);
    }
    cr._earthVertexIndices=new Uint32Array(indices);cr._earthVertexRadius=neededRadius;
  }
  function reapplyCraters(p,focusCrater=null) {
    // Recalculate absolute radii in place. Normalizing the current vertex first
    // prevents cumulative distortion, while avoiding a new 28k-vertex geometry
    // allocation on every laser tick.
    const geo = p.mesh.geometry;
    const attr = geo.attributes.position;
    const v = new THREE.Vector3();
    const base=p===earth?(p._baseTerrainPositions||(p._baseTerrainPositions=new Float32Array(attr.array))):null;
    let indices=null,minIndex=0,maxIndex=attr.count-1;
    if(base&&focusCrater){
      prepareEarthCraterVertices(p,focusCrater,base);indices=focusCrater._earthVertexIndices;
      if(indices.length){minIndex=indices[0];maxIndex=indices[indices.length-1];}
    }
    const count=indices?indices.length:attr.count;
    for (let k = 0; k < count; k++) {
      const i=indices?indices[k]:k,offset=i*3;
      if(base)v.set(base[offset],base[offset+1],base[offset+2]);
      else v.set(attr.getX(i),attr.getY(i),attr.getZ(i));
      const baseRadius=v.length(),vu=v.divideScalar(baseRadius);
      let disp = 0;
      for (const cr of p.craters) disp += craterDisp(cr, vu.distanceTo(cr.n) * p.r);
      const nl = baseRadius + Math.max(disp, -p.r * 0.998);
      attr.setXYZ(i, vu.x * nl, vu.y * nl, vu.z * nl);
    }
    if(indices&&indices.length){attr.updateRange.offset=minIndex*3;attr.updateRange.count=(maxIndex-minIndex+1)*3;}
    else{attr.updateRange.offset=0;attr.updateRange.count=-1;}
    attr.needsUpdate=true;
    if(p===earth){p._craterNormalsDirty=true;attr.setUsage(THREE.DynamicDrawUsage);}
    else{geo.computeVertexNormals();geo.computeBoundingSphere();}
    p.mesh.material.side = THREE.DoubleSide; // never see space through the ground
    p.mesh.material.needsUpdate = true;
  }
  let earthCraterNormalJob=false;
  function finishEarthCraterNormals(){
    if(!earth._craterNormalsDirty||earthCraterNormalJob)return;
    earthCraterNormalJob=true;
    const finish=()=>{
      earthCraterNormalJob=false;
      if(laserFiring){finishEarthCraterNormals();return;}
      earth.mesh.geometry.computeVertexNormals();
      earth.mesh.geometry.attributes.normal.needsUpdate=true;
      earth._craterNormalsDirty=false;
    };
    if(typeof requestIdleCallback==='function')requestIdleCallback(finish,{timeout:500});else setTimeout(finish,30);
  }

  function scorchTexture(p, nLocal, craterR) {
    try {
      const img = p.tex.image;
      if (!img || !img.getContext) return;
      const w = img.width, h = img.height;
      const x = img.getContext('2d');
      const theta = Math.acos(Math.max(-1, Math.min(1, nLocal.y)));
      let phi = Math.atan2(nLocal.z, -nLocal.x);
      if (phi < 0) phi += Math.PI * 2;
      const px = phi / (Math.PI * 2) * w;
      const py = theta / Math.PI * h;
      const pr = Math.max(5, craterR / p.r / Math.PI * h * 1.3);
      function paint(cx) {
        const g = x.createRadialGradient(cx, py, pr * 0.1, cx, py, pr);
        g.addColorStop(0, 'rgba(10,6,4,0.96)');
        g.addColorStop(0.55, 'rgba(22,12,8,0.9)');
        g.addColorStop(0.8, 'rgba(40,20,10,0.55)');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        x.fillStyle = g;
        x.beginPath(); x.arc(cx, py, pr, 0, Math.PI * 2); x.fill();
        // molten rim
        x.globalAlpha = 0.85;
        x.strokeStyle = '#ff7a22';
        x.lineWidth = Math.max(1.5, pr * 0.07);
        x.beginPath(); x.arc(cx, py, pr * 0.82, 0, Math.PI * 2); x.stroke();
        // lava cracks radiating from the centre
        for (let i = 0; i < 10; i++) {
          const a = Math.random() * Math.PI * 2;
          x.globalAlpha = 0.8;
          x.strokeStyle = Math.random() > 0.4 ? '#ff5a12' : '#ffb24a';
          x.lineWidth = 1 + Math.random() * 1.5;
          x.beginPath();
          let qx = cx + Math.cos(a) * pr * 0.1, qy = py + Math.sin(a) * pr * 0.1;
          x.moveTo(qx, qy);
          for (let s2 = 0; s2 < 4; s2++) {
            qx += Math.cos(a + (Math.random() - 0.5)) * pr * 0.2;
            qy += Math.sin(a + (Math.random() - 0.5)) * pr * 0.2;
            x.lineTo(qx, qy);
          }
          x.stroke();
        }
        // embers
        for (let i = 0; i < 26; i++) {
          x.globalAlpha = 0.5 + Math.random() * 0.5;
          x.fillStyle = Math.random() > 0.5 ? '#ff6a1a' : '#ffd24a';
          const ea = Math.random() * Math.PI * 2, er = pr * (0.2 + Math.random() * 0.75);
          x.fillRect(cx + Math.cos(ea) * er, py + Math.sin(ea) * er, 1.6, 1.6);
        }
        x.globalAlpha = 1;
      }
      paint(px);
      if (px - pr < 0) paint(px + w);
      if (px + pr > w) paint(px - w);
      p.tex.needsUpdate = true;
      // the wound GLOWS in the dark
      const m2 = p.mesh.material;
      if (!m2.emissiveMap || !m2.emissiveMap.image || !m2.emissiveMap.image.getContext) {
        const ec = document.createElement('canvas');
        ec.width = w; ec.height = h;
        const exi = ec.getContext('2d');
        exi.fillStyle = '#000'; exi.fillRect(0, 0, w, h);
        m2.emissiveMap = new THREE.CanvasTexture(ec);
        m2.emissiveMap.wrapS = THREE.RepeatWrapping;
        if (m2.emissive.getHex() === 0) m2.emissive.setHex(0xff8844);
        if (!m2.emissiveIntensity || m2.emissiveIntensity < 0.5) m2.emissiveIntensity = 0.85;
      }
      const ei = m2.emissiveMap.image;
      const ex2 = ei.getContext('2d');
      const sx = ei.width / w, sy = ei.height / h;
      const eg = ex2.createRadialGradient(px * sx, py * sy, pr * 0.05 * sx, px * sx, py * sy, pr * 0.9 * sx);
      eg.addColorStop(0, 'rgba(255,140,50,0.9)');
      eg.addColorStop(0.5, 'rgba(255,80,20,0.45)');
      eg.addColorStop(1, 'rgba(0,0,0,0)');
      ex2.fillStyle = eg;
      ex2.beginPath(); ex2.arc(px * sx, py * sy, pr * 0.95 * sx, 0, Math.PI * 2); ex2.fill();
      m2.emissiveMap.needsUpdate = true;
      m2.needsUpdate = true;
    } catch (e) {}
  }

  const debris = [];
  function homePlanet() {
    if (!earth.destroyed) return earth;
    for (const p of planets) if (!p.isStar && !p.destroyed) return p;
    return planets[0];
  }
  function destroyPlanet(p) {
    if (p.destroyed) return;
    p.destroyed = true;
    for (let i = 0; i < 18; i++) {
      let dirD;
      do {
        dirD = new THREE.Vector3(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1);
      } while (dirD.lengthSq() > 1 || dirD.lengthSq() < 0.05);
      dirD.normalize();
      const m = new THREE.Mesh(
        new THREE.DodecahedronGeometry(p.r * (0.06 + Math.random() * 0.12), 0),
        new THREE.MeshPhongMaterial({ color: 0x6e5a48, emissive: 0x331505 })
      );
      scene.add(m);
      debris.push({
        mesh: m,
        w: p.center.clone().addScaledVector(dirD, p.r * (0.2 + Math.random() * 0.8)),
        vel: dirD.clone().multiplyScalar(p.r * (0.15 + Math.random() * 0.35)),
        spin: new THREE.Vector3(Math.random() * 2, Math.random() * 2, Math.random() * 2),
        age: 0
      });
    }
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({
      map: softSprite('rgba(255,245,210,1)', 'rgba(255,120,30,0.6)'),
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
    }));
    spr.scale.setScalar(p.r);
    scene.add(spr);
    booms.push({ spr: spr, w: p.center.clone(), age: 0, dur: 3, base: p.r * 2 });
    boomW.copy(p.center); boomAge = 0; boomDur = 2.5;
    boomLight.distance = p.r * 40;
    const goners = new Set([p.mesh, p.atmoMesh, p.cloudMesh, p.ringMesh,
      p.labelEntry && p.labelEntry.spr].filter(Boolean));
    for (let i = renderObjs.length - 1; i >= 0; i--) {
      if (goners.has(renderObjs[i].o)) { scene.remove(renderObjs[i].o); renderObjs.splice(i, 1); }
    }
    for (let i = labels.length - 1; i >= 0; i--) if (labels[i].body === p) labels.splice(i, 1);
    const pi = planets.indexOf(p);
    if (pi >= 0) planets.splice(pi, 1);
    if (target === p) { target = null; document.getElementById('targetBanner').style.display = 'none'; }
    if (airCarry === p) airCarry = null;
    if (groundPlanet === p) { grounded = false; groundPlanet = homePlanet(); vel.set(0, 0, 0); jumpGrace = 1; }
    sfxBoom();
  }

  function explode(p, nWorld, size) {
    if (p.destroyed) { sfxBoom(); return; }
    const impactW = p.center.clone().addScaledVector(nWorld, p.r);
    const crRec = deformCrater(p, nWorld, size);
    if (crRec) {
      const nL = nWorld.clone().applyQuaternion(p.mesh.quaternion.clone().invert());
      scorchTexture(p, nL, crRec.R);
    }
    sfxBoom();
    const base = Math.max(p.r * 0.6, size * 24);
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({
      map: softSprite('rgba(255,240,200,1)', 'rgba(255,120,30,0.55)'),
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
    }));
    spr.scale.set(base * 0.3, base * 0.3, 1);
    scene.add(spr);
    booms.push({ spr: spr, w: impactW, age: 0, dur: 1.6, base: base });
    boomW.copy(impactW); boomAge = 0; boomDur = 1.2;
    boomLight.distance = p.r * 2;
    if (p === groundPlanet && grounded) squash = 0.7;
  }

  // ---------- HUD ----------
  const hudPlanet = document.getElementById('hudPlanet');
  const hudAlt = document.getElementById('hudAlt');
  const hudSpeed = document.getElementById('hudSpeed');
  const hudGrav = document.getElementById('hudGrav');
  const chargeWrap = document.getElementById('chargeWrap');
  const chargeBar = document.getElementById('chargeBar');
  const fuelBar = document.getElementById('fuelBar');
  const targetBanner = document.getElementById('targetBanner');

  function fmtDist(m) {
    const real = m * 10;
    if (real < 1e4) return real.toFixed(0) + ' m';
    if (real < 1e8) return (real / 1e3).toFixed(1) + ' km';
    if (real < 0.5 * 9.461e15) return (real / 1.496e11).toFixed(3) + ' AU';
    return (real / 9.461e15).toFixed(2) + ' ly';
  }
  function fmtSpeed(v) {
    const real = v * 10;
    if (real < 1e4) return real.toFixed(0) + ' m/s';
    if (real < 1e7) return (real / 1e3).toFixed(1) + ' km/s';
    return (real / 2.998e8).toFixed(2) + ' c';
  }
  function fmtLocalSpeed(v){
    if(v<10)return v.toFixed(1)+' m/s';
    if(v<1000)return v.toFixed(0)+' m/s';
    return (v/1000).toFixed(1)+' km/s';
  }

  const rebaseShift = new THREE.Vector3();
  const rebaseSeen = new Set();
  function rebaseUniverse() {
    if (pos.lengthSq() < 1) return;
    rebaseShift.copy(pos);
    rebaseSeen.clear();
    for (const ro of renderObjs) {
      if (!rebaseSeen.has(ro.w)) { ro.w.sub(rebaseShift); rebaseSeen.add(ro.w); }
    }
    for (const p of planets) p.prevCenter.sub(rebaseShift);
    for (const s of catalogStars) s.center.sub(rebaseShift);
    for (const a of asteroids) a.w.sub(rebaseShift);
    for (const b of booms) b.w.sub(rebaseShift);
    for (const dd of debris) dd.w.sub(rebaseShift);
    boomW.sub(rebaseShift);
    prevPos.sub(rebaseShift);
    pos.set(0, 0, 0);
  }

  spawnOn(homePlanet());
  // build all surface relief behind the loading screen
  (function buildRelief() {
    loadTotal = reliefQueue.length + 1; // +1 for Earth's city lights
    loadBar.style.width = '2%';
    const h2 = setInterval(() => {
      const o = reliefQueue.shift();
      if (!o) { clearInterval(h2); return; }
      try {
        const m2 = o.mesh.material;
        let sharedNormal=reliefNormalCache.get(o.tex);
        if(!sharedNormal){sharedNormal=normalFromCanvas(o.tex.image,2.2);reliefNormalCache.set(o.tex,sharedNormal);}
        m2.normalMap = sharedNormal;
        m2.normalScale = new THREE.Vector2(0.85, 0.85);
        m2.bumpMap = null;
        m2.needsUpdate = true;
      } catch (e) {}
      loadTick('Sculpting ' + o.name + '...');
    }, 60);
  })();

  // ---------- Main loop ----------
  const clock = new THREE.Clock();
  let elapsed = 0;
  const adaptiveQuality=new window.GodmanAdaptiveQuality(renderer,CONFIG.renderer,()=>{
    if(composer)composer.setSize(innerWidth,innerHeight);
    if(stylePass)stylePass.uniforms.resolution.value.set(innerWidth,innerHeight);
  });
  adaptiveQuality.setPreference(parseFloat(document.getElementById('setQuality').value));
  const frameScratch={
    prevUp:new THREE.Vector3(),h:new THREE.Vector3(),right:new THREE.Vector3(),move:new THREE.Vector3(),
    groundDesired:new THREE.Vector3(),relativeVel:new THREE.Vector3(),
    groundN:new THREE.Vector3(),targetCross:new THREE.Vector3(),lookTarget:new THREE.Vector3(),
    playerQ:new THREE.Quaternion(),playerForward:new THREE.Vector3(),playerCross:new THREE.Vector3(),
    yawQ:new THREE.Quaternion(),leanQ:new THREE.Quaternion(),overviewQ:new THREE.Quaternion(),overviewDir:new THREE.Vector3(),
    localUp:new THREE.Vector3(0,1,0),localForward:new THREE.Vector3(0,0,-1),localRight:new THREE.Vector3(1,0,0)
  };

  function animate() {
    requestAnimationFrame(animate);
    const dt = Math.min(clock.getDelta(), 0.05);
    elapsed += dt;
    for(const material of stellarSurfaceMaterials)material.uniforms.time.value=elapsed;
    jumpGrace = Math.max(0, jumpGrace - dt);
    rebaseUniverse();
    updateStreamedMilkySystem(elapsed);

    // --- planetary motion: orbits + axial spin at real (compressed) rates ---
    const simdt = dt * TIME_SCALE;
    for (const p of planets) {
      if (p.orbit) {
        p.prevCenter.copy(p.center);
        p.orbit.ang += p.orbit.w * simdt;
        const oa = p.orbit.ang, oi = p.orbit.inc, oR = p.orbit.R, c0 = p.orbit.parent.center;
        p.center.set(
          c0.x + oR * Math.cos(oa),
          c0.y + oR * Math.sin(oa) * Math.sin(oi),
          c0.z + oR * Math.sin(oa) * Math.cos(oi));
        p.velNow.copy(p.center).sub(p.prevCenter).divideScalar(dt);
      }
      if (p.spinW) {
        tmpQ.setFromAxisAngle(p.spinAxis, p.spinW * simdt);
        p.mesh.quaternion.premultiply(tmpQ);
      }
      // cull worlds that are smaller than a pixel (their glows/labels remain)
      const visCull = target===p || pos.distanceTo(p.center) < p.r * 8000;
      p.mesh.visible = visCull;
      if (p.atmoMesh) p.atmoMesh.visible = visCull;
      if (p.cloudMesh) p.cloudMesh.visible = visCull;
      if (p.ringMesh) p.ringMesh.visible = visCull;
      if (p.nightMesh) p.nightMesh.visible = visCull;
      if (p.atmoMat && visCull) {
        p.atmoMat.uniforms.sunDirection.value.copy(nearestStarTo(p.center).center).sub(p.center).normalize();
      }
    }
    // --- co-rotating frame: near a world you move WITH it (orbit + spin) ---
    if (grounded) {
      airCarry = groundPlanet;
    } else {
      let want = null, bd = Infinity;
      for (const p of planets) {
        if (p.isStar) continue;
        const ds = pos.distanceTo(p.center) - p.r;
        if (ds < bd) { bd = ds; want = (ds < p.r * 1.5) ? p : null; }
      }
      if (want !== airCarry) {
        if (airCarry) vel.add(frameVel(airCarry, pos, tmpV));  // leave frame: gain its velocity
        if (want) vel.sub(frameVel(want, pos, tmpV));          // enter frame: motion becomes relative
        airCarry = want;
      }
    }
    if (airCarry) {
      const gp = airCarry;
      if (gp.orbit) pos.add(tmpV.copy(gp.center).sub(gp.prevCenter));
      if (gp.spinW) {
        const qs = tmpQ.setFromAxisAngle(gp.spinAxis, gp.spinW * simdt);
        pos.sub(gp.center).applyQuaternion(qs).add(gp.center);
        vel.applyQuaternion(qs);
        up.applyQuaternion(qs);
        smoothUp.applyQuaternion(qs).normalize();
        fwdRef.applyQuaternion(qs);
        lastFacing.applyQuaternion(qs);
      }
      if (grounded) prevPos.copy(pos);
    }
    if (earth.cloudMesh) earth.cloudMesh.rotateY(0.01 * dt);
    if (earth.nightMesh) {
      earth.nightMesh.quaternion.copy(earth.mesh.quaternion);
      earth.nightMat.uniforms.sunDirection.value.copy(sun.center).sub(earth.center).normalize();
    }
    earthWaterTime.value=elapsed;earthTerrainTime.value=elapsed;
    for (const bb of blackhole.diskBands) bb.mesh.rotateZ(bb.w * dt);

    // --- SOI gravity ---
    let domBody = null, domFrac = Infinity;
    for (const p of planets) {
      if (p.isStar) continue;
      const frac = pos.distanceTo(p.center) / p.soi;
      if (frac < 1 && frac < domFrac) { domFrac = frac; domBody = p; }
    }
    if (!domBody) {
      let bestG = -1;
      for (const s of stars) {
        if (s.blackhole && pos.distanceTo(s.center) > s.r * 10) continue;
        const d = Math.max(pos.distanceTo(s.center), s.r * 0.6);
        const g = s.g * (s.r / d) * (s.r / d);
        if (g > bestG) { bestG = g; domBody = s; }
      }
    }
    const dDom = Math.max(pos.distanceTo(domBody.center), domBody.r * 0.6);
    const gDom = domBody.g * (domBody.r / dDom) * (domBody.r / dDom);
    const accel = tmpV2.copy(domBody.center).sub(pos).normalize().multiplyScalar(gDom);

    let distSurf = Infinity, nearestP = planets[0];
    for (const p of planets) {
      let pr = p.r;
      if (p.craters) {
        pr = surfaceR(p, tmpV.copy(pos).sub(p.center).normalize());
        if (pr < 0) pr = p.r * 0.02;
      }
      const ds = pos.distanceTo(p.center) - pr;
      if (ds < distSurf) { distSurf = ds; nearestP = p; }
    }
    if (grounded) {
      up.copy(pos).sub(groundPlanet.center).normalize();
    } else if (distSurf < nearestP.r * 6) {
      // close to a world: align with its surface for landing
      up.copy(pos).sub(nearestP.center).normalize();
    } else {
      // deep-space cruise: hold a stable horizon — no flipping when
      // gravity fields hand over mid-flight
      up.copy(smoothUp);
    }
    const prevUp = frameScratch.prevUp.copy(smoothUp);
    smoothUp.lerp(up, 1 - Math.pow(grounded ? 0.002 : 0.03, dt)).normalize();
    tmpQ.setFromUnitVectors(prevUp, smoothUp);
    fwdRef.applyQuaternion(tmpQ);
    fwdRef.addScaledVector(smoothUp, -fwdRef.dot(smoothUp));
    if (fwdRef.lengthSq() < 1e-6) fwdRef.set(smoothUp.y, smoothUp.z, -smoothUp.x);
    fwdRef.normalize();

    if (target) {
      const dir = tmpV3.copy(target.center).sub(pos).normalize();
      const desiredPitch = Math.max(-1.45, Math.min(1.45,
        -Math.asin(Math.max(-1, Math.min(1, dir.dot(smoothUp))))));
      pitch = damp(pitch, desiredPitch, 3.2, dt);
      const dh = tmpV.copy(dir).addScaledVector(smoothUp, -dir.dot(smoothUp));
      if (dh.lengthSq() > 1e-9) {
        dh.normalize();
        const cr = frameScratch.targetCross.crossVectors(fwdRef, dh);
        const desiredYaw = -Math.atan2(cr.dot(smoothUp), fwdRef.dot(dh));
        yaw = dampAngle(yaw, desiredYaw, 3.2, dt);
      }
    }

    const h = frameScratch.h.copy(horizDir());
    const right = frameScratch.right.crossVectors(h, smoothUp).normalize();
    const mv = moveInput(h, right, frameScratch.move);

    if (grounded && keys.Space && !charging) { charging = true; charge = 0; }
    if (charging && grounded) charge = Math.min(1, charge + dt / CHARGE_TIME);

    let thrusting = false;
    groundSpeedNow = 0;

    if (grounded) {
      fuel = Math.min(FUEL_MAX, fuel + FUEL_REFILL_GROUND * dt);
      const preN=tmpV3.copy(pos).sub(groundPlanet.center).normalize();
      earthInWater=groundPlanet===earth&&earthWaterAtWorld(preN);
      swimBlend=damp(swimBlend,earthInWater?1:0,earthInWater?4.5:7,dt);
      const speed = earthInWater
        ? 4.4*(keys.ShiftLeft||keys.ShiftRight?1.45:1)*(charging?.55:1)
        : (keys.ShiftLeft||keys.ShiftRight?RUN_SPEED:WALK_SPEED)*(charging?.35:1);
      const desiredGround=frameScratch.groundDesired.copy(mv).multiplyScalar(speed);
      const changingDirection=groundMotion.lengthSq()>.01&&desiredGround.lengthSq()>.01&&groundMotion.dot(desiredGround)<0;
      const response=desiredGround.lengthSq()>.01?(changingDirection?10.5:(earthInWater?2.8:5.8)):(earthInWater?3.6:7.5);
      groundMotion.lerp(desiredGround,1-Math.exp(-response*dt));
      groundMotion.addScaledVector(preN,-groundMotion.dot(preN));
      if(groundMotion.lengthSq()<.0004)groundMotion.set(0,0,0);
      groundSpeedNow=groundMotion.length();
      pos.addScaledVector(groundMotion,dt);
      if(landingSlide.lengthSq()>.001){
        pos.addScaledVector(landingSlide,dt);
        landingSlide.addScaledVector(preN,-landingSlide.dot(preN));
        const slideSpeed=landingSlide.length();
        // Coulomb-style surface friction removes a fixed amount of speed per
        // second, unlike exponential damping which made every landing snap.
        const frictionAccel=Math.max(.8,groundPlanet.g*(earthInWater?1.3:.68));
        const nextSlideSpeed=Math.max(0,slideSpeed-frictionAccel*dt);
        if(nextSlideSpeed>0)landingSlide.multiplyScalar(nextSlideSpeed/slideSpeed);
        else landingSlide.set(0,0,0);
      }else landingSlide.set(0,0,0);
      const n = frameScratch.groundN.copy(pos).sub(groundPlanet.center).normalize();
      const srG = surfaceR(groundPlanet, n);
      if (srG < 0) {
        grounded = false; // the ground is gone — fall into the tunnel
        vel.copy(groundMotion);
        groundMotion.set(0,0,0);
      } else {
        const waterNow=groundPlanet===earth&&earthWaterAtWorld(n);
        earthInWater=waterNow;
        if(waterNow){
          const targetR=earth.r+EARTH_SEA_LEVEL+PLAYER_FEET-.82+Math.sin(elapsed*1.8)*.045;
          const currentR=pos.distanceTo(groundPlanet.center);
          const buoyantR=currentR+(targetR-currentR)*(1-Math.exp(-4.8*dt));
          pos.copy(groundPlanet.center).addScaledVector(n,buoyantR);
        }else{
          pos.copy(groundPlanet.center).addScaledVector(n,srG+PLAYER_FEET);
        }
      }
      up.copy(n);
      prevPos.copy(pos);
      if (groundMotion.lengthSq() > .01) lastFacing.lerp(tmpV3.copy(groundMotion).normalize(), 1 - Math.exp(-12 * dt)).normalize();
    } else {
      earthInWater=false;
      swimBlend=damp(swimBlend,0,6,dt);
      // Apply the body's configured physical acceleration directly. Earth is
      // 9.81 m/s² at its reference surface and follows inverse-square falloff;
      // no jump grace or near-ground gameplay multiplier alters gravity.
      vel.addScaledVector(accel,dt);
      const nearBlackhole=nearestP.blackhole&&pos.distanceTo(nearestP.center)<nearestP.r*20;
      const relativeVel=frameScratch.relativeVel;
      if (nearestP === airCarry) relativeVel.copy(vel);
      else relativeVel.copy(vel).sub(nearestP.velNow);
      const currentFlightSpeed=relativeVel.length();
      const braking=keys.ShiftLeft||keys.ShiftRight;
      const wantsThrust=keys.Space&&!charging&&fuel>0&&!braking;
      activeThrustDirection.copy(camDir).normalize();
      flightThrottle=damp(flightThrottle,wantsThrust?1:0,wantsThrust?1.35:4.5,dt);
      flightBrake=damp(flightBrake,braking?1:0,braking?5.5:7.5,dt);
      // Steering authority grows with velocity, but only as a bounded fraction
      // of it per second. It can no longer jump because the nearest surface is
      // suddenly millions of kilometres away.
      let airCtl=Math.max(12,currentFlightSpeed*.28);
      if(nearBlackhole)airCtl=Math.min(airCtl,7.5e5);
      vel.addScaledVector(mv, airCtl * dt);
      if (flightBrake>.001) {
        const drag=Math.exp(-(0.3+flightBrake*2.7)*dt);
        if(nearestP===airCarry)vel.multiplyScalar(drag);
        else{
          tmpV3.copy(vel).sub(nearestP.velNow).multiplyScalar(drag);
          vel.copy(nearestP.velNow).add(tmpV3);
        }
      }
      if (wantsThrust) {
        // Exponential cruise acceleration makes interstellar travel possible,
        // but the throttle itself spools up. Reapplying thrust after braking
        // therefore resumes continuously instead of changing speed in one frame.
        let effAccel=Math.max(100,currentFlightSpeed*.72)*flightThrottle;
        if(nearBlackhole)effAccel=Math.min(effAccel,2.2e6);
        vel.addScaledVector(activeThrustDirection, effAccel * dt);
        const burn = distSurf > 2e5 ? 4 : 20;
        fuel = Math.max(0, fuel - burn * dt);
        lastThrustTime = elapsed;
        thrusting = true;
      } else if (elapsed - lastThrustTime > FUEL_REGEN_DELAY) {
        fuel = Math.min(FUEL_MAX, fuel + FUEL_REFILL_AIR * dt);
      }

      // Target-assisted arrival. A T/F lock now predicts the intercept several
      // seconds ahead and begins braking while there is still enough distance.
      // Planets settle to a walking-speed touchdown; stars stop at a safe
      // observation radius because their visible surface cannot be landed on.
      let assistActive=false;
      const assistBody=target&&!target.catalogOnly&&!target.destroyed&&!target.blackhole&&target.mesh?target:null;
      if(assistBody){
        approachTo.copy(assistBody.center).sub(pos);
        const centerDistance=approachTo.length();
        if(centerDistance>1e-5){
          approachDir.copy(approachTo).divideScalar(centerDistance);
          if(assistBody===airCarry)approachVelocity.copy(vel);
          else approachVelocity.copy(vel).sub(assistBody.velNow);
          const closingSpeed=approachVelocity.dot(approachDir);
          const safeRadius=assistBody.deadly?assistBody.r*3.4:assistBody.r+PLAYER_FEET;
          const remaining=Math.max(0,centerDistance-safeRadius);
          if(closingSpeed>1){
            // Exponential braking covers roughly velocity/rate metres. A
            // five-second look-ahead remains stable even at interstellar speed.
            const interceptSpeed=Math.max(closingSpeed,approachVelocity.length()*.45);
            const leadDistance=interceptSpeed*5.2+Math.max(assistBody.r*.18,120);
            const urgency=THREE.MathUtils.clamp(1-remaining/Math.max(leadDistance,1),0,1);
            if(urgency>0||remaining<Math.max(assistBody.r*.3,5000)){
              assistActive=true;
              const nearZone=Math.max(assistBody.r*.16,5000);
              // Preserve fast travel until braking is required, then converge
              // on a short arrival time instead of crawling for minutes.
              let desiredClosing=remaining;
              if(remaining<nearZone){
                desiredClosing=(assistBody.deadly?0:2.8)+remaining/.55;
              }
              desiredClosing=Math.max(assistBody.deadly?0:2.8,Math.min(closingSpeed,desiredClosing));
              const brakeRate=6+urgency*12+(remaining<nearZone?2:0);
              const correctedClosing=damp(closingSpeed,desiredClosing,brakeRate,dt);
              approachLateral.copy(approachVelocity).addScaledVector(approachDir,-closingSpeed);
              const alignRate=.35+urgency*4.8+(remaining<nearZone?1.6:0);
              approachLateral.multiplyScalar(Math.exp(-alignRate*dt));
              approachVelocity.copy(approachDir).multiplyScalar(correctedClosing).add(approachLateral);
              if(assistBody===airCarry)vel.copy(approachVelocity);
              else vel.copy(assistBody.velNow).add(approachVelocity);
              approachAssist=damp(approachAssist,Math.max(.12,urgency),7,dt);
            }
          }
        }
      }
      if(!assistActive)approachAssist=damp(approachAssist,0,8,dt);
      if (nearestP === airCarry) tmpV3.copy(vel);
      else tmpV3.copy(vel).sub(nearestP.velNow);
      const speedLimit=nearBlackhole?C_WORLD*.985:Math.min(2.4e21,Math.max(19500,distSurf*.8));
      const controlledLimit=nearBlackhole||currentFlightSpeed>=2.4e21
        ? speedLimit:Math.max(speedLimit,currentFlightSpeed*1.015);
      if (tmpV3.length() > controlledLimit) {
        const easedSpeed=damp(tmpV3.length(),controlledLimit,nearBlackhole?9:1.2,dt);
        tmpV3.setLength(easedSpeed);
        if (nearestP === airCarry) vel.copy(tmpV3);
        else vel.copy(nearestP.velNow).add(tmpV3);
      }

      prevPos.copy(pos);
      pos.addScaledVector(vel, dt);
      if (mv.lengthSq() > 0) lastFacing.lerp(mv, 1 - Math.exp(-10 * dt)).normalize();
      if (thrusting) {
        // turn smoothly into the thrust direction
        lastFacing.lerp(activeThrustDirection, 1 - Math.exp(-8 * dt)).normalize();
      }
      // while coasting the heading is kept — no sudden direction snaps

      for (const p of planets) {
        if (jumpGrace > 0 && p === groundPlanet) continue; // just launched off it
        const n = tmpV.copy(pos).sub(p.center);
        const d = n.length();
        n.normalize();
        const sr0 = surfaceR(p, n);
        if (sr0 < 0) continue; // open tunnel: fall straight through
        const surf = sr0 + PLAYER_FEET;
        const vr = (p === airCarry ? tmpV2.copy(vel) : tmpV2.copy(vel).sub(p.velNow)).dot(n);
        if (d <= surf + .02 || (vr < 0 && segHitsSphere(prevPos, pos, p.center, surf))) {
          const contact=findSurfaceContact(p,prevPos,pos,new THREE.Vector3());
          landOn(p,contact);
          break;
        }
      }
      // There is no physical map wall. Floating-origin rebasing keeps travel
      // numerically stable at intergalactic scales; reset only corrupted state.
      if (!Number.isFinite(pos.lengthSq())) { spawnOn(homePlanet()); }
    }

    // Stream from the final post-physics position. Updating before movement
    // left the terrain one frame behind exactly when landing at high speed.
    updateEarthSurfaceTiles();

    // ---------- Atmosphere immersion ----------
    let skyFactor = 0,localDaylight=0;
    const illuminationStar=nearestStarTo(pos);
    const eclipseVisibility=stellarVisibility(pos,illuminationStar,nearestP);
    if (lastAtmoMat && lastAtmoMat !== (nearestP.atmoMat || null)) lastAtmoMat.uniforms.fade.value = 1;
    if (nearestP.atmosphere && !nearestP.isStar) {
      const atmH = nearestP.r * 0.07;
      const f = Math.max(0, Math.min(1, 1 - distSurf / atmH));
      const upN = tmpV.copy(pos).sub(nearestP.center).normalize();
      const starDir = tmpV3.copy(illuminationStar.center).sub(pos).normalize();
      const sunElevation=upN.dot(starDir);
      localDaylight=Math.max(0,Math.min(1,(sunElevation+.16)/.42))*eclipseVisibility;
      skyFactor = f * localDaylight;
      if (nearestP.atmoMat) {
        nearestP.atmoMat.uniforms.fade.value = 1 - f * 0.95;
        nearestP.atmoMat.uniforms.starVisibility.value=eclipseVisibility;
        lastAtmoMat = nearestP.atmoMat;
      }
      tmpC.setHex(nearestP.atmosphere).multiplyScalar(skyFactor * 0.85);
      renderer.setClearColor(tmpC, 1);
    } else {
      // Real space is dark, but integrated starlight and unresolved dust keep
      // the visual floor slightly blue rather than digitally pure black.
      renderer.setClearColor(0x01040b, 1);
    }
    surfaceAtmosphere.update({
      // Earth's real albedo and streamed terrain should remain visible at every
      // altitude. The former blue exponential fog washed the entire globe into
      // one colour until the atmospheric cutoff, producing an obvious switch
      // back to the normal satellite texture around 70 km.
      enabled:nearestP!==earth&&!!nearestP.atmosphere&&!nearestP.isStar&&distSurf<nearestP.r*CONFIG.atmosphere.fadeAltitudeRatio,
      bodyRadius:nearestP.r,altitude:Math.max(0,distSurf),skyFactor,daylight:localDaylight,
      atmosphereColor:nearestP.atmosphere
    });
    const atmosphericDepth=nearestP.atmosphere&&!nearestP.isStar?nearestP.r*.07:1;
    const altitudeReveal=nearestP.atmosphere&&!nearestP.isStar
      ? THREE.MathUtils.smoothstep(Math.max(0,distSurf)/atmosphericDepth,.015,.96):1;
    const surfaceNight=nearestP.atmosphere&&!nearestP.isStar?Math.max(.018,1-localDaylight*.985):1;
    const deepSkyTarget=surfaceNight+(1-surfaceNight)*altitudeReveal;
    deepSkyVisibility=damp(deepSkyVisibility,deepSkyTarget,deepSkyTarget > deepSkyVisibility ? .52 : .9,dt);
    for (const m of starMats) {
      if(m.userData.godmanBaseOpacity===undefined)m.userData.godmanBaseOpacity=m.opacity;
      m.opacity=m.userData.godmanBaseOpacity*deepSkyVisibility;
    }

    // ---------- Asteroids & explosions ----------
    for (let i = asteroids.length - 1; i >= 0; i--) {
      const a = asteroids[i];
      a.tLeft -= dt;
      if (a.tLeft > 0.05) {
        a.n.copy(a.nL).applyQuaternion(a.tgt.mesh.quaternion); // ride the planet's rotation
        a.vel.copy(a.tgt.center).addScaledVector(a.n, surfaceR(a.tgt, a.n)).sub(a.w).divideScalar(a.tLeft);
      }
      a.w.addScaledVector(a.vel, dt);
      a.mesh.rotation.x += dt * 3; a.mesh.rotation.y += dt * 2;
      a.mesh.position.copy(a.w).sub(pos);
      const nA = a.w.clone().sub(a.tgt.center).normalize();
      const srA2 = surfaceR(a.tgt, nA);
      if (srA2 >= 0 && a.w.distanceTo(a.tgt.center) <= srA2 + a.size) {
        explode(a.tgt, nA, a.size);
        scene.remove(a.mesh);
        asteroids.splice(i, 1);
      }
    }
    for (let i = booms.length - 1; i >= 0; i--) {
      const b = booms[i];
      b.age += dt;
      const k2 = b.age / b.dur;
      b.spr.scale.setScalar(b.base * (0.3 + k2 * 2.4));
      b.spr.material.opacity = Math.max(0, 1 - k2);
      b.spr.position.copy(b.w).sub(pos);
      if (b.age > b.dur) { scene.remove(b.spr); booms.splice(i, 1); }
    }
    for (let i = debris.length - 1; i >= 0; i--) {
      const dd = debris[i];
      dd.age += dt;
      dd.w.addScaledVector(dd.vel, dt);
      dd.mesh.rotation.x += dd.spin.x * dt;
      dd.mesh.rotation.y += dd.spin.y * dt;
      dd.mesh.position.copy(dd.w).sub(pos);
      if (dd.age > 10) { scene.remove(dd.mesh); debris.splice(i, 1); }
    }
    boomAge += dt;
    boomLight.intensity = Math.max(0, 1 - boomAge / boomDur) * 4;
    boomLight.position.copy(boomW).sub(pos);

    // ---------- Animations ----------
    // The old backpack nozzle belongs only to the hidden fallback character.
    // The visible authored astronaut uses hand and foot repulsors below.
    flame.visible = false;

    if (!grounded) airborneTime += dt;
    if (grounded && !wasGrounded) {
      airborneTime = 0;
    }
    wasGrounded = grounded;
    takeoffBlend *= Math.exp(-6.5 * dt);
    squash *= Math.exp(-5.5 * dt);
    landingAge+=dt;
    if(landingStrength>0){
      const compressionTime=.15+landingStrength*.07;
      const compression=landingAge<compressionTime
        ? Math.sin(Math.max(0,landingAge)/compressionTime*Math.PI*.5)
        : Math.exp(-(landingAge-compressionTime)*3.7);
      squash=Math.max(squash,landingStrength*compression);
      if(landingAge>1.35)landingStrength=0;
    }

    const atmosphericPose=nearestP.atmosphere&&!nearestP.isStar
      ? 1-THREE.MathUtils.smoothstep(Math.max(0,distSurf),nearestP.r*.008,nearestP.r*.025):0;
    spacePoseBlend=damp(spacePoseBlend,1-atmosphericPose,2.5,dt);
    const leanTarget = earthInWater
      ? .38+Math.min(.42,groundSpeedNow*.055)
      : (!grounded && thrusting)
      ? .95 * (1 - Math.max(0, Math.min(1, activeThrustDirection.dot(smoothUp))))
      : (!grounded ? .08+.15*atmosphericPose : 0);
    lean = damp(lean, leanTarget, 5, dt);


    if(!characterMotion){
    const k = 10;
    const runRequested=grounded&&!earthInWater&&(keys.ShiftLeft||keys.ShiftRight)&&groundSpeedNow>WALK_SPEED*.7;
    const runFrac=runRequested?Math.max(.3,Math.min(1,
      (groundSpeedNow-WALK_SPEED*.7)/(RUN_SPEED-WALK_SPEED*.7))):0;
    if (earthInWater) {
      // Alternating arm recovery and flutter kick, with buoyant vertical lag.
      walkPhase+=dt*(groundSpeedNow>0?3.7:1.15);const sw=Math.sin(walkPhase),stroke=Math.sin(walkPhase*.5);
      rig.legL.hip.rotation.x=damp(rig.legL.hip.rotation.x,sw*.34,7,dt);
      rig.legR.hip.rotation.x=damp(rig.legR.hip.rotation.x,-sw*.34,7,dt);
      rig.legL.knee.rotation.x=damp(rig.legL.knee.rotation.x,-.28-Math.max(0,-sw)*.42,7,dt);
      rig.legR.knee.rotation.x=damp(rig.legR.knee.rotation.x,-.28-Math.max(0,sw)*.42,7,dt);
      rig.armL.sh.rotation.x=damp(rig.armL.sh.rotation.x,-.28+stroke*.72,6,dt);
      rig.armR.sh.rotation.x=damp(rig.armR.sh.rotation.x,-.28-stroke*.72,6,dt);
      rig.armL.sh.rotation.z=damp(rig.armL.sh.rotation.z,-.68-stroke*.22,6,dt);
      rig.armR.sh.rotation.z=damp(rig.armR.sh.rotation.z,.68-stroke*.22,6,dt);
      rig.armL.el.rotation.x=damp(rig.armL.el.rotation.x,.42+Math.max(0,-stroke)*.58,6,dt);
      rig.armR.el.rotation.x=damp(rig.armR.el.rotation.x,.42+Math.max(0,stroke)*.58,6,dt);
      rig.torso.rotation.x=damp(rig.torso.rotation.x,.08,6,dt);rig.torso.rotation.z=damp(rig.torso.rotation.z,sw*.025,6,dt);
      rig.torso.position.y=damp(rig.torso.position.y,1.43+Math.sin(elapsed*1.8)*.045,5,dt);
      rig.head.rotation.x=damp(rig.head.rotation.x,.26,6,dt);
    } else if (grounded && groundSpeedNow > 0) {
      // walk / run cycle with bending knees & elbows
      walkPhase += groundSpeedNow * dt * 0.55;
      const sw = Math.sin(walkPhase);
      const swB = Math.sin(walkPhase + Math.PI);
      const amp = 0.5 + runFrac * 0.3;
      rig.legL.hip.rotation.x = damp(rig.legL.hip.rotation.x,  sw * amp, 14, dt);
      rig.legR.hip.rotation.x = damp(rig.legR.hip.rotation.x, swB * amp, 14, dt);
      rig.legL.knee.rotation.x = damp(rig.legL.knee.rotation.x, -Math.max(0, -sw) * (0.9 + runFrac * 0.5), 14, dt);
      rig.legR.knee.rotation.x = damp(rig.legR.knee.rotation.x, -Math.max(0, -swB) * (0.9 + runFrac * 0.5), 14, dt);
      rig.armL.sh.rotation.x = damp(rig.armL.sh.rotation.x, swB * amp * 0.8, 14, dt);
      rig.armR.sh.rotation.x = damp(rig.armR.sh.rotation.x,  sw * amp * 0.8, 14, dt);
      rig.armL.el.rotation.x = damp(rig.armL.el.rotation.x, 0.3 + Math.max(0, swB) * 0.55, 14, dt);
      rig.armR.el.rotation.x = damp(rig.armR.el.rotation.x, 0.3 + Math.max(0, sw) * 0.55, 14, dt);
      rig.armL.sh.rotation.z = damp(rig.armL.sh.rotation.z, -0.12, k, dt);
      rig.armR.sh.rotation.z = damp(rig.armR.sh.rotation.z, 0.12, k, dt);
      rig.torso.rotation.x = damp(rig.torso.rotation.x, -(0.06 + runFrac * 0.16), k, dt);
      rig.torso.rotation.z = damp(rig.torso.rotation.z, sw * 0.05, k, dt);
      rig.torso.position.y = 1.55 + Math.abs(sw) * (0.05 + runFrac * 0.05);
      rig.head.rotation.x = damp(rig.head.rotation.x, 0.06 + runFrac * 0.12, k, dt);
    } else if (grounded) {
      // idle breathing / deep crouch while charging a jump
      const crouch = charge;
      rig.legL.hip.rotation.x = damp(rig.legL.hip.rotation.x, crouch * 0.9, 12, dt);
      rig.legR.hip.rotation.x = damp(rig.legR.hip.rotation.x, crouch * 0.9, 12, dt);
      rig.legL.knee.rotation.x = damp(rig.legL.knee.rotation.x, -crouch * 1.5, 12, dt);
      rig.legR.knee.rotation.x = damp(rig.legR.knee.rotation.x, -crouch * 1.5, 12, dt);
      rig.armL.sh.rotation.x = damp(rig.armL.sh.rotation.x, charging ? -0.9 : Math.sin(elapsed * 1.8) * 0.03, 10, dt);
      rig.armR.sh.rotation.x = damp(rig.armR.sh.rotation.x, charging ? -0.9 : Math.sin(elapsed * 1.8 + 0.7) * 0.03, 10, dt);
      rig.armL.el.rotation.x = damp(rig.armL.el.rotation.x, charging ? 0.2 : 0.28 + Math.sin(elapsed * 1.8) * 0.04, 10, dt);
      rig.armR.el.rotation.x = damp(rig.armR.el.rotation.x, charging ? 0.2 : 0.28 + Math.sin(elapsed * 1.8 + 1) * 0.04, 10, dt);
      rig.armL.sh.rotation.z = damp(rig.armL.sh.rotation.z, charging ? -0.3 : -0.12, 10, dt);
      rig.armR.sh.rotation.z = damp(rig.armR.sh.rotation.z, charging ? 0.3 : 0.12, 10, dt);
      rig.torso.rotation.x = damp(rig.torso.rotation.x, -crouch * 0.35, 10, dt);
      rig.torso.rotation.z = damp(rig.torso.rotation.z, 0, k, dt);
      rig.torso.position.y = damp(rig.torso.position.y, 1.55 - crouch * 0.3 + Math.sin(elapsed * 2) * 0.02, 10, dt);
      rig.head.rotation.x = damp(rig.head.rotation.x, charging ? 0.3 : Math.sin(elapsed * 1.2) * 0.04, 8, dt);
    } else if (takeoffBlend > 0.025 && !thrusting) {
      // The body extends out of the charged crouch before settling into flight.
      const t = takeoffBlend;
      rig.legL.hip.rotation.x = damp(rig.legL.hip.rotation.x, 0.05, 13, dt);
      rig.legR.hip.rotation.x = damp(rig.legR.hip.rotation.x, 0.02, 13, dt);
      rig.legL.knee.rotation.x = damp(rig.legL.knee.rotation.x, -0.08, 13, dt);
      rig.legR.knee.rotation.x = damp(rig.legR.knee.rotation.x, -0.1, 13, dt);
      rig.armL.sh.rotation.x = damp(rig.armL.sh.rotation.x, -0.35 * t, 10, dt);
      rig.armR.sh.rotation.x = damp(rig.armR.sh.rotation.x, -0.35 * t, 10, dt);
      rig.armL.sh.rotation.z = damp(rig.armL.sh.rotation.z, -0.35, 10, dt);
      rig.armR.sh.rotation.z = damp(rig.armR.sh.rotation.z, 0.35, 10, dt);
      rig.torso.rotation.x = damp(rig.torso.rotation.x, -0.08, 10, dt);
      rig.torso.rotation.z = damp(rig.torso.rotation.z, 0, 10, dt);
      rig.torso.position.y = damp(rig.torso.position.y, 1.58, 12, dt);
      rig.head.rotation.x = damp(rig.head.rotation.x, 0.08, 10, dt);
    } else if (thrusting) {
      // superman cruise: arms swept back, legs trailing, head up
      rig.legL.hip.rotation.x = damp(rig.legL.hip.rotation.x, -0.12, 8, dt);
      rig.legR.hip.rotation.x = damp(rig.legR.hip.rotation.x, -0.2, 8, dt);
      rig.legL.knee.rotation.x = damp(rig.legL.knee.rotation.x, -0.15, 8, dt);
      rig.legR.knee.rotation.x = damp(rig.legR.knee.rotation.x, -0.25, 8, dt);
      rig.armL.sh.rotation.x = damp(rig.armL.sh.rotation.x, -0.35, 8, dt);
      rig.armR.sh.rotation.x = damp(rig.armR.sh.rotation.x, -0.35, 8, dt);
      rig.armL.el.rotation.x = damp(rig.armL.el.rotation.x, 0.3 + Math.sin(elapsed * 3.2) * 0.08, 8, dt);
      rig.armR.el.rotation.x = damp(rig.armR.el.rotation.x, 0.3 + Math.sin(elapsed * 3.2 + 0.9) * 0.08, 8, dt);
      rig.armL.sh.rotation.z = damp(rig.armL.sh.rotation.z, -0.55 - Math.sin(elapsed * 3.2) * 0.06, 8, dt);
      rig.armR.sh.rotation.z = damp(rig.armR.sh.rotation.z, 0.55 + Math.sin(elapsed * 3.2 + 0.9) * 0.06, 8, dt);
      rig.torso.rotation.x = damp(rig.torso.rotation.x, 0.1, 8, dt);
      rig.torso.rotation.z = damp(rig.torso.rotation.z, Math.sin(elapsed * 3) * 0.05, 8, dt);
      rig.torso.position.y = damp(rig.torso.position.y, 1.55, k, dt);
      rig.head.rotation.x = damp(rig.head.rotation.x, 0.5, 8, dt);
    } else {
      // Ballistic flight: relaxed on ascent, gradually preparing the legs for impact.
      const verticalSpeed = vel.dot(smoothUp);
      const flightSettled = Math.min(1, airborneTime / 0.35);
      const prepare = Math.max(0, Math.min(1, (4 - verticalSpeed) / 18)) * flightSettled;
      rig.legL.hip.rotation.x = damp(rig.legL.hip.rotation.x, 0.06 + prepare * 0.4, 7, dt);
      rig.legR.hip.rotation.x = damp(rig.legR.hip.rotation.x, 0.03 + prepare * 0.42, 7, dt);
      rig.legL.knee.rotation.x = damp(rig.legL.knee.rotation.x, -0.12 - prepare * 0.62, 7, dt);
      rig.legR.knee.rotation.x = damp(rig.legR.knee.rotation.x, -0.1 - prepare * 0.66, 7, dt);
      rig.armL.sh.rotation.x = damp(rig.armL.sh.rotation.x, -0.08 + prepare * 0.18, 6, dt);
      rig.armR.sh.rotation.x = damp(rig.armR.sh.rotation.x, -0.06 + prepare * 0.18, 6, dt);
      rig.armL.sh.rotation.z = damp(rig.armL.sh.rotation.z, -0.48 - prepare * 0.2, 6, dt);
      rig.armR.sh.rotation.z = damp(rig.armR.sh.rotation.z, 0.48 + prepare * 0.2, 6, dt);
      rig.armL.el.rotation.x = damp(rig.armL.el.rotation.x, 0.25 + prepare * 0.18, 6, dt);
      rig.armR.el.rotation.x = damp(rig.armR.el.rotation.x, 0.25 + prepare * 0.18, 6, dt);
      rig.torso.rotation.x = damp(rig.torso.rotation.x, -0.04 + prepare * 0.14, 6, dt);
      rig.torso.rotation.z = damp(rig.torso.rotation.z, 0, 6, dt);
      rig.torso.position.y = damp(rig.torso.position.y, 1.55, k, dt);
      rig.head.rotation.x = damp(rig.head.rotation.x, 0.08 + prepare * 0.08, 6, dt);
    }
    // landing impact: knees absorb the hit
    if (squash > 0) {
      rig.legL.knee.rotation.x = Math.min(rig.legL.knee.rotation.x, -squash * 1.2);
      rig.legR.knee.rotation.x = Math.min(rig.legR.knee.rotation.x, -squash * 1.2);
      rig.legL.hip.rotation.x = Math.max(rig.legL.hip.rotation.x, squash * 0.7);
      rig.legR.hip.rotation.x = Math.max(rig.legR.hip.rotation.x, squash * 0.7);
      rig.torso.rotation.x = Math.min(rig.torso.rotation.x, -squash * 0.3);
      rig.torso.position.y = Math.min(rig.torso.position.y, 1.55 - squash * 0.18);
      rig.armL.sh.rotation.x = Math.max(rig.armL.sh.rotation.x, squash * 0.2);
      rig.armR.sh.rotation.x = Math.max(rig.armR.sh.rotation.x, squash * 0.2);
    }

    // hold the blaster out in front while it's equipped
    if (laserEquipped) {
      rig.armR.sh.rotation.x = damp(rig.armR.sh.rotation.x, 1.5, 12, dt);
      rig.armR.sh.rotation.z = damp(rig.armR.sh.rotation.z, 0.06, 12, dt);
      rig.armR.el.rotation.x = damp(rig.armR.el.rotation.x, 0.05, 12, dt);
    }

    } // procedural fallback only

    if(authoredSuitRoot&&authoredSuitMixer){
      // The idle take supplies breathing/finger detail. A single contact-aware
      // controller owns all limb poses, rather than competing clip overrides.
      useAuthoredSuitAction('idle',.25,.75,dt);
      authoredSuitMixer.update(dt);
    }

    // ---- Player orientation ----
    tmpV.copy(lastFacing).addScaledVector(smoothUp, -lastFacing.dot(smoothUp));
    if (tmpV.lengthSq() > 1e-4) lastFacing.copy(tmpV).normalize();
    else lastFacing.copy(h);
    const q1 = frameScratch.playerQ.setFromUnitVectors(frameScratch.localUp, smoothUp);
    const f0 = frameScratch.playerForward.copy(frameScratch.localForward).applyQuaternion(q1);
    f0.addScaledVector(smoothUp, -f0.dot(smoothUp)).normalize();
    const crossV = frameScratch.playerCross.crossVectors(f0, lastFacing);
    const ang = Math.atan2(crossV.dot(smoothUp), f0.dot(lastFacing));
    const qYaw = frameScratch.yawQ.setFromAxisAngle(smoothUp, ang);
    const qLean = frameScratch.leanQ.setFromAxisAngle(frameScratch.localRight, -lean);
    player.quaternion.copy(qYaw.multiply(q1));
    if(!characterMotion)player.quaternion.multiply(qLean);
    player.position.set(0, 0, 0);
    const sy = 1 - 0.025 * charge;
    // Sagittarius A* is supermassive: the tidal gradient across a human at
    // its horizon is far too small to justify the old four-times character
    // stretch. Keep the body rigid until the irreversible capture event.
    player.scale.set(PSCALE, PSCALE * sy, PSCALE);
    if(characterMotion){
      flightInverse.copy(player.quaternion).invert();
      flightLocalDirection.copy(activeThrustDirection).applyQuaternion(flightInverse);
      characterMotion.orient(dt,player.quaternion,smoothUp,activeThrustDirection,vel,grounded,earthInWater,spacePoseBlend);
      player.scale.setScalar(PSCALE);
      let animationHeight=grounded?0:Infinity;
      if(!grounded&&!nearestP.deadly&&distSurf<500){
        frameScratch.playerForward.copy(pos).sub(nearestP.center).normalize();
        const animationSurface=surfaceR(nearestP,frameScratch.playerForward);
        if(animationSurface>=0)animationHeight=Math.max(0,pos.distanceTo(nearestP.center)-animationSurface-PLAYER_FEET);
      }
      const animationVerticalSpeed=grounded?0:vel.dot(smoothUp)-(nearestP===airCarry?0:nearestP.velNow.dot(smoothUp));
      characterMotion.update(dt,{grounded,charge,landing:squash,speed:groundSpeedNow,
        airTime:airborneTime,space:spacePoseBlend,powered:thrusting,throttle:flightThrottle,brake:flightBrake,
        height:animationHeight,verticalSpeed:animationVerticalSpeed,
        water:earthInWater,laser:laserEquipped,turn:flightLocalDirection.x});
    }
    updateAuthoredRepulsors(dt,thrusting&&!earthInWater);

    headlamp.position.copy(smoothUp).multiplyScalar(3);
    const starDistance=pos.distanceTo(illuminationStar.center);
    tmpV.copy(illuminationStar.center).sub(pos).normalize();
    const nearAtmosphere=nearestP.atmosphere&&!nearestP.isStar&&distSurf<nearestP.r*.08;
    const sunHeight=Math.max(-1,Math.min(1,smoothUp.dot(tmpV)));
    const directDay=nearAtmosphere?Math.max(0,Math.min(1,(sunHeight+.08)/.32)):1;
    physicalLighting.update({dt:dt,star:illuminationStar,distance:starDistance,au:AU,
      skyFactor:skyFactor,nearAtmosphere:nearAtmosphere?1:0,sunHeight:sunHeight,directDay:directDay,eclipse:eclipseVisibility});
    characterKey.position.copy(tmpV).multiplyScalar(9).addScaledVector(smoothUp,3);
    characterLightTarget.position.set(0,1.2,0);
    characterRim.position.copy(tmpV).multiplyScalar(-5).addScaledVector(smoothUp,2.5);

    // ---- Camera ----
    camDist=damp(camDist,camDistTarget,10,dt);
    const cameraSpeed=grounded?groundSpeedNow:(airCarry?tmpV2.copy(vel).sub(airCarry.velNow).length():vel.length());
    const speedFov=grounded?Math.min(4,cameraSpeed*.12):Math.min(16,Math.log10(cameraSpeed+1)*3.2);
    const targetFov=60+speedFov+(thrusting?2.5:0)-(charging?2:0);
    const nextFov=damp(camera.fov,targetFov,5,dt);
    if(Math.abs(nextFov-camera.fov)>.015){camera.fov=nextFov;camera.updateProjectionMatrix();}
    const lookTarget = frameScratch.lookTarget.copy(smoothUp).multiplyScalar(1.6);
    if (overview) {
      // far-out orbit view centred on the player
      overviewDist = damp(overviewDist, overviewZoomTarget, 12, dt);
      const oq = frameScratch.overviewQ.setFromAxisAngle(smoothUp, -oyaw);
      const od = frameScratch.overviewDir.copy(fwdRef).applyQuaternion(oq).normalize();
      const ocp = Math.cos(opitch), osp = Math.sin(opitch);
      camera.position.set(0, 0, 0)
        .addScaledVector(od, -overviewDist * ocp)
        .addScaledVector(smoothUp, overviewDist * osp);
      camera.up.copy(smoothUp);
      camera.lookAt(0, 0, 0);
    } else {
      const cp = Math.cos(pitch), sp = Math.sin(pitch);
      camera.position.copy(lookTarget)
        .addScaledVector(h, -camDist * cp)
        .addScaledVector(smoothUp, camDist * sp);
      {
        const p = nearestP;
        const head = tmpV2.copy(pos).addScaledVector(smoothUp, 1.6);
        const boom = tmpV.copy(camera.position).add(pos).sub(head);
        const boomLen = boom.length();
        if (boomLen > 0.001 && p.craters) {
          boom.divideScalar(boomLen);
          let allow = boomLen;
          for (let s2 = 1; s2 <= 12; s2++) {
            tmpV3.copy(head).addScaledVector(boom, boomLen * s2 / 12);
            const dC = tmpV3.distanceTo(p.center);
            tmpV3.sub(p.center).normalize();
            const sr2 = surfaceR(p, tmpV3);
            if (sr2 >= 0 && dC < sr2 + 3) { allow = boomLen * (s2 - 1) / 12; break; }
          }
          if (allow < boomLen) {
            camera.position.copy(head).addScaledVector(boom, Math.max(allow, 2)).sub(pos);
          }
        } else if (boomLen > 0.001) {
          // simple radial clamp on pristine planets
          const camWorld = tmpV3.copy(camera.position).add(pos);
          const d = camWorld.distanceTo(p.center);
          if (d < p.r + 1) {
            camWorld.sub(p.center).normalize();
            camera.position.copy(p.center).addScaledVector(camWorld, p.r + 1).sub(pos);
          }
        }
        // Final terrain-aware safety clamp. The boom test above prevents most
        // intersections; this guarantees that steep slopes and fast camera
        // movement can never leave the camera below the rendered surface.
        const camWorld=tmpV3.copy(camera.position).add(pos);
        const camN=tmpV.copy(camWorld).sub(p.center);
        const camRadius=camN.length();
        if(camRadius>0&&distSurf<5000){
          camN.divideScalar(camRadius);
          const camGround=surfaceR(p,camN);
          if(camGround>=0&&camRadius<camGround+1.25){
            camera.position.copy(p.center).addScaledVector(camN,camGround+1.25).sub(pos);
          }
        }
      }
      camera.up.copy(smoothUp);
      camera.lookAt(lookTarget);
    }
    // C-view used to leave camDir at the last third-person orientation. The
    // black-hole visibility test then believed the hole was behind the camera
    // at otherwise valid overview angles and removed the entire lens pass.
    camera.getWorldDirection(camDir);

    // Keep the relativistic ray-tracing surface perpendicular to the view and
    // express the physical disk normal in the shader's camera-aligned frame.
    if (blackhole.lensingMesh) {
      blackhole.lensingMesh.quaternion.copy(camera.quaternion);
      blackhole.lensingMaterial.uniforms.time.value = elapsed;
      tmpQ.copy(camera.quaternion).invert();
      blackhole.lensingMaterial.uniforms.diskNormal.value
        .copy(blackhole.diskNormalWorld).applyQuaternion(tmpQ).normalize();
    }

    // ---- Orbital laser ----
    if (laserEquipped) ensureLaser();
    if (laserBeam) {
      if (laserFiring && laserEquipped && document.pointerLockElement && !overview) {
        let tgt = null, bestT = Infinity;
        const laserOrigin=new THREE.Vector3().copy(camera.position).add(pos);
        for (const p of planets) {
          if (p.isStar || p.destroyed) continue;
          const t = raySphere(laserOrigin, camDir, p.center, p.r);
          if (t > 0 && t < bestT) { bestT = t; tgt = p; }
        }
        // beam starts at the gun muzzle held in the player's hand
        const aR = (rig.gunTip ? rig.gunTip.getWorldPosition(new THREE.Vector3())
                               : new THREE.Vector3().copy(smoothUp).multiplyScalar(0.5));
        let endW;
        if (tgt) {
          endW = laserOrigin.clone().addScaledVector(camDir, bestT);
          const hitN=endW.clone().sub(tgt.center).normalize();
          if(laserHeatTarget!==tgt){laserHeatTarget=tgt;laserHeat=0;}
          laserHeat=Math.min(LASER_HEAT_TIME,laserHeat+dt);
          const heat=laserHeat/LASER_HEAT_TIME;
          if(elapsed-lastLaserDeform>=LASER_DEFORM_INTERVAL){
            const wound=deformCrater(tgt,hitN,Math.max(12,tgt.r*.00035),true);
            if(wound)scorchTexture(tgt,wound.n,wound.R);
            lastLaserDeform=elapsed;
          }
          laserGlow.visible = true;
          laserGlow.position.copy(endW).sub(pos);
          const gs = Math.max(1.2,Math.min(tgt.r*.002,2+laserGlow.position.length()*.008));
          laserGlow.scale.set(gs, gs, 1);
          laserGlow.material.opacity=.62+heat*.38;
          laserGlow.material.rotation=elapsed*(2.5+heat*5);
        } else {
          endW = new THREE.Vector3().copy(pos).addScaledVector(camDir, 5e6);
          if (laserGlow) laserGlow.visible = false;
          laserHeat=Math.max(0,laserHeat-dt*1.8);
          if(laserHeat===0)laserHeatTarget=null;
        }
        const seg = new THREE.Vector3().copy(endW).sub(pos).sub(aR);
        const len = Math.max(seg.length(), 0.001);
        laserBeam.visible = true;
        laserBeam.position.copy(aR);
        laserBeam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), seg.clone().normalize());
        const rad = Math.max(0.035,Math.min(80,len*.00042));
        laserBeam.scale.set(rad, len, rad);
        laserBeam.material.opacity=.7+.22*Math.sin(elapsed*38)*Math.sin(elapsed*38);
      } else {
        laserBeam.visible = false;
        if (laserGlow) laserGlow.visible = false;
        laserHeat=Math.max(0,laserHeat-dt*1.35);
        if(laserHeat===0)laserHeatTarget=null;
      }
    }

    // ---- Floating origin ----
    for (const ro of renderObjs) ro.o.position.copy(ro.w).sub(pos);
    const camW = tmpV3.copy(camera.position).add(pos);
    if(blackhole.lensingMesh){
      renderer.getDrawingBufferSize(blackhole.viewportSize);
      blackhole.viewVector.copy(blackhole.lensingMesh.position).sub(camera.position);
      const viewDepth=blackhole.viewVector.dot(camDir);
      blackhole.projectedCenter.copy(blackhole.lensingMesh.position).project(camera);
      const rsUvY=viewDepth>camera.near
        ? .5*(blackhole.r/viewDepth)/Math.tan(THREE.MathUtils.degToRad(camera.fov*.5))
        : 0;
      const rsUvX=rsUvY/Math.max(camera.aspect,.001);
      blackhole.schwarzschildUv.set(rsUvX,rsUvY);
      const effectNdcX=rsUvX*32;
      const effectNdcY=rsUvY*32;
      blackhole.effectRadiusPx=Math.max(
        rsUvX*blackhole.viewportSize.x,rsUvY*blackhole.viewportSize.y)*16;
      blackhole.passActive=viewDepth>camera.near&&
        rsUvY*blackhole.viewportSize.y>.18&&
        blackhole.projectedCenter.z>-1&&blackhole.projectedCenter.z<1&&
        Math.abs(blackhole.projectedCenter.x)<1+effectNdcX&&
        Math.abs(blackhole.projectedCenter.y)<1+effectNdcY;
      blackhole.lensingMesh.visible=blackhole.passActive;
      blackhole.lensingMaterial.uniforms.viewport.value.copy(blackhole.viewportSize);
      blackhole.lensingMaterial.uniforms.schwarzschildUv.value.copy(blackhole.schwarzschildUv);
      blackhole.lensingMaterial.uniforms.observerDistanceRs.value=Math.max(1.001,
        camW.distanceTo(blackhole.center)/blackhole.r);
      blackhole.lensingMaterial.uniforms.tanHalfFov.value=Math.tan(
        THREE.MathUtils.degToRad(camera.fov*.5));
      blackhole.lensingMaterial.uniforms.lensDepth.value=Math.max(0,Math.min(1,
        Math.log2(Math.max(1,viewDepth+1))/Math.log2(camera.far+1)));
      // Close observers start the integration near the hole and need fewer
      // steps. Tiny distant lenses are cheap in screen area, so they retain
      // enough samples to resolve the critical curve without shimmer.
      blackhole.lensingMaterial.uniforms.traceSteps.value=blackhole.effectRadiusPx>900?94:
        blackhole.effectRadiusPx>360?108:124;
    }
    for (const l of labels) {
      if (l.body) l.w.set(l.body.center.x, l.body.center.y + l.body.r * 1.8, l.body.center.z);
      const dist = l.w.distanceTo(camW);
      // Finder makes distant objects discoverable; labels are kept for nearby
      // bodies and the active target so the sky stays clean and cheap to draw.
      const standingOnBody=l.body&&camW.distanceTo(l.body.center)<l.r*1.08;
      const visible = !universeAnnotationsHidden&&!standingOnBody&&
        ((target && l.body === target) || dist < l.r * 2500);
      if (visible) ensureBodyLabel(l);
      if (!l.spr) continue;
      l.spr.visible = visible;
      let s = Math.max(l.r * 2.4, dist * 0.022);
      if (target && l.body === target) s *= 2.2;
      l.spr.scale.set(s, s * 0.25, 1);
    }
    for (const g of glows) {
      const dist = g.w.distanceTo(camW);
      let s = Math.max(g.base, dist * 0.014);
      if (g.pulse && dist < g.base * 6) s *= 1 + Math.sin(elapsed * 1.3) * 0.06;
      g.spr.material.opacity=g.body===illuminationStar?1:deepSkyVisibility;
      g.spr.scale.set(s, s, 1);
    }

    // ---- HUD ----
    const altP = grounded ? groundPlanet : domBody;
    const alt = Math.max(0, pos.distanceTo(altP.center) - altP.r - PLAYER_FEET);
    hudPlanet.textContent = (grounded ? '' : '→ ') + altP.name;
    hudAlt.textContent = 'Altitude: ' + fmtDist(alt);
    const localMotion=grounded||distSurf<2e4;
    hudSpeed.textContent='Speed: '+(grounded
      ? fmtLocalSpeed(groundSpeedNow+landingSlide.length())
      : (localMotion?fmtLocalSpeed(vel.length()):fmtSpeed(vel.length())));
    hudGrav.textContent = grounded ? '' : 'Gravity field: ' + domBody.name;
    fuelBar.style.width = fuel.toFixed(1) + '%';
    if (target) {
      targetBanner.textContent = target.name.toUpperCase() + ' — ' +
        fmtDist(Math.max(0, pos.distanceTo(target.center) - target.r)) +
        (approachAssist>.06?(target.deadly?'  ·  AUTO APPROACH':'  ·  AUTO LAND'):'');
    }
    if (charging) {
      chargeWrap.style.display = 'block';
      chargeBar.style.width = (charge * 100).toFixed(1) + '%';
      chargeBar.style.background = charge < 0.4 ? '#4caf50' : charge < 0.8 ? '#ffb300' : '#ff3d00';
    } else {
      chargeWrap.style.display = 'none';
    }

    adaptiveQuality.sample(dt);
    // Star density and resolution recover independently. This keeps the full
    // multi-million-star view on fast hardware, while smoothly trimming only
    // the least perceptible samples when sustained frame time rises.
    deepSkyRenderer.setDensityScale(17.5/Math.max(14,adaptiveQuality.frameEma));
    // Render directly at normal quality. The off-screen bloom target is not
    // multisampled in this Three.js version and produced crawling terrain
    // stipple at ground level; reserve it for the explicit High setting.
    // Very distant point sprites can lose depth precision against a planet at
    // walking scale. Atmospheres hide stars in daylight anyway, so suppress
    // the point layers locally and restore them as soon as the player climbs
    // above the atmosphere or visits an airless body.
    // Atmosphere extinction is continuous; never hard-toggle the star layers.
    for(const layer of starLayers)layer.visible=deepSkyVisibility>.002;
    deepSkyRenderer.update(elapsed,pos,camera.position,deepSkyVisibility);
    const suppressEarthOrbitalLayers=nearestP===earth&&distSurf<2500;
    if(earth.cloudMesh)earth.cloudMesh.visible=!suppressEarthOrbitalLayers;
    if(earth.nightMesh)earth.nightMesh.visible=!suppressEarthOrbitalLayers;
    earthTileRenderCenter.value.copy(earth.mesh.position);
    if (stylePass) stylePass.uniforms.time.value = elapsed;
    if(blackhole.passActive){
      const effectRadius=blackhole.effectRadiusPx;
      const desiredScale=effectRadius<96?.34:effectRadius<240?.46:effectRadius<540?.58:.62;
      const maxCaptureDimension=1280;
      const captureScale=Math.min(desiredScale,maxCaptureDimension/Math.max(
        blackhole.viewportSize.x,blackhole.viewportSize.y));
      const captureWidth=Math.max(1,Math.round(blackhole.viewportSize.x*captureScale));
      const captureHeight=Math.max(1,Math.round(blackhole.viewportSize.y*captureScale));
      const captureHz=effectRadius>540?24:effectRadius>240?30:24;
      const refreshCapture=!blackhole.captureReady||
        elapsed-blackhole.lastCaptureTime>=1/captureHz||
        blackhole.captureSize.x!==captureWidth||blackhole.captureSize.y!==captureHeight;
      if(refreshCapture){
        if(!blackhole.captureTarget){
          blackhole.captureTarget=new THREE.WebGLRenderTarget(captureWidth,captureHeight,{
            minFilter:THREE.LinearFilter,
            magFilter:THREE.LinearFilter,
            format:THREE.RGBAFormat,
            depthBuffer:true,
            stencilBuffer:false
          });
          blackhole.captureTarget.texture.generateMipmaps=false;
          blackhole.captureTarget.depthTexture=new THREE.DepthTexture(
            captureWidth,captureHeight,THREE.UnsignedIntType);
          blackhole.captureTarget.depthTexture.format=THREE.DepthFormat;
          blackhole.captureTarget.depthTexture.minFilter=THREE.NearestFilter;
          blackhole.captureTarget.depthTexture.magFilter=THREE.NearestFilter;
        }else if(blackhole.captureSize.x!==captureWidth||blackhole.captureSize.y!==captureHeight){
          blackhole.captureTarget.setSize(captureWidth,captureHeight);
        }
        blackhole.captureSize.set(captureWidth,captureHeight);
        blackhole.lensingMesh.visible=false;
        renderer.setRenderTarget(blackhole.captureTarget);
        renderer.render(scene,camera);
        renderer.setRenderTarget(null);
        blackhole.lensingMaterial.uniforms.sceneTexture.value=blackhole.captureTarget.texture;
        blackhole.lensingMaterial.uniforms.sceneDepthTexture.value=blackhole.captureTarget.depthTexture;
        blackhole.lensingMesh.visible=true;
        blackhole.captureReady=true;
        blackhole.lastCaptureTime=elapsed;
      }
    }
    renderer.render(scene, camera);
  }
  animate();
})();
