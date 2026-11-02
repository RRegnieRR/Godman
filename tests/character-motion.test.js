/* No browser/GPU required. Loads the actual GLB skeleton and first idle key,
 * then exercises exactly the controller used by both game and preview. */
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const T=global.THREE=require('../vendor/three.r128.min.js');
require('../src/runtime/character-motion.js');
require('../src/runtime/character-controller.js');
const file=fs.readFileSync(path.join(__dirname,'../assets/character/rigged-astronaut.glb'));
const jsonLength=file.readUInt32LE(12),gltf=JSON.parse(file.toString('utf8',20,20+jsonLength));
const binaryStart=20+jsonLength+8;
function values(index){
  const a=gltf.accessors[index],v=gltf.bufferViews[a.bufferView];
  const size={SCALAR:1,VEC2:2,VEC3:3,VEC4:4,MAT4:16}[a.type];
  assert.equal(a.componentType,5126);
  const result=[];
  for(let i=0;i<a.count;i++)for(let k=0;k<size;k++)result.push(file.readFloatLE(binaryStart+(v.byteOffset||0)+(a.byteOffset||0)+i*(v.byteStride||size*4)+k*4));
  return result;
}
function rig(){
  const nodes=gltf.nodes.map(n=>{const b=new T.Bone();b.name=n.name||'';if(n.translation)b.position.fromArray(n.translation);if(n.rotation)b.quaternion.fromArray(n.rotation);if(n.scale)b.scale.fromArray(n.scale);return b;});
  gltf.nodes.forEach((n,i)=>(n.children||[]).forEach(c=>nodes[i].add(nodes[c])));
  const model=new T.Group();gltf.scenes[0].nodes.forEach(i=>model.add(nodes[i]));model.updateMatrixWorld(true);
  const box=new T.Box3();
  gltf.nodes.forEach((n,i)=>{if(n.mesh===undefined)return;for(const p of gltf.meshes[n.mesh].primitives){const a=gltf.accessors[p.attributes.POSITION];box.union(new T.Box3(new T.Vector3().fromArray(a.min),new T.Vector3().fromArray(a.max)).applyMatrix4(nodes[i].matrixWorld));}});
  const fit=4.48/box.getSize(new T.Vector3()).y;model.scale.setScalar(fit);box.min.multiplyScalar(fit);box.max.multiplyScalar(fit);
  const center=box.getCenter(new T.Vector3());model.position.set(-center.x,-.62-box.min.y,-center.z);
  nodes.forEach(b=>b.userData.motionBindQuaternion=b.quaternion.clone());
  const idle=gltf.animations.find(a=>a.name==='idle');
  for(const c of idle.channels){const v=values(idle.samplers[c.sampler].output);const n=nodes[c.target.node];if(c.target.path==='rotation')n.quaternion.fromArray(v);if(c.target.path==='translation')n.position.fromArray(v);if(c.target.path==='scale')n.scale.fromArray(v);}
  const scene=new T.Scene(),player=new T.Group(),frame=new T.Group();player.scale.setScalar(.45);frame.rotation.y=Math.PI;scene.add(player);player.add(frame);frame.add(model);scene.updateMatrixWorld(true);
  const bones={};nodes.forEach(b=>bones[b.name]=b);
  return {controller:new global.GodmanCharacterMotion(frame,bones),player,frame,nodes};
}
const up=new T.Vector3(0,1,0),base=new T.Quaternion(),thrust=new T.Vector3(0,.3,-1).normalize(),velocity=new T.Vector3(0,0,-10);
function step(r,s,dt=1/60){r.controller.orient(dt,base,up,thrust,velocity,s.grounded,s.water,s.space);r.controller.update(dt,s);}
function feet(r){return r.controller.chains.filter(c=>c.type==='leg').map(c=>c.nodes[2].getWorldPosition(new T.Vector3()));}
const r=rig();assert.equal(r.controller.chains.length,4);
for(let i=0;i<120;i++)step(r,{grounded:true});
const planted=feet(r);
const plantedRotations=r.controller.chains.filter(c=>c.type==='leg').map(c=>c.nodes[2].getWorldQuaternion(new T.Quaternion()));
for(let i=0;i<180;i++)step(r,{grounded:true,charge:1});
feet(r).forEach((p,i)=>assert.ok(p.distanceTo(planted[i])<.055,`Crouch foot moved ${p.distanceTo(planted[i])}m`));
r.controller.chains.filter(c=>c.type==='leg').forEach((c,i)=>assert.ok(c.nodes[2].getWorldQuaternion(new T.Quaternion()).angleTo(plantedRotations[i])<.03,'Planted boot tipped with the torso'));
const states=[{grounded:true,speed:1.8},{grounded:true,speed:6.2},{grounded:false,airTime:.2},
  {grounded:false,space:0,airTime:2},{grounded:false,space:1,airTime:2},
  {grounded:false,powered:true,space:1,airTime:3},{grounded:false,brake:1,space:1,airTime:3},
  {grounded:true,landing:1},{grounded:false,water:true,airTime:3}];
let worstStep=0;
for(const s of states){
  for(let i=0;i<240;i++){
    const before=r.controller.chains.flatMap(c=>c.nodes.map(n=>n.quaternion.clone()));
    step(r,{...s,turn:Math.sin(i*.1)});
    const after=r.controller.chains.flatMap(c=>c.nodes.map(n=>n.quaternion));
    after.forEach((q,k)=>{assert.ok(q.toArray().every(Number.isFinite));assert.ok(Math.abs(q.length()-1)<1e-5);const change=q.angleTo(before[k]);worstStep=Math.max(worstStep,change);assert.ok(change<=(7.5+22.5*r.controller.move*(1-r.controller.air))/60+1e-6,'Joint exceeded state-specific tracking limit');});
    for(const c of r.controller.chains){
      const a=c.nodes[0].getWorldPosition(new T.Vector3()),b=c.nodes[1].getWorldPosition(new T.Vector3()),e=c.nodes[2].getWorldPosition(new T.Vector3());
      const len=a.distanceTo(b)+b.distanceTo(e);assert.ok(e.distanceTo(a)<=len+1e-6);
      // Check the solved knee remains on the chosen side of its bend plane.
      if(c.type==='leg'&&i>60){const line=e.clone().sub(a).normalize(),bend=b.clone().sub(a);bend.addScaledVector(line,-bend.dot(line));const pole=r.frame.localToWorld(c.pole.clone()).sub(a);pole.addScaledVector(line,-pole.dot(line));assert.ok(bend.dot(pole)>-1e-5,'Knee flipped behind its hinge plane');}
      if(c.type==='leg'&&i>60){
        // Position-only checks missed the visibly twisted knee. In this GLB
        // the anatomical hinge is local Z: no independent calf yaw or roll.
        const delta=c.rest[1].clone().invert().multiply(c.nodes[1].quaternion);
        assert.ok(c.neutralFoot.angleTo(c.nodes[2].quaternion)<.651,'Boot exceeded bind-relative ankle envelope');
        assert.ok(Math.hypot(delta.x,delta.y)<.005,'Calf twisted off the knee hinge');
        assert.ok(c.kneeSupport,'Missing deformation helper');
        const expected=c.supportRest.clone().multiply(delta.clone().slerp(new T.Quaternion(),.5));
        assert.ok(expected.normalize().angleTo(c.kneeSupport.quaternion.clone().normalize())<1e-5,'Skinned kneecap still follows an unrelated clip');
        c.toes.forEach(t=>assert.ok(t.bone.quaternion.clone().normalize().angleTo(t.q.clone().normalize())<1e-5,'Independent toe animation bent the boot'));
      }
    }
  }
}
assert.ok(worstStep<.501,`Abrupt joint discontinuity: ${worstStep} rad`);
// Gait semantics, not merely valid bones: arms oppose the contacting leg.
const gait=rig();
for(let i=0;i<180;i++)step(gait,{grounded:true,speed:6.2});
for(const phase of [0,.5]){
  gait.controller.phase=phase;gait.controller.update(0,{grounded:true,speed:6.2});
  const leftArm=gait.controller.chains.find(c=>c.type==='arm'&&c.side==='L');
  const rightArm=gait.controller.chains.find(c=>c.type==='arm'&&c.side==='R');
  assert.ok(phase===0?leftArm.goal.z<rightArm.goal.z:leftArm.goal.z>rightArm.goal.z,'Arm swing is not opposite the contacting leg');
}
const jump=rig();
for(let i=0;i<120;i++)step(jump,{grounded:true,charge:1});
for(let i=0;i<36;i++){
  step(jump,{grounded:false,space:0,airTime:i/60});
  for(const c of jump.controller.chains.filter(c=>c.type==='arm'))
    assert.ok(c.goal.y<c.points[0].y+.1,'Earth jump drove hands overhead');
}
function atRate(hz){const r=rig();for(let i=0;i<hz*3;i++)step(r,{grounded:false,powered:true,space:1,airTime:2,turn:.7},1/hz);return r.controller.chains.flatMap(c=>c.nodes.map(n=>n.quaternion.clone()));}
const low=atRate(30),high=atRate(144);low.forEach((q,i)=>assert.ok(q.angleTo(high[i])<.03,'Frame-rate-dependent pose'));

// Steering must accelerate and decelerate, not snap to a fixed flight pose.
const flight=rig().controller;
flight.power=1;
const right=new T.Vector3(1,0,0),left=new T.Vector3(-1,0,0);
for(let i=0;i<30;i++)flight.orient(1/60,base,up,right,velocity,false,false,1);
const beforeTurn=flight.angularVelocity.clone(),beforeAttitude=flight.attitude.clone();
flight.orient(1/60,base,up,left,velocity,false,false,1);
assert.ok(flight.angularVelocity.distanceTo(beforeTurn)<=7/60+1e-6,'Thrust reversal snapped angular velocity');
assert.ok(flight.attitude.angleTo(beforeAttitude)<=2.4/60+1e-6,'Body rotation exceeded steering speed limit');
assert.ok(flight.angularVelocity.length()<=2.4+1e-6);
flight.power=flight.brake=0;
const driftRate=flight.angularVelocity.length();
flight.orient(1/60,base,up,left,velocity,false,false,1);
assert.ok(flight.angularVelocity.length()>driftRate*.95,'Coasting stopped rotation instantly');
flight.flightLoad.set(1,0,0);flight.angularVelocity.set(0,0,1);
assert.notEqual(flight.nozzleShare('hand',1),flight.nozzleShare('hand',-1),'Steering did not redistribute hand exhaust');

// Check points on the actual skinned glove surfaces, not just wrist joints.
function numbers(index){
  const a=gltf.accessors[index],v=gltf.bufferViews[a.bufferView],size={VEC4:4,VEC3:3,SCALAR:1}[a.type];
  const bytes={5121:1,5123:2,5126:4}[a.componentType],out=[];
  for(let i=0;i<a.count;i++)for(let k=0;k<size;k++){
    const offset=binaryStart+(v.byteOffset||0)+(a.byteOffset||0)+i*(v.byteStride||size*bytes)+k*bytes;
    out.push(bytes===1?file.readUInt8(offset):bytes===2?file.readUInt16LE(offset):file.readFloatLE(offset));
  }return out;
}
const parentNodes={};gltf.nodes.forEach((n,i)=>(n.children||[]).forEach(c=>parentNodes[c]=i));
const skin=gltf.skins[0],inverseData=values(skin.inverseBindMatrices);
const inverses=skin.joints.map((_,i)=>new T.Matrix4().fromArray(inverseData,i*16));
function isHand(joint){let n=skin.joints[joint];while(n!==undefined){if(/^[LR]_Wrist/.test(gltf.nodes[n].name))return true;n=parentNodes[n];}return false;}
const handSamples=[];
for(const mesh of gltf.meshes)for(const p of mesh.primitives){
  const positions=numbers(p.attributes.POSITION),ids=numbers(p.attributes.JOINTS_0),weights=numbers(p.attributes.WEIGHTS_0);
  for(let i=0;i<positions.length/3;i+=7){let handWeight=0;for(let k=0;k<4;k++)if(isHand(ids[i*4+k]))handWeight+=weights[i*4+k];
    if(handWeight>.95)handSamples.push({p:new T.Vector3().fromArray(positions,i*3),ids:ids.slice(i*4,i*4+4),weights:weights.slice(i*4,i*4+4)});
  }
}
assert.ok(handSamples.length>50,'Glove geometry samples were not loaded');
const collisionRig=rig(),matrices=inverses.map(()=>new T.Matrix4()),point=new T.Vector3(),transformed=new T.Vector3();
let collisions=0;
for(let i=0;i<360;i++){
  step(collisionRig,{grounded:true,speed:6.2});if(i<120||i%3)continue;
  collisionRig.frame.updateWorldMatrix(true,true);
  skin.joints.forEach((node,j)=>matrices[j].multiplyMatrices(collisionRig.nodes[node].matrixWorld,inverses[j]));
  for(const sample of handSamples){point.set(0,0,0);for(let k=0;k<4;k++)point.addScaledVector(transformed.copy(sample.p).applyMatrix4(matrices[sample.ids[k]]),sample.weights[k]);
    collisionRig.frame.worldToLocal(point);
    if(point.y>1.2&&point.y<2.55&&point.x**2/.67**2+(point.z-.04)**2/.58**2<1)collisions++;
  }
}
assert.equal(collisions,0,'Skinned glove penetrated the torso/hip clearance envelope during running');
// Glove clearance must not turn an athletic bent-arm swing into a straight
// hanging arm. Measure actual elbow geometry across several complete strides.
const runningRig=rig();
for(let i=0;i<300;i++){
  step(runningRig,{grounded:true,speed:6.2});if(i<120)continue;
  for(const c of runningRig.controller.chains.filter(c=>c.type==='arm')){
    const p=c.nodes.map(n=>n.getWorldPosition(new T.Vector3()));
    const elbow=p[0].sub(p[1]).angleTo(p[2].sub(p[1]));
    assert.ok(elbow>.9&&elbow<2.2,'Running elbow lost its bent athletic carriage');
  }
}
const source=fs.readFileSync(path.join(__dirname,'../src/game.js'),'utf8');
// At equal air time, changing requested thrust must change limb targets.
function flightTarget(x){
  const r=rig(),force=new T.Vector3(x,.5,-.7).normalize();
  for(let i=0;i<90;i++){
    r.controller.orient(1/60,base,up,up,velocity,false,false,1);
    r.controller.update(1/60,{grounded:false,powered:true,throttle:1,space:1,airTime:3});
  }
  for(let i=0;i<12;i++){
    r.controller.orient(1/60,base,up,force,velocity,false,false,1);
    r.controller.update(1/60,{grounded:false,powered:true,throttle:1,space:1,airTime:3});
  }
  return r.controller.chains.find(c=>c.type==='arm'&&c.side==='L').goal.clone();
}
assert.ok(flightTarget(1).distanceTo(flightTarget(-1))>.02,'Flight hands ignored changing thrust direction');
assert.ok(!source.includes('poseJoint('));assert.ok(!source.includes('updateAuthoredRepulsorIK('));
console.log(`PASS: actual GLB, 4 IK chains; planted crouch; gait, launch, fall, coast, flight, brake, landing, swim; knee hinges AND skin helpers; boot/toe coherence; ${handSamples.length} skinned glove samples outside torso envelope; 30/144fps convergence. Max joint step ${worstStep.toFixed(3)} rad.`);
