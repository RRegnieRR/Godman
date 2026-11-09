'use strict';
const assert=require('node:assert/strict'),T=global.THREE=require('../vendor/three.r128.min.js');
require('../src/runtime/propulsor-rig.js');require('../src/runtime/flight-dynamics.js');
require('../src/runtime/launch-sequence.js');
const up=new T.Vector3(0,1,0),heading=new T.Vector3(0,0,-1),zero=new T.Vector3(),gravity=new T.Vector3(0,-9.81,0);
const pose={},prepared={};GodmanLaunchSequence.sample(1,-1,prepared);GodmanLaunchSequence.sample(1,0,pose);
assert.ok(Math.abs(prepared.gather-pose.gather)<1e-8,'Release jumps away from the held charge pose');
GodmanLaunchSequence.sample(1,.16,pose);assert.ok(pose.gather===0&&pose.strike===1&&pose.flash>1,'Arm strike and ignition markers are not synchronized');
const seeded=new GodmanPropulsorRig(),seed=new T.Quaternion().setFromAxisAngle(up,1.2);
seeded.initialize(seed,up);seeded.update(1/60,{up,heading:new T.Vector3(0,0,1),aim:up,active:true,surface:1});
assert.ok(seeded.attitude.angleTo(seed)<2.21/60,'Engaging the engine snaps to the camera heading');
function run(hz){
 const engine=new GodmanFlightDynamics(),v=new T.Vector3(),p=new T.Vector3(),dt=1/hz;
 let previous=new T.Quaternion(),worst=0;
 for(let i=0;i<hz*20;i++){
  const t=i*dt,aim=t<3?up:t<6?new T.Vector3(0,0,-1):t<10?new T.Vector3(0,0,1):t<14?new T.Vector3(0,-1,0):up;
  const look=aim.clone().projectOnPlane(up);if(look.lengthSq()<.01)look.copy(heading);look.normalize();
  engine.update(dt,{velocity:v,gravity,up,heading:look,aim,frameVelocity:zero,surface:1,fuel:100,thrust:t<18,braking:t>19});
  engine.integrate(p,v,dt);
  assert.ok(engine.coordinated,'Real flight did not activate its shared frame');
  assert.ok(engine.rig.bodyUp.angleTo(engine.direction)<.721,'Physics requests thrust through the suit');
  assert.ok(engine.force.length()<=56.001,'Turning exceeds surface thrust authority');
  const angle=engine.rig.attitude.angleTo(previous);if(i)worst=Math.max(worst,angle/dt);
  previous.copy(engine.rig.attitude);
  assert.ok(v.toArray().every(Number.isFinite),'Turn/reversal generated a non-finite velocity');
  if(Math.abs(t-5.9)<dt/2)assert.ok(Math.abs(engine.rig.bodyUp.dot(up))<.04,'Forward flight stays tilted instead of horizontal');
  if(Math.abs(t-9.9)<dt/2)assert.ok(engine.direction.dot(aim)>.99,'Full reversal never converged to the new crosshair');
  if(Math.abs(t-13.9)<dt/2)assert.ok(engine.rig.bodyUp.dot(aim)>.99,'Descending thrust failed to become head-first');
 }
 assert.ok(worst<2.21,'Flight frame exceeds its turn rate');return {v,p,attitude:previous};
}
const coarse=run(30),fine=run(144);assert.ok(coarse.attitude.angleTo(fine.attitude)<.06,'Flight attitude depends on frame rate');
assert.ok(coarse.v.distanceTo(fine.v)<3,'Flight reversal physics diverges across frame rates');
for(const hz of [30,60,144])for(const charge of [0,.2,1]){
 const engine=new GodmanFlightDynamics(),v=up.clone().multiplyScalar(.6),p=new T.Vector3(),dt=1/hz;
 assert.ok(engine.beginLaunch(charge,heading,up,9.81,637100,100));
 const impulse=engine.launchImpulse.clone(),duration=engine.launchDuration;let fuel=100,used=0,flash=0;
 for(let i=0;i<Math.ceil(hz*2);i++){
  engine.update(dt,{velocity:v,gravity:zero,up,heading,aim:up,frameVelocity:zero,surface:1,fuel,thrust:false,braking:false});
  engine.integrate(p,v,dt);fuel-=engine.fuelUsed;used+=engine.fuelUsed;flash=Math.max(flash,engine.launchFlash);
  assert.ok(engine.force.length()<impulse.length()*1.51/duration,'Ignition exceeds its charged force envelope');
  if(i===0)assert.ok(v.clone().addScaledVector(up,-.6).length()<impulse.length()*.13,'Charge is still released as an instant velocity jump');
  if((i+1)*dt<engine.launchDelay-1e-8)assert.ok(engine.force.length()===0&&engine.fuelUsed===0&&engine.launchFlash===0,'Ignition occurs before the planted arm strike finishes');
 }
 assert.ok(v.clone().addScaledVector(up,-.6).distanceTo(impulse)<1e-6,'Rocket burn loses or duplicates launch energy');
 assert.ok(Math.abs(used-(.8+3.2*charge))<1e-8,'Launch fuel depends on frame rate');
 assert.ok(flash>=1&&engine.launchFlash<.01,'Boot ignition is absent or does not decay');
 assert.ok(p.y>0,'Rocket takeoff failed to clear the ground');
}
const empty=new GodmanFlightDynamics();assert.equal(empty.beginLaunch(1,up,up,9.81,637100,0),false,'Empty boots can launch');
// The grounded game's preparation and airborne update share a frame at
// ignition. Only the unconsumed part may advance the burn/integrator.
for(const hz of [20,30,144]){
 const engine=new GodmanFlightDynamics(),v=new T.Vector3(),p=new T.Vector3();let grounded=true;
 engine.beginLaunch(1,up,up,9.81,637100);
 for(let i=0;i<hz;i++){
  if(grounded&&engine.prepareLaunch(1/hz))grounded=false;
  if(!grounded){engine.update(1/hz,{velocity:v,gravity:zero,up,heading,aim:up,frameVelocity:zero,surface:1,fuel:100,thrust:false,braking:false});engine.integrate(p,v,1/hz);}
  assert.ok(Math.abs(engine.launchAge-(i+1)/hz)<1e-8,'Ignition counts its transition frame twice');
 }
 assert.ok(v.distanceTo(engine.launchImpulse)<1e-6,'Queued launch loses or duplicates impulse at ignition');
}
const full=new GodmanFlightDynamics(),low=new GodmanFlightDynamics();
full.beginLaunch(1,up,up,9.81,637100,100);low.beginLaunch(1,up,up,9.81,637100,.5);
assert.ok(low.launchImpulse.length()<full.launchImpulse.length()*.4,'An almost-empty tank supplied full launch energy');
for(const hz of [30,144]){
 const engine=new GodmanFlightDynamics(),v=up.clone().multiplyScalar(.6),p=new T.Vector3(0,637100,0);let fuel=100;
 engine.beginLaunch(1,up,up,9.81,637100,fuel);
 for(let i=0;i<hz*60;i++){
  const g=new T.Vector3(0,-9.81*(637100/p.y)**2,0);
  engine.update(1/hz,{velocity:v,gravity:g,up,heading,aim:up,frameVelocity:zero,surface:1,fuel,thrust:false,braking:false});
  fuel-=engine.fuelUsed;engine.integrate(p,v,1/hz);
 }
 assert.ok(p.y-637100>15000,'The finite rocket burn cannot clear the atmosphere');
}
console.log('PASS: shared physics/attitude frame, full reversals, head-first descent, turn limits, 30/60/144 FPS, finite charged burn, ignition decay and fuel accounting.');
