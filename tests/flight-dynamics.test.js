'use strict';
const assert=require('node:assert/strict'),T=global.THREE=require('../vendor/three.r128.min.js');
require('../src/runtime/propulsor-rig.js');
require('../src/runtime/flight-dynamics.js');
const fs=require('node:fs'),vm=require('node:vm');
const up=new T.Vector3(0,1,0),gravity=new T.Vector3(0,-9.81,0),aim=new T.Vector3(0,-.3,-1).normalize(),zero=new T.Vector3();
function simulation(hz,{thrust=false,move=zero,initial=new T.Vector3(),fuel=100,surface=1,braking=false,time=2,look=aim}={}){
 const flight=new GodmanFlightDynamics(),v=initial.clone(),p=new T.Vector3();let peak=0;
 for(let i=0;i<hz*time;i++){
  flight.update(1/hz,{velocity:v,gravity,up,aim:look,move,frameVelocity:zero,surface,fuel,thrust,braking});
  flight.integrate(p,v,1/hz);peak=Math.max(peak,p.y);
 }
 return {flight,v,p,peak};
}
for(const hz of [30,60,144]){
 const fall=simulation(hz,{initial:new T.Vector3(3,0,0)});
 assert.ok(Math.abs(fall.p.y+.5*9.81*4)<1e-8,'Ballistic descent depended on frame rate');
 assert.ok(Math.abs(fall.p.x-6)<1e-8,'Unpowered drift lost horizontal momentum');
 const jumpSpeed=new GodmanFlightDynamics().jumpVelocity(0),jump=simulation(hz,{initial:up.clone().multiplyScalar(jumpSpeed)});
 assert.ok(Math.abs(jump.peak-jumpSpeed**2/(2*9.81))<.003,'Ordinary jump has an incorrect apex');
 const lift=simulation(hz,{thrust:true,look:up});
 assert.ok(lift.v.y>20&&lift.p.y>15,'Upward aim could not ascend');
 const recover=simulation(hz,{thrust:true,look:up,initial:new T.Vector3(0,-12,0)});
 assert.ok(recover.v.y>10,'Repulsors failed to arrest a fall and climb');
 const right=simulation(hz,{thrust:true,look:new T.Vector3(1,0,0),move:new T.Vector3(-1,0,0)});
 assert.ok(right.v.x>50&&right.v.y<0,'Crosshair direction was overridden by automatic lift or WASD');
 assert.ok(right.flight.direction.x>.99&&Math.abs(right.flight.direction.y)<1e-8,'Pose direction disagrees with applied force');
 const empty=simulation(hz,{thrust:true,fuel:0});assert.ok(!empty.flight.powered&&empty.p.distanceTo(simulation(hz).p)<1e-8,'Empty fuel generated thrust');
 const brake=simulation(hz,{braking:true,initial:new T.Vector3(30,0,0)});assert.ok(brake.v.x<1,'Air brake did not arrest horizontal drift');
 const cruise=simulation(hz,{thrust:true,surface:0});assert.ok(cruise.v.z< -50,'Deep-space camera-directed cruise was lost');
}
// Stronger surface thrust must build, release and redirect continuously,
// without exceeding its authority even after a high-speed space approach.
for(const hz of [30,60,144]){
 const engine=new GodmanFlightDynamics(),v=new T.Vector3(),dt=1/hz;
 const state={velocity:v,gravity,up,aim:up,move:zero,frameVelocity:zero,surface:1,fuel:100,thrust:true,braking:false};
 let previous=0;
 for(let i=0;i<hz*2;i++){
  engine.update(dt,state);const power=engine.force.length();
  assert.ok(power>=previous-1e-8&&power<=56+1e-8,'Ignition overshot or oscillated');
  assert.ok((power-previous)/dt<260,'Ignition applied a sudden force spike');
  if(i===0)assert.ok(power<5,'Ignition started at full power');
  previous=power;
 }
 assert.ok(previous>55,'Sustained surface thrust did not reach the stronger output');
 const held=engine.direction.clone();
 for(let i=0;i<hz;i++){
  engine.update(dt,{...state,thrust:false,aim:new T.Vector3(1,0,0)});
  assert.ok(engine.force.length()<=previous+1e-8,'Release increased thrust');
  if(i===0)assert.ok(engine.force.length()>45,'Release cut thrust in one frame');
  assert.ok(engine.direction.dot(held)>.99999,'Release redirected the remaining thrust');previous=engine.force.length();
 }
 assert.ok(previous<.2,'Release tail remained excessively powerful');
 for(let i=0;i<hz;i++)engine.update(dt,state);
 for(let i=0;i<hz;i++){
  const before=engine.direction.clone();engine.update(dt,{...state,aim:new T.Vector3(0,-1,0)});
  assert.ok(engine.direction.angleTo(before)<=4.5*dt+1e-6,'Aim reversal snapped the force direction');
 }
 assert.ok(engine.direction.y<-.999,'Direction smoothing prevented an aimed reversal');
 v.set(100000,0,0);for(let i=0;i<hz;i++)engine.update(dt,{...state,surface:0});
 engine.update(dt,state);assert.ok(engine.force.length()<=80,'Space acceleration leaked past the surface force cap');
}
function endurance(hz,surface){
 const engine=new GodmanFlightDynamics(),v=new T.Vector3();let fuel=100,seconds=0,lastPower=0;
 while(fuel>0&&seconds<60){
  engine.update(1/hz,{velocity:v,gravity,up,aim:up,move:zero,frameVelocity:zero,surface,fuel,thrust:true,braking:false});
  fuel-=engine.fuelUsed;seconds+=1/hz;
  assert.ok(fuel>=0&&Number.isFinite(fuel),'Fuel became negative or non-finite');lastPower=engine.force.length();
 }
 if(surface===1)assert.ok(lastPower<1,'An empty tank cut full thrust abruptly');
 engine.update(1/hz,{velocity:v,gravity,up,aim:up,move:zero,frameVelocity:zero,surface,fuel:0,thrust:true,braking:false});
 assert.equal(engine.force.lengthSq(),0,'Empty tank still supplied energy');
 return seconds;
}
for(const hz of [30,60,144]){
 const dt=1/hz,flight=new GodmanFlightDynamics({surfaceThrustScale:1.55,cruiseScale:10});
 const velocity=new T.Vector3(),position=new T.Vector3();
 const state={velocity,gravity,up,aim:up,move:zero,frameVelocity:zero,surface:1,fuel:100,thrust:true,braking:false};
 let previous=0;
 for(let i=0;i<hz*2;i++){
  flight.update(dt,state);
  const force=flight.force.length();
  assert.ok(force>=previous-1e-8&&force<=56*1.55+1e-8,'Full-scale surface thrust overshot its target');
  assert.ok((force-previous)/dt<400,'Full-scale thrust ramp spiked');
  flight.integrate(position,velocity,dt);
  previous=force;
 }
 assert.ok(previous>86&&position.y>110,'Full-scale thrust failed to lift faster');
 flight.rig.initialize(new T.Quaternion(),up);
 state.heading=new T.Vector3(0,0,-1);
 state.surface=0;
 velocity.set(0,4000,0);
 for(let i=0;i<hz;i++)flight.update(dt,state);
 state.surface=1;
 flight.update(dt,state);
 assert.ok(flight.force.length()<=124+1e-8,'Cruise thrust leaked through the full-scale surface cap');
}
const surfaceBurns=[30,60,144].map(hz=>endurance(hz,1)),spaceBurns=[30,60,144].map(hz=>endurance(hz,0));
for(const seconds of surfaceBurns)assert.ok(seconds>10&&seconds<10.5,'Surface fuel does not last about twice as long');
for(const seconds of spaceBurns)assert.ok(seconds>50&&seconds<50.5,'Deep-space fuel does not last about twice as long');
assert.ok(Math.max(...surfaceBurns)-Math.min(...surfaceBurns)<.04,'Endurance changed with frame rate');
const jump=new GodmanFlightDynamics();
assert.equal(jump.jumpHeight(0),1.2,'First stage is not a human-height jump');
for(let tier=2;tier<=16;tier++)assert.equal(jump.jumpHeight(tier/16),jump.jumpHeight((tier-1)/16)*2,'Jump stages do not double height');
assert.equal(jump.jumpStage(4.999/5),15,'Maximum jump unlocked before five seconds');
assert.equal(jump.jumpStage(1),16,'Five seconds did not unlock the final jump');
// Aimed jumps preserve upward view angles and horizontal heading, including
// on a rotated planetary surface, without launching down into the ground.
for(const localUp of [up,new T.Vector3(1,0,0),new T.Vector3(0,0,1)]){
 const forward=new T.Vector3(0,0,-1);if(Math.abs(forward.dot(localUp))>.9)forward.set(1,0,0);
 forward.addScaledVector(localUp,-forward.dot(localUp)).normalize();
 const look=forward.clone().add(localUp).normalize(),direction=new T.Vector3();
 jump.jumpDirection(look,localUp,direction);
 assert.ok(direction.dot(look)>.99999,'Upward jump ignored the crosshair');
 const velocity=direction.clone().multiplyScalar(jump.jumpVelocity(.5));
 assert.ok(velocity.dot(forward)>10,'Aimed jump still launched straight up');
 const low=forward.clone().addScaledVector(localUp,-.6).normalize();
 jump.jumpDirection(low,localUp,direction);
 assert.ok(direction.dot(forward)>.9&&direction.dot(localUp)>.15,'Groundward aim lost heading or launched through the surface');
 jump.jumpDirection(look,localUp,look);assert.ok(look.distanceTo(forward.clone().add(localUp).normalize())<1e-8,'In-place jump direction was corrupted');
}
// Small jumps retain a full leg-driven arc at normal/downward camera
// angles, instead of becoming a five-centimetre forward skim.
for(const hz of [30,60,144])for(const look of [new T.Vector3(0,0,-1),new T.Vector3(0,-.3,-1).normalize(),new T.Vector3(0,-.8,-1).normalize()]){
 for(const [charge,height] of [[0,1.2],[2/16,2.4],[3/16,4.8]]){
  const impulse=jump.jumpImpulse(look,up,charge,9.81,637100,new T.Vector3());
  const result=simulation(hz,{initial:impulse,time:3});
  assert.ok(Math.abs(result.peak-height)<.004,'Low camera aim removed lift from a small jump');
  assert.ok(impulse.dot(look.clone().projectOnPlane(up).normalize())>1,'Small jump lost its forward heading');
  if(charge===0)assert.ok(impulse.clone().projectOnPlane(up).length()<2.3,'A tap jump became an oversized forward lunge');
 }
}
const fullLook=new T.Vector3(.5,.8,-.3).normalize();
const fullImpulse=jump.jumpImpulse(fullLook,up,1,9.81,637100,new T.Vector3());
assert.ok(fullImpulse.clone().normalize().dot(fullLook)>.99999,'Small-jump correction changed a full aimed launch');
assert.ok(Math.abs(fullImpulse.length()-jump.jumpVelocity(1))<1e-7,'Full-charge launch speed changed');
// Exercise the game launch itself so it cannot regress to an upright-only
// impulse while the shared direction helper still passes its own tests.
const game=fs.readFileSync(require.resolve('../src/game.js'),'utf8');
const launchSource=game.slice(game.indexOf('  function doJump() {'),game.indexOf('  // M: the fastest speed',game.indexOf('  function doJump() {')));
const viewed=new T.Vector3(.6,.8,0),walking=new T.Vector3(0,0,1);
const actual={flightDynamics:new GodmanFlightDynamics(),charge:.5,pos:new T.Vector3(0,637100,0),groundPlanet:{g:9.81,r:637100,center:zero},up,groundMotion:walking.clone(),vel:new T.Vector3(),frameScratch:{flightAim:new T.Vector3()},camera:{getWorldDirection(out){return out.copy(viewed);}},grounded:true,fuel:100,PLAYER_FEET:.28,launchPressureLocal:new T.Vector3(),launchPressurePlanet:null,repulsorFrame:new T.Quaternion()};
actual.groundPlanet.mesh={quaternion:new T.Quaternion()};
vm.createContext(actual);vm.runInContext(launchSource+'\ndoJump();',actual);
assert.ok(actual.flightDynamics.launchImpulse.clone().normalize().dot(up)>.999,'Cinematic ignition is not vertical');
assert.equal(actual.vel.length(),0,'Pre-ignition arm drive moved the planted character');
assert.ok(actual.grounded&&actual.flightDynamics.launchQueued&&actual.groundMotion.lengthSq()===0,'Pre-ignition release did not retain ground contact');
actual.charge=0;actual.groundMotion.set(0,0,0);viewed.set(0,-.3,-1).normalize();actual.doJump();
assert.ok(actual.flightDynamics.launchImpulse.dot(up)>4.8,'Rocket tap lacks surface clearance');
assert.ok(Math.abs(actual.flightDynamics.launchImpulse.z)<1e-8,'Vertical launch retained an unintended forward kick');
for(const [radius,g,top] of [[637100,9.81,10000],[6991100,24.79,18000],[5823200,10.44,25000],[173700,1.62,0]]){
 const speed=jump.jumpVelocity(1,g,radius),mu=g*radius*radius;
 const energy=speed*speed/2-mu/radius,apex=-mu/energy-radius;
 assert.ok(apex>Math.max(top*1.4,10000),'Full charge cannot leave the planetary atmosphere');
 assert.ok(Math.abs(apex-jump.jumpHeight(1))<.001,'Jump energy does not match inverse-square gravity');
}
for(const look of [new T.Vector3(1,0,0),new T.Vector3(-1,0,0),new T.Vector3(0,0,-1),new T.Vector3(0,-1,0),up]){
 const r=simulation(120,{thrust:true,look});
 assert.ok(r.flight.force.clone().normalize().dot(look)>.9999,'Thrust force ignored the crosshair');
}
// Exercise the actual integrator on a full launch, with gravity changing
// continuously as the character climbs out of Earth's atmosphere.
const launch=new GodmanFlightDynamics(),planetRadius=637100,position=new T.Vector3(0,planetRadius,0),launchVelocity=new T.Vector3(0,launch.jumpVelocity(1),0);
for(let i=0;i<60*120;i++){
 const altitudeGravity=new T.Vector3(0,-9.81*(planetRadius/position.y)**2,0);
 launch.update(1/120,{velocity:launchVelocity,gravity:altitudeGravity,up,aim:up,move:zero,frameVelocity:zero,surface:1,fuel:0,thrust:false,braking:false});
 launch.integrate(position,launchVelocity,1/120);
}
assert.ok(position.y-planetRadius>15000,'Integrated full-charge jump did not clear the sky/atmosphere layer');
const fullScaleLaunch=new GodmanFlightDynamics({jumpStages:19,cruiseScale:10}),fullRadius=6371000;
assert.equal(fullScaleLaunch.jumpStage(1),19);
assert.equal(fullScaleLaunch.jumpHeight(0),launch.jumpHeight(0),'Full scale changed the first hop');
const fullPosition=new T.Vector3(0,fullRadius,0);
const fullVelocity=new T.Vector3(),step=1/120;
let fullFuel=100;
assert.ok(fullScaleLaunch.beginLaunch(1,up,up,9.81,fullRadius,fullFuel));
while(!fullScaleLaunch.prepareLaunch(step)){}
for(let i=0;i<60*120;i++){
 const gravity=new T.Vector3(0,-9.81*(fullRadius/fullPosition.y)**2,0);
 fullScaleLaunch.update(step,{velocity:fullVelocity,gravity,up,aim:up,move:zero,frameVelocity:zero,surface:1,fuel:fullFuel,thrust:false,braking:false});
 fullFuel-=fullScaleLaunch.fuelUsed;
 fullScaleLaunch.integrate(fullPosition,fullVelocity,step);
}
assert.ok(fullPosition.y-fullRadius>100000,'Full-scale launch failed to clear Earth’s atmosphere');
const coarse=simulation(30,{thrust:true,look:up}),fine=simulation(144,{thrust:true,look:up});
assert.ok(coarse.p.distanceTo(fine.p)<1,'Lift response diverged across frame rates');
console.log('PASS: ballistic gravity/apex, frame-rate convergence, camera-directed thrust, fall recovery, staged atmosphere-clearing jumps, fuel exhaustion, braking and deep-space cruise.');
