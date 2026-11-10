'use strict';
const assert=require('node:assert/strict'),T=global.THREE=require('../vendor/three.r128.min.js');
require('../src/runtime/propulsor-rig.js');require('../src/runtime/flight-dynamics.js');
const Y=new T.Vector3(0,1,0),zero=new T.Vector3(),heading=new T.Vector3(0,0,-1);
for(const hz of [30,60,144])for(const [axis,g] of [[Y,9.81],[new T.Vector3(1,0,0),1.62],[Y,24.79]]){
 const engine=new GodmanFlightDynamics(),dt=1/hz,R=637100,center=new T.Vector3(100,-20,300);
 const p=center.clone().addScaledVector(axis,R+120),frame=new T.Vector3(2,0,0);
 const v=heading.clone().multiplyScalar(35).addScaledVector(axis,-8).add(frame);
 const body={},up=axis.clone();let fuel=100;const heldRadius=p.distanceTo(center);
 const seed=new T.Quaternion().setFromUnitVectors(Y,axis).multiply(new T.Quaternion().setFromAxisAngle(new T.Vector3(1,0,0),.45));
 engine.rig.initialize(seed,axis);
 for(let i=0;i<hz*14;i++){
  up.copy(p).sub(center).normalize();
  engine.update(dt,{velocity:v,gravity:up.clone().multiplyScalar(-g),up,heading,aim:heading,position:p,center,body,frameVelocity:frame,surface:1,fuel,thrust:false,braking:true});
  if(engine.brakeForce.lengthSq()>1e-6){
   assert.ok(engine.brakeForce.dot(heading)<0,'Shift failed to push against forward travel');
   const total=engine.rig.ports.reduce((sum,port)=>sum.add(port.force),new T.Vector3());
   assert.ok(total.applyQuaternion(engine.rig.attitude).distanceTo(engine.force)<1e-7,'Brake jets do not match applied force');
  }
  engine.integrate(p,v,dt);center.addScaledVector(frame,dt);fuel-=engine.fuelUsed;
  assert.equal(fuel,100,'Shift braking or hover consumed fuel');
  assert.ok(Number.isFinite(p.length()),'Hover has invalid position');
  if(i>hz*9){
   assert.ok(engine.hovering&&engine.hoverLocked,'Holding Shift failed to maintain altitude');
   assert.ok(Math.abs(p.distanceTo(center)-heldRadius)<.03,'Stopped hover drifts in altitude');
   assert.ok(engine.rig.ports.filter(x=>x.type==='hand').every(x=>x.power===0),'Hands stay lit during settled hover');
   assert.ok(engine.rig.ports.filter(x=>x.type==='foot').every(x=>x.power>.1),'Hover boots switched off');
  }
 }
 assert.ok(v.clone().sub(frame).length()<.03,'Braking did not stop relative drift');
 const altitude=p.distanceTo(center);
 engine.update(dt,{velocity:v,gravity:axis.clone().multiplyScalar(-g),up:axis,heading,aim:heading,position:p,center,body,frameVelocity:frame,surface:1,fuel,thrust:false,braking:false});
 assert.ok(!engine.hovering&&!engine.hoverLocked,'Releasing Shift latched altitude hold');
 assert.ok(v.clone().sub(frame).dot(axis)<-.01,'Coasting after Shift release did not resume gravity');
 engine.update(dt,{velocity:v,gravity:axis.clone().multiplyScalar(-g),up:axis,heading,aim:heading,position:p,center,body,frameVelocity:frame,surface:1,fuel,thrust:true,braking:false});
 assert.ok(!engine.hovering&&!engine.hoverLocked,'Space cannot leave hover');
 assert.ok(Math.abs(p.distanceTo(center)-altitude)<1e-5,'Leaving hover teleports the character');
 engine.update(dt,{velocity:v,gravity:axis.clone().multiplyScalar(-g),up:axis,heading,aim:heading,position:p,center,body,frameVelocity:frame,surface:1,fuel:0,thrust:false,braking:false});
 assert.ok(!engine.hovering&&engine.force.length()<1e-8,'Unpowered coast applied lift');
 engine.update(dt,{velocity:v,gravity:axis.clone().multiplyScalar(-g),up:axis,heading,aim:heading,position:p,center,body,frameVelocity:frame,surface:1,fuel:0,thrust:false,braking:true});
 assert.ok(engine.hovering&&engine.force.dot(axis)>0,'An empty tank disabled fuel-free Shift support');
 assert.equal(engine.fuelUsed,0);
}
// Brake from a steep dive while the camera faces back over the suit.
{
 const engine=new GodmanFlightDynamics(),dt=1/120;
 const right=new T.Vector3(1,0,0),opposite=heading.clone().negate();
 const start=new T.Quaternion().setFromAxisAngle(right,-2.85);
 const v=new T.Vector3(0,-12,-22),gravity=new T.Vector3(0,-9.81,0);
 engine.rig.initialize(start,Y);
 for(let i=0;i<600;i++){
  engine.update(dt,{velocity:v,gravity,up:Y,heading:opposite,aim:opposite,
    frameVelocity:zero,surface:1,fuel:100,thrust:false,braking:true});
  assert.ok(right.clone().applyQuaternion(engine.rig.attitude).dot(right)>.99,'Shift flipped the suit sideways toward the camera');
 }
 assert.ok(engine.rig.bodyUp.dot(Y)>.995,'Shift did not recover upright from a steep dive');
}
// A fast banked approach should shed speed early without rotating past
// the captured hover orientation or adding sideways drift.
for(const hz of [30,60,144]){
 const engine=new GodmanFlightDynamics(),dt=1/hz;
 const seed=new T.Quaternion().setFromEuler(new T.Euler(-1.25,.35,.65));
 engine.rig.initialize(seed,Y);
 engine.rig.angularVelocity.set(.25,.85,-1.65);
 const velocity=heading.clone().multiplyScalar(620),gravity=new T.Vector3(0,-9.81,0);
 let previousSpeed=velocity.length(),previousAngle=Infinity;
 for(let i=0;i<hz*4;i++){
  engine.update(dt,{velocity,gravity,up:Y,heading,aim:heading.clone().negate(),
   frameVelocity:zero,surface:1,fuel:10,thrust:false,braking:true});
  const speed=velocity.clone().projectOnPlane(Y).length();
  const angle=engine.rig.attitude.angleTo(engine.rig.target);
  assert.ok(speed<=previousSpeed+1e-8,'High-speed brake added speed');
  assert.ok(angle<=previousAngle+1e-8,'The braking suit swung away from its hold attitude');
  assert.ok(Math.abs(velocity.x)<1e-7&&velocity.z<=1e-8,'High-speed brake pushed sideways or reversed travel');
  if(i===Math.round(hz*.6))assert.ok(speed<490,'Counter-thrust took too long to engage');
  if(i===hz*2)assert.ok(speed<70,'High-speed braking was too slow');
  previousSpeed=speed;previousAngle=angle;
 }
 assert.ok(engine.rig.bodyUp.dot(Y)>.999&&previousSpeed<.06,'Fast braking did not settle');
}
// A yaw turn uses actual opposing fore/aft hand forces. The opposite pair
// brakes the angular velocity as the target is reached.
for(const direction of [-1,1]){
 const rig=new GodmanPropulsorRig();rig.initialize(new T.Quaternion(),Y);
 const look=new T.Vector3(direction,0,0);let driving=false,counter=false;
 for(let i=0;i<600;i++){
  rig.update(1/120,{up:Y,heading:look,aim:Y,active:true,surface:1,authority:56});
  const torque=new T.Vector3(),net=new T.Vector3();
  for(const port of rig.ports){torque.add(new T.Vector3().crossVectors(port.lever,port.control));net.add(port.control);}
  assert.ok(torque.distanceTo(rig.controlTorque)<1e-8,'Angular response does not match its hand/boot force couples');
  assert.ok(Math.abs(net.x)+Math.abs(net.z)<1e-8,'Steering couple introduces an unbalanced sideways force');
  if(rig.controlTorque.y*direction<-.1)driving=true;
  if(driving&&rig.controlTorque.y*direction>.1)counter=true;
  rig.updatePorts(Y.clone().multiplyScalar(30));
  const total=rig.ports.reduce((sum,p)=>sum.add(p.force),new T.Vector3());
  assert.ok(total.distanceTo(Y.clone().multiplyScalar(30).add(rig.controlNet))<1e-7,'Visible port forces disagree with translational steering');
 }
 assert.ok(driving&&counter,'Turn lacks a driving hand pair or counter-rotation braking');
 assert.ok(new T.Vector3(0,0,-1).applyQuaternion(rig.attitude).dot(look)>.99,'Yaw steering did not reach its heading');
}
console.log('PASS: Held-Shift altitude hold, moving planet frames, Moon/Earth/Jupiter gravity, boot-only support, Space resume, empty-tank Shift support, torque-producing hand jets and counter-steering.');
