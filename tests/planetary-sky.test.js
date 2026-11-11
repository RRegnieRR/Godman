'use strict';
const assert=require('node:assert/strict');
const T=global.THREE=require('../vendor/three.r128.min.js');
global.window=global;
require('../src/runtime/planetary-sky.js');require('../src/runtime/atmosphere.js');require('../src/runtime/physical-lighting.js');
const scene=new T.Scene(),sky=new GodmanPlanetarySky(T,scene);
const camera=new T.PerspectiveCamera(60,1,.5,1e23);camera.position.set(0,2,0);camera.lookAt(0,4,-10);
const observer=new T.Vector3(),star={center:new T.Vector3(0,1.496e10,0),temperature:5772,luminosity:1};
const earth={name:'Earth',r:637100,center:new T.Vector3(0,-637100,0),atmosphere:0x6db3ff,mesh:new T.Object3D()};
const update=body=>sky.update(camera,body,observer,star,100);
assert.equal(GodmanSkyProfile({name:'Moon'}),null);
assert.equal(GodmanSkyProfile({name:'Mercury'}),null);
assert.equal(GodmanSkyProfile({name:'Sun',isStar:true}),null);
assert.ok(GodmanSkyProfile({name:'Mars'}).mars);
assert.ok(GodmanSkyProfile({name:'Unknown',atmosphere:0xabcdef}));
let state=update(earth);
assert.ok(state.enabled&&state.skyFactor>.99,'Earth daylight sky was disabled');
assert.ok(state.starVisibility<.001,'Daylight did not extinguish the starfield');
assert.equal(sky.layers.length,2);
assert.ok(!sky.material.transparent&&!sky.material.depthWrite&&sky.material.depthTest,'Sky must respect foreground depth');
assert.ok(sky.mesh.renderOrder>10000,'Sky must draw after opaque terrain');
assert.equal(sky.material.depthFunc,T.LessEqualDepth,'Far-depth sky must pass on the cleared background');
assert.ok(sky.geometry.index.count<(512*255*6)*.26,'Earth clouds retained oversized geometry');
for(const layer of sky.layers){
  assert.ok(layer.material.depthTest&&!layer.material.depthWrite,'Clouds must respect foreground depth');
  assert.equal(layer.material.side,T.BackSide,'Earth cloud proxy should use a single face throughout the crossing');
  for(const key of ['irradiance','eclipse','sunDirection','sunLocal','sunColor','horizonDip'])assert.ok(layer.material.uniforms[key],`Missing cloud uniform ${key}`);
  // A coarse planet mesh can dip below its own surface between vertices,
  // causing the cloud deck to disappear from ground level.
  const segments=sky.geometry.parameters.heightSegments;
  const sag=(earth.r+layer.userData.deck.height/10)*(1-Math.cos(Math.PI/segments));
  assert.ok(sag<layer.userData.deck.height/10,'Cloud geometry intersects the ground');
}
// Infinity-like camera ranges must still generate finite GPU view rays.
const inverse=new T.Matrix4().fromArray(new Float32Array(camera.projectionMatrixInverse.elements));
const ray=new T.Vector4(.8,.8,0,1).applyMatrix4(inverse);
assert.ok(Math.abs(ray.w)>1e-5&&ray.toArray().every(Number.isFinite));
star.center.set(0,-1.496e10,0);state=update(earth);
assert.equal(state.daylight,0);assert.equal(state.skyFactor,0);assert.ok(state.starVisibility>.99,'Clear Earth night lost its stars');
star.center.set(1.496e10,0,0);state=update(earth);
assert.ok(state.daylight>0&&state.daylight<1,'Sunset became an abrupt day/night toggle');
let previous=0;for(let i=-90;i<=90;i++){const day=GodmanSkyDaylight(Math.sin(i*Math.PI/180));assert.ok(day>=previous);previous=day;}
const moon={name:'Moon',r:173700,center:new T.Vector3(0,-173700,0)};
const earthGeometry=sky.geometry;
star.center.set(0,1.496e10,0);state=update(moon);
assert.ok(!state.enabled&&!sky.mesh.visible);assert.equal(state.starVisibility,1);assert.equal(sky.layers.length,0);
for(const name of ['Mars','Venus','Titan','Triton','Jupiter','Saturn','Uranus','Neptune']){
 const body={name,r:600000,center:new T.Vector3(0,-600000,0)};
 assert.ok(update(body).enabled,`${name} has no local sky`);
 assert.ok(sky.material.uniforms.betaR.value.toArray().every(Number.isFinite));
 star.center.set(0,-1.496e10,0);const night=update(body);if(name==='Venus'||name==='Titan')assert.ok(night.starVisibility<.01,'Opaque haze revealed the deep sky');
 star.center.set(0,1.496e10,0);
}
for(const [name,r] of [['Earth',637100],['Jupiter',6991100],['Saturn',5823200],['Neptune',2462200]]){
  const body={name,r,center:new T.Vector3(0,-r,0)};update(body);
  for(const layer of sky.layers){
    const sag=(r+layer.userData.deck.height/10)*(1-Math.cos(Math.PI/sky.geometry.parameters.heightSegments));
    assert.ok(sag<layer.userData.deck.height/10,`${name} optimized cloud shell intersects ground`);
  }
}
update(earth);
for(const layer of sky.layers){
 const u=layer.material.uniforms,deck=layer.userData.deck;
 assert.ok(layer.userData.volume&&layer.material.extensions.fragDepth,'Earth clouds lack a depth-tested volume');
 assert.ok((u.cloudTop.value-u.cloudBase.value)*earth.r*10>1000,'Earth cloud collapsed into a sheet');
 for(const offset of [-deck.thickness,-1,0,1,deck.thickness]){
  observer.y=(deck.height+offset)/10-camera.position.y;
  update(earth);
  assert.equal(layer.material.side,T.BackSide,'Earth cloud proxy switched faces during descent');
  assert.equal(u.opacity.value,deck.opacity,'Earth cloud volume pops at the deck center');
  assert.ok(Math.abs(u.cloudObserver.value.length()-1-(deck.height+offset)/10/earth.r)<1e-10,'Cloud volume uses the wrong camera altitude');
 }
}
observer.set(0,0,0);
const fallback=new GodmanPlanetarySky(T,new T.Scene(),false);
observer.y=GodmanSkyProfiles.Earth.clouds[0].height/10-camera.position.y;
fallback.update(camera,earth,observer,star,0);
assert.equal(fallback.layers[0].material.uniforms.opacity.value,0,'Legacy cloud shell does not fade at its face transition');
fallback.dispose();observer.set(0,0,0);
update(earth);assert.equal(sky.geometry,earthGeometry,'Returning to Earth allocated duplicate cloud geometry');
const reused={name:'Moon',r:173700,center:new T.Vector3(0,-173700,0)};update(reused);reused.name='Earth';reused.r=637100;reused.center.y=-637100;assert.ok(update(reused).enabled&&sky.layers.length===2,'Reused streamed body retained its old sky');
observer.set(0,30000,0);state=update(earth);assert.ok(!state.enabled&&state.starVisibility>.99,'Atmosphere did not give way to space');
assert.ok(sky.layers.every(l=>l.userData.volume&&l.material.side===T.BackSide),'Orbital Earth switched back to thin shells');
const fullScaleSky=new GodmanPlanetarySky(T,new T.Scene(),true,1);
const fullScaleEarth={...earth,r:earth.r*10,center:earth.center.clone().multiplyScalar(10)};
const fullScaleStar={...star,center:star.center.clone().multiplyScalar(10)};
observer.set(0,30000,0);
assert.ok(fullScaleSky.update(camera,fullScaleEarth,observer,fullScaleStar,0).enabled,'Full-scale Earth lost its atmosphere at 30 km');
assert.equal(fullScaleSky.material.uniforms.topRadius.value,sky.material.uniforms.topRadius.value);
observer.set(0,160000,0);
assert.ok(!fullScaleSky.update(camera,fullScaleEarth,observer,fullScaleStar,0).enabled,'Full-scale atmosphere extended past its fade');
fullScaleSky.dispose();
observer.set(0,0,0);state=sky.update(camera,earth,observer,star,0,0);assert.equal(state.skyFactor,0,'Eclipse failed to darken the sky');
const fog=new GodmanSurfaceAtmosphere(T,scene,{surfaceFogDensity:.00016,mountainFogDensity:.00029,fadeAltitudeRatio:.018});
const hazeState={enabled:true,altitude:0,bodyRadius:6371000,fadeHeight:4800,skyFactor:1,daylight:1,atmosphereColor:0x72aaff};
fog.update(hazeState);
const originalBlue=fog.fog.color.b-fog.fog.color.r,originalDensity=fog.fog.density;
fog.update({...hazeState,earth:true});
assert.ok(fog.fog.color.b-fog.fog.color.r<originalBlue*.5,'Earth surface haze stayed saturated blue');
assert.ok(fog.fog.density<originalDensity,'Earth haze still obscures the distant ground');
fog.update({enabled:true,altitude:480,bodyRadius:637100,fadeHeight:480,skyFactor:1,daylight:1,atmosphereColor:0x6db3ff});assert.equal(fog.fog.density,0,'Surface haze remained opaque above its layer');
// C moves only the camera. Earth remains directly below the astronaut.
star.center.set(0,1.496e10,0);
camera.position.set(0,2,0);
assert.ok(update(earth).starVisibility<.001);
camera.position.set(0,earth.r*12,0);
state=update(earth);
assert.equal(state.starVisibility,1,'Overview inherited daylight extinction from the player');
assert.equal(state.immersion,0,'Overview suppressed the orbital atmosphere rim');
assert.ok(!state.enabled&&sky.layers.every(layer=>!layer.visible),'Overview rendered near-surface sky layers');
const lights={key:new T.DirectionalLight(),ambient:new T.AmbientLight(),sky:new T.HemisphereLight(),rim:new T.DirectionalLight(),headlamp:new T.PointLight()};
const lighting=new GodmanPhysicalLighting(T,{toneMappingExposure:1},{baseExposure:.82,minExposure:.38,maxExposure:1.32,maxRelativeIrradiance:18},lights);
lighting.update({dt:.016,distance:1,au:1,skyFactor:0,nearAtmosphere:0,surface:true,directDay:0,sunHeight:-1});assert.equal(lights.key.intensity,0,'Sunlight shone through an airless planet at night');
const twilight=GodmanPhysicalLighting.earthTwilight;
assert.equal(twilight(-.02),1);
assert.equal(twilight(-.25),0);
assert.equal(twilight(.5),0);
const sunset={dt:.016,distance:1,au:1,skyFactor:.32,nearAtmosphere:1,surface:true,directDay:.2,sunHeight:-.02,skyTint:0x72aaff};
lighting.update({...sunset,earth:true,altitude:0,planetRadius:6371000,twilight:twilight(sunset.sunHeight)});
assert.ok(lights.sky.color.r>lights.sky.color.b,'Sunset ground fill stayed blue');
lighting.update({...sunset,sunHeight:.5,skyFactor:1,twilight:twilight(.5)});
assert.ok(lights.sky.color.b>lights.sky.color.r,'Earth daylight inherited the sunset tint');
fog.update({enabled:true,altitude:0,bodyRadius:637100,fadeHeight:480,skyFactor:.32,daylight:.4,atmosphereColor:0x72aaff,twilight:1});
assert.ok(fog.fog.color.r>fog.fog.color.b,'Twilight haze tinted distant terrain blue');
const earthLight={...sunset,earth:true,altitude:0,planetRadius:6371000,sunHeight:1,directDay:1,skyFactor:1,twilight:0};
lighting.update(earthLight);
const noon=lights.key.color.clone(),noonPower=lights.key.intensity;
lighting.update({...earthLight,sunHeight:.035,twilight:1,skyFactor:.8});
const lowSun=lights.key.color.clone(),lowPower=lights.key.intensity;
assert.ok(lowPower<noonPower&&lowPower>noonPower*.55,'Low sunlight lost its daylight-to-sunset energy range');
assert.ok(lowSun.b/noon.b<lowSun.g/noon.g&&lowSun.g<noon.g,'Low sun did not scatter more blue than green');
lighting.update({...earthLight,sunHeight:.035,altitude:36000,skyFactor:.3});
assert.ok(lights.key.intensity>lowPower&&lights.key.color.b>lowSun.b,'Thin high-altitude air retained dense sunset attenuation');
lighting.update({...earthLight,sunHeight:-.025,altitude:15000,skyFactor:.55});
assert.ok(lights.key.color.b<noon.b,'A below-horizon grazing ray ignored the lower air column');
lighting.update({...earthLight,groundAlbedo:new T.Color(.58,.27,.10)});
assert.ok(lights.sky.groundColor.r>lights.sky.groundColor.b,'Warm ground did not tint the reflected light');
lighting.update({...earthLight,groundAlbedo:new T.Color(.14,.48,.09)});
assert.ok(lights.sky.groundColor.g>lights.sky.groundColor.r,'Vegetated ground did not tint the reflected light');
lighting.update({...earthLight,earth:false,skyFactor:0,nearAtmosphere:0,sunHeight:-1,directDay:0});
assert.ok(lights.sky.groundColor.equals(lighting.defaultBounce),'Ground bounce leaked onto a different world');
assert.equal(lights.key.intensity,0);
lighting.update({...earthLight,eclipse:0,directDay:1,skyFactor:0});
assert.equal(lights.key.intensity,0,'Earth lighting bypassed the eclipse mask');
const sunVisible=GodmanPhysicalLighting.earthSunVisibility;
const earthRadius=6371000,solarRadius=.00465;
assert.equal(sunVisible(-.07,0,earthRadius,solarRadius),0,'Ground sunlight leaked below the horizon');
assert.equal(sunVisible(.035,0,earthRadius,solarRadius),1,'Low sunlight lost the established sunset look');
assert.equal(sunVisible(-.13,150000,earthRadius,solarRadius),1,'Sunlight switched off at the upper atmosphere');
assert.equal(sunVisible(-.3,150000,earthRadius,solarRadius),0,'Earth failed to eclipse the Sun from orbit');
assert.equal(sunVisible(-.13,15000,earthRadius/10,solarRadius),sunVisible(-.13,150000,earthRadius,solarRadius));
const moonlight=GodmanPhysicalLighting.lunarIrradiance;
assert.equal(moonlight(1,.3,1,0,1),1,'A full Moon failed to light a clear night');
assert.ok(moonlight(0,.3,1,0,1)<.4&&moonlight(0,.3,1,0,1)>.2,'Quarter Moon brightness ignored phase');
assert.ok(moonlight(-1,.3,1,0,1)<1e-12,'A new Moon lit the night');
assert.equal(moonlight(1,-.1,1,0,1),0,'Moonlight leaked through Earth');
assert.equal(moonlight(1,.3,1,1,1),0,'Moonlight washed out daylight');
assert.equal(moonlight(1,.3,1,0,0),0,'Lunar eclipse failed to block moonlight');
sky.dispose();assert.equal(scene.children.filter(c=>c===sky.mesh).length,0);
console.log('PASS: daylight/twilight/night, airless and hazy worlds, eclipse, altitude-to-space transition, cloud geometry/depth/uniforms, extreme camera range, surface haze and airless night lighting.');
