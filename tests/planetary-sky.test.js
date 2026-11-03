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
  assert.equal(layer.material.side,T.BackSide,'Ground observers must see cloud undersides only');
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
update(earth);assert.equal(sky.geometry,earthGeometry,'Returning to Earth allocated duplicate cloud geometry');
const reused={name:'Moon',r:173700,center:new T.Vector3(0,-173700,0)};update(reused);reused.name='Earth';reused.r=637100;reused.center.y=-637100;assert.ok(update(reused).enabled&&sky.layers.length===2,'Reused streamed body retained its old sky');
observer.set(0,30000,0);state=update(earth);assert.ok(!state.enabled&&state.starVisibility>.99,'Atmosphere did not give way to space');
assert.ok(sky.layers.every(l=>l.material.side===T.FrontSide),'Orbital cloud shells rendered their far-side faces');
observer.set(0,0,0);state=sky.update(camera,earth,observer,star,0,0);assert.equal(state.skyFactor,0,'Eclipse failed to darken the sky');
const fog=new GodmanSurfaceAtmosphere(T,scene,{surfaceFogDensity:.00016,mountainFogDensity:.00029,fadeAltitudeRatio:.018});
fog.update({enabled:true,altitude:480,bodyRadius:637100,fadeHeight:480,skyFactor:1,daylight:1,atmosphereColor:0x6db3ff});assert.equal(fog.fog.density,0,'Surface haze remained opaque above its layer');
const lights={key:new T.DirectionalLight(),ambient:new T.AmbientLight(),sky:new T.HemisphereLight(),rim:new T.DirectionalLight(),headlamp:new T.PointLight()};
const lighting=new GodmanPhysicalLighting(T,{toneMappingExposure:1},{baseExposure:.82,minExposure:.38,maxExposure:1.32,maxRelativeIrradiance:18},lights);
lighting.update({dt:.016,distance:1,au:1,skyFactor:0,nearAtmosphere:0,surface:true,directDay:0,sunHeight:-1});assert.equal(lights.key.intensity,0,'Sunlight shone through an airless planet at night');
sky.dispose();assert.equal(scene.children.filter(c=>c===sky.mesh).length,0);
console.log('PASS: daylight/twilight/night, airless and hazy worlds, eclipse, altitude-to-space transition, cloud geometry/depth/uniforms, extreme camera range, surface haze and airless night lighting.');
