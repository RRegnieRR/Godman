'use strict';
const assert=require('node:assert/strict');
const T=global.THREE=require('../vendor/three.r128.min.js');
require('../src/runtime/autopilot.js');

function fly({distance,scale,fps,landing,speed=50}){
  const pilot=new GodmanAutopilot(scale);
  const position=new T.Vector3(-distance,0,0),velocity=new T.Vector3(speed,60,0);
  const target=new T.Vector3(),targetVelocity=new T.Vector3(700,-200,120);
  const relative=new T.Vector3(),next=new T.Vector3(),offset=new T.Vector3();
  const arrivalRadius=100,dt=1/fps,phases=new Set();
  let peak=0;
  for(let time=0;time<120;time+=dt){
    const gap=target.distanceTo(position)-arrivalRadius;
    relative.copy(velocity).sub(targetVelocity);
    if(landing?gap<=.05:gap<.5&&relative.length()<.5){
      return {speed:relative.length(),peak,gap,phases,time};
    }
    offset.copy(target).sub(position);
    pilot.plan({offset,velocity:relative,arrivalRadius,landing,surface:gap<20000?1:0,speedLimit:2.4e21});
    pilot.step(dt,next).add(targetVelocity);
    position.addScaledVector(velocity,dt*.5).addScaledVector(next,dt*.5);
    velocity.copy(next);
    target.addScaledVector(targetVelocity,dt);
    peak=Math.max(peak,relative.length());
    phases.add(pilot.phase);
  }
  throw new Error('The flight never arrived');
}

for(const scale of [1,10])for(const fps of [30,60,120]){
  const result=fly({distance:1.5e10*scale,scale,fps,landing:true});
  assert.ok(result.peak>1e8*scale,'Interplanetary flight stayed at surface speeds');
  assert.ok(result.phases.has('BRAKING')&&result.phases.has('LANDING'));
  assert.ok(result.speed<4&&result.gap>-.15,'Arrival missed the slow landing envelope');
}
const late=fly({distance:1e6,scale:1,fps:60,landing:true,speed:3e5});
assert.ok(late.speed<4&&late.gap>-.15,'A fast late lock could not slow down');
const standoff=fly({distance:3e8,scale:1,fps:60,landing:false,speed:1000});
assert.ok(standoff.gap>0&&standoff.speed<.5&&standoff.phases.has('STANDOFF'));
const pilot=new GodmanAutopilot(1);
pilot.plan({offset:new T.Vector3(500,0,0),velocity:new T.Vector3(),arrivalRadius:100,
  landing:true,departure:new T.Vector3(0,1,0),speedLimit:2000,surface:1});
assert.ok(pilot.step(1/60,new T.Vector3()).y>0,'Departure did not climb');
pilot.reset();
assert.equal(pilot.acceleration.lengthSq(),0);
console.log('PASS: moving destinations, two scales, fast cruise, braking, gentle landing, and safe standoff.');
