'use strict';
const assert=require('node:assert/strict');
const T=require('../vendor/three.r128.min.js');
require('../src/runtime/earth-events.js');
const {events,diskCoverage,viewingNormal,moonPosition,observationOrbit}=GodmanEarthEvents;
assert.equal(diskCoverage(1,.5,0),.25);
assert.equal(diskCoverage(1,1,2),0);
assert.equal(diskCoverage(1,2,.5),1);
assert.ok(Math.abs(diskCoverage(1,1,1)-.39100221895577)<1e-10);

for(const scale of [1,10]){
  const earth={r:6371000/scale,center:new T.Vector3(8e10/scale,1e8/scale,0)};
  const sun={r:696000000/scale,center:earth.center.clone().add(new T.Vector3(-1.496e11/scale,0,0))};
  const moonRadius=1737000/scale;
  const lunarAngular=new Map();
  for(const event of events){
    const normal=viewingNormal(T,earth,sun,event,()=>true);
    const observer=earth.center.clone().addScaledVector(normal,earth.r+30/scale);
    const solarRay=sun.center.clone().sub(observer);
    const solarAngular=Math.asin(sun.r/solarRay.length());
    assert.ok(Math.abs(normal.dot(solarRay.clone().normalize())-Math.sin(event.sunElevation*Math.PI/180))<.00006);
    if(!event.range)continue;
    const moon=moonPosition(T,event,observer,earth,sun,scale,new T.Vector3());
    assert.ok(Math.abs(moon.distanceTo(earth.center)*scale-event.range)<.1);
    const moonRay=moon.clone().sub(observer);
    assert.ok(normal.dot(moonRay.clone().normalize())>0,'Event subject sits below the viewing site horizon');
    const angularMoon=Math.asin(moonRadius/moonRay.length());
    lunarAngular.set(event.id,angularMoon);
    if(event.solarOffset!==undefined){
      const coverage=diskCoverage(solarAngular,angularMoon,solarRay.angleTo(moonRay));
      if(event.id==='total-solar')assert.equal(coverage,1);
      if(event.id==='annular')assert.ok(coverage>.8&&coverage<1&&angularMoon<solarAngular);
      if(event.id==='partial-solar')assert.ok(coverage>.25&&coverage<.55);
    }
    if(event.lunarOffset!==undefined){
      const earthRay=earth.center.clone().sub(moon),sunRay=sun.center.clone().sub(moon);
      const earthAngle=Math.asin(earth.r/earthRay.length()),sunAngle=Math.asin(sun.r/sunRay.length());
      const separation=earthRay.angleTo(sunRay),diskAngle=Math.asin(moonRadius/earthRay.length());
      if(event.id==='blood-moon')assert.ok(separation+diskAngle<earthAngle-sunAngle);
      if(event.id==='partial-lunar')assert.ok(separation-diskAngle<earthAngle-sunAngle&&separation+diskAngle>earthAngle-sunAngle);
      if(event.id==='penumbral')assert.ok(separation-diskAngle>earthAngle-sunAngle&&separation-diskAngle<earthAngle+sunAngle);
      if(['full-moon','supermoon'].includes(event.id))assert.ok(separation-diskAngle>earthAngle+sunAngle);
    }
  }
  assert.ok(lunarAngular.get('supermoon')>lunarAngular.get('full-moon'));

  const total=events.find(event=>event.id==='total-solar');
  const normal=viewingNormal(T,earth,sun,total,()=>true);
  const observer=earth.center.clone().addScaledVector(normal,earth.r);
  const initialMoon=moonPosition(T,total,observer,earth,sun,scale,new T.Vector3());
  const nominal={inc:5.1*Math.PI/180,R:384400e3/scale,w:Math.PI*2/(27.32*86400)};
  const orbit=observationOrbit(T,nominal,initialMoon.clone().sub(earth.center));
  assert.ok(Math.abs(orbit.axis.dot(orbit.offset.clone().normalize()))<1e-9);
  assert.ok(orbit.rate>nominal.w,'The Moon should move faster along the closer demonstration orbit');
  const spin=new T.Vector3(0,1,0);
  const originalEarth=earth.center.clone().sub(sun.center);
  const time=3*3600;
  const movingEarth=originalEarth.applyAxisAngle(spin,-time*Math.PI*2/(365.25*86400)).add(sun.center);
  const movingObserver=normal.clone().applyAxisAngle(spin,time*Math.PI*2/(23.93*3600))
    .multiplyScalar(earth.r).add(movingEarth);
  const movingMoon=orbit.offset.clone().applyAxisAngle(orbit.axis,orbit.rate*time).add(movingEarth);
  assert.ok(Math.abs(movingMoon.distanceTo(movingEarth)-orbit.offset.length())<.001);
  const movingSunRay=sun.center.clone().sub(movingObserver),movingMoonRay=movingMoon.clone().sub(movingObserver);
  const remainingCover=diskCoverage(Math.asin(sun.r/movingSunRay.length()),Math.asin(moonRadius/movingMoonRay.length()),movingSunRay.angleTo(movingMoonRay));
  assert.ok(remainingCover<.01,'The initial alignment should move on from totality');
}
console.log('PASS: eclipse geometry, disk coverage, lunar phases, viewing sites and evolving orbits at both scales.');
