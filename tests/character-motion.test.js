/* No browser/GPU required. Loads the actual GLB skeleton and first idle key,
 * then exercises exactly the controller used by both game and preview. */
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const T=global.THREE=require('../vendor/three.r128.min.js');
global.window=global;
require('../src/data/run-motion.js');
require('../src/data/walk-motion.js');
require('../src/data/athletic-run.js');
require('../src/runtime/character-motion.js');
require('../src/runtime/running-gait.js');
require('../src/runtime/character-controller.js');
const WALK_SPEED=global.GodmanMotionSettings.walkSpeed,RUN_SPEED=global.GodmanMotionSettings.runSpeed;
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
// Representative sole vertices use the same real skin as the visual checks,
// while the lightweight CPU fixture keeps only bones (no renderer required).
const soleSkin=gltf.skins[0],soleInverseData=values(soleSkin.inverseBindMatrices);
const soleInverses=soleSkin.joints.map((_,i)=>new T.Matrix4().fromArray(soleInverseData,i*16));
const soleParents={};gltf.nodes.forEach((n,i)=>(n.children||[]).forEach(c=>soleParents[c]=i));
function footSide(joint){let n=soleSkin.joints[joint];while(n!==undefined){const m=(gltf.nodes[n].name||'').match(/^([LR])_Ankle/);if(m)return m[1];n=soleParents[n];}return null;}
const soleCandidates={L:[],R:[]};
for(const mesh of gltf.meshes)for(const primitive of mesh.primitives){
  const positions=numbers(primitive.attributes.POSITION),ids=numbers(primitive.attributes.JOINTS_0),weights=numbers(primitive.attributes.WEIGHTS_0);
  for(let i=0;i<positions.length/3;i+=3){
    const total={L:0,R:0};for(let k=0;k<4;k++){const side=footSide(ids[i*4+k]);if(side)total[side]+=weights[i*4+k];}
    for(const side of ['L','R'])if(total[side]>.95)soleCandidates[side].push({p:new T.Vector3().fromArray(positions,i*3),ids:ids.slice(i*4,i*4+4),weights:weights.slice(i*4,i*4+4)});
  }
}
function rig(){
  const nodes=gltf.nodes.map(n=>{const b=new T.Bone();b.name=T.PropertyBinding.sanitizeNodeName(n.name||'');if(n.translation)b.position.fromArray(n.translation);if(n.rotation)b.quaternion.fromArray(n.rotation);if(n.scale)b.scale.fromArray(n.scale);return b;});
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
  const bones={};nodes.forEach((b,i)=>{bones[b.name]=b;bones[gltf.nodes[i].name]=b;});
  const controller=new global.GodmanCharacterMotion(frame,bones);
  const matrices=soleInverses.map((inverse,j)=>new T.Matrix4().multiplyMatrices(nodes[soleSkin.joints[j]].matrixWorld,inverse));
  for(const c of controller.chains.filter(c=>c.type==='leg')){
    const points=soleCandidates[c.side].map(sample=>{const p=new T.Vector3();for(let k=0;k<4;k++)p.addScaledVector(sample.p.clone().applyMatrix4(matrices[sample.ids[k]]),sample.weights[k]);return p;});
    const low=Math.min(...points.map(p=>p.y)),surface=points.filter(p=>p.y<low+.012);
    c.soleSamples=Array.from({length:Math.min(32,surface.length)},(_,i)=>c.nodes[2].worldToLocal(surface[Math.floor(i*surface.length/Math.min(32,surface.length))].clone()));
  }
  return {controller,player,frame,nodes};
}
const up=new T.Vector3(0,1,0),base=new T.Quaternion(),thrust=new T.Vector3(0,.3,-1).normalize(),velocity=new T.Vector3(0,0,-10);
function step(r,s,dt=1/60){r.controller.orient(dt,base,up,thrust,velocity,s.grounded,s.water,s.space);r.controller.update(dt,s);}
function feet(r){return r.controller.chains.filter(c=>c.type==='leg').map(c=>c.nodes[2].getWorldPosition(new T.Vector3()));}
const r=rig();assert.equal(r.controller.chains.length,4);
assert.equal(r.controller.runningFingers.length,30,'Runtime GLTF finger names were not bound');
assert.equal(r.controller.groundTorso.length,3,'Runtime GLTF spine names were not bound');
assert.equal(r.controller.chains.reduce((sum,c)=>sum+c.segments.length,0),20,'Runtime GLTF sleeve helper names were not bound');
assert.ok(GodmanWalkMotion.frames.filter(f=>Math.min(f.footClearance.L,f.footClearance.R)>.03).length<=2,'Walking reference unexpectedly has a running flight phase');
for(let i=0;i<120;i++)step(r,{grounded:true});
const planted=feet(r);
const plantedRotations=r.controller.chains.filter(c=>c.type==='leg').map(c=>c.nodes[2].getWorldQuaternion(new T.Quaternion()));
for(let i=0;i<180;i++)step(r,{grounded:true,charge:1});
feet(r).forEach((p,i)=>assert.ok(p.distanceTo(planted[i])<.055,`Crouch foot moved ${p.distanceTo(planted[i])}m`));
r.controller.chains.filter(c=>c.type==='leg').forEach((c,i)=>assert.ok(c.nodes[2].getWorldQuaternion(new T.Quaternion()).angleTo(plantedRotations[i])<.03,'Planted boot tipped with the torso'));
const states=[{grounded:true,speed:WALK_SPEED},{grounded:true,speed:RUN_SPEED},{grounded:false,airTime:.2},
  {grounded:false,space:0,airTime:2},{grounded:false,space:1,airTime:2},
  {grounded:false,powered:true,space:1,airTime:3},{grounded:false,brake:1,space:1,airTime:3},
  {grounded:true,landing:1},{grounded:false,water:true,airTime:3}];
let worstStep=0;
for(const s of states){
  for(let i=0;i<240;i++){
    const before=r.controller.chains.flatMap(c=>c.nodes.map(n=>n.quaternion.clone()));
    const previousGroundResponse=r.controller.move*(1-r.controller.air);
    step(r,{...s,turn:Math.sin(i*.1)});
    const after=r.controller.chains.flatMap(c=>c.nodes.map(n=>n.quaternion));
    // Takeoff blends across substeps; its first substep still has more ground
    // response than the final state. Bound the whole frame by both endpoints.
    const groundResponse=Math.max(previousGroundResponse,r.controller.move*(1-r.controller.air));
    after.forEach((q,k)=>{assert.ok(q.toArray().every(Number.isFinite));assert.ok(Math.abs(q.length()-1)<1e-5);const change=q.angleTo(before[k]);worstStep=Math.max(worstStep,change);assert.ok(change<=(7.5+22.5*groundResponse)/60+1e-6,'Joint exceeded state-specific tracking limit');});
    for(const c of r.controller.chains){
      assert.ok([...c.filtered.toArray(),...c.targetVelocity.toArray(),...c.filteredPole.toArray()].every(Number.isFinite),'Movement transition produced non-finite endpoint state');
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
      if(c.type==='arm'&&i>60){
        const elbow=c.rest[1].clone().invert().multiply(c.nodes[1].quaternion);
        assert.ok(Math.hypot(elbow.x,elbow.z)<.005,'Forearm pronation twisted the elbow off its local-Y hinge');
        let twist=2*Math.atan2(c.nodes[2].quaternion.x,c.nodes[2].quaternion.w);
        twist=T.MathUtils.euclideanModulo(twist+Math.PI,2*Math.PI)-Math.PI;
        for(const helper of c.segments){
          const expected=helper.rest.clone();
          if(helper.forearm&&helper.index>=2&&helper.index<=4)expected.multiply(new T.Quaternion().setFromAxisAngle(new T.Vector3(1,0,0),twist/3));
          assert.ok(expected.angleTo(helper.bone.quaternion)<1e-5,'Sleeve helper retained an unrelated idle deformation');
          assert.ok(helper.bone.position.distanceTo(helper.position)<1e-6,'Sleeve helper translation drifted');
          assert.ok(helper.bone.scale.distanceTo(helper.scale)<1e-6,'Sleeve helper scale drifted');
        }
      }
    }
  }
}
assert.ok(worstStep<.501,`Abrupt joint discontinuity: ${worstStep} rad`);
// Gait semantics, not merely valid bones: arms oppose the contacting leg.
const gait=rig();
for(let i=0;i<180;i++)step(gait,{grounded:true,speed:RUN_SPEED});
for(const phase of [0,.5]){
  gait.controller.phase=phase;gait.controller.update(0,{grounded:true,speed:RUN_SPEED});
  const leftArm=gait.controller.chains.find(c=>c.type==='arm'&&c.side==='L');
  const rightArm=gait.controller.chains.find(c=>c.type==='arm'&&c.side==='R');
  // The spine/shoulders now move. World target Z confounds shoulder yaw with
  // arm swing, so compare each wrist relative to its actual moving shoulder.
  const leftSwing=leftArm.goal.z-leftArm.origin.z,rightSwing=rightArm.goal.z-rightArm.origin.z;
  assert.ok(phase===0?leftSwing<rightSwing:leftSwing>rightSwing,'Arm swing is not opposite the contacting leg relative to its shoulder');
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
for(const state of [{grounded:true,speed:WALK_SPEED},{grounded:true,speed:RUN_SPEED},{grounded:false,water:true,airTime:3}]){
  const snapshots=[30,144].map(hz=>{const r=rig();for(let i=0;i<hz*4;i++)step(r,state,1/hz);return r.controller.chains.flatMap(c=>c.nodes.map(n=>n.quaternion.clone()));});
  snapshots[0].forEach((q,i)=>assert.ok(q.angleTo(snapshots[1][i])<.035,'Locomotion/swimming pose depends on rendering rate'));
}

const approach=rig();
for(let i=0;i<60;i++)step(approach,{grounded:false,airTime:1,verticalSpeed:-8,height:4});
assert.ok(approach.controller.ready<.01,'Braced for landing too early');
for(let i=0;i<20;i++)step(approach,{grounded:false,airTime:1.3,verticalSpeed:-8,height:.5});
assert.ok(approach.controller.ready>.8,'Did not prepare for an imminent landing');
approach.controller.reset();assert.equal(approach.controller.ready,0,'Landing preparation survived reset');

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
  step(collisionRig,{grounded:true,speed:RUN_SPEED});if(i<120)continue;
  collisionRig.frame.updateWorldMatrix(true,true);
  skin.joints.forEach((node,j)=>matrices[j].multiplyMatrices(collisionRig.nodes[node].matrixWorld,inverses[j]));
  for(const sample of handSamples){point.set(0,0,0);for(let k=0;k<4;k++)point.addScaledVector(transformed.copy(sample.p).applyMatrix4(matrices[sample.ids[k]]),sample.weights[k]);
    collisionRig.frame.worldToLocal(point);
    if(point.y>1.2&&point.y<2.55&&point.x**2/.67**2+(point.z-.04)**2/.58**2<1)collisions++;
  }
}
assert.equal(collisions,0,'Skinned glove penetrated the torso/hip clearance envelope during running');
// Inspect the actual skinned boots, not ankle joint height. A posed ankle can
// be well above the floor while the sole correctly touches it (and vice versa).
const bootSurface=Object.values(soleCandidates).flat();
assert.ok(bootSurface.length>1000,'Actual boot surface samples were not loaded');
function lowestBoot(r,side){
  r.frame.updateWorldMatrix(true,true);
  skin.joints.forEach((node,j)=>matrices[j].multiplyMatrices(r.nodes[node].matrixWorld,inverses[j]));
  let low=Infinity;
  for(const sample of side?soleCandidates[side]:bootSurface){
    point.set(0,0,0);
    for(let k=0;k<4;k++)point.addScaledVector(transformed.copy(sample.p).applyMatrix4(matrices[sample.ids[k]]),sample.weights[k]);
    low=Math.min(low,point.y);
  }
  return low;
}
const bootRanges={},floor=-.62*.45;
let sourceStanceContacts=0;
for(const speed of [WALK_SPEED,RUN_SPEED]){
  const r=rig(),heights=[];
  for(let i=0;i<360;i++){
    step(r,{grounded:true,speed});if(i<=120||i%3!==0)continue;
    heights.push(lowestBoot(r));
    if(speed===RUN_SPEED){
      const f=r.controller.phase*(GodmanRunMotion.frames.length-1),k=Math.floor(f),u=f-k;
      const a=GodmanRunMotion.frames[k],b=GodmanRunMotion.frames[Math.min(k+1,GodmanRunMotion.frames.length-1)];
      for(const side of ['L','R'])if(T.MathUtils.lerp(a.footClearance[side],b.footClearance[side],u)<=.015){
        sourceStanceContacts++;
        assert.ok(Math.abs(lowestBoot(r,side)-floor)<.03,`${side} support boot lost the athletic reference's ground contact`);
      }
    }
  }
  bootRanges[speed]={low:Math.min(...heights),high:Math.max(...heights)};
}
assert.ok(sourceStanceContacts>=20,'Source-aligned running stance contacts were not exercised');
assert.ok(bootRanges[WALK_SPEED].low>floor-.03&&bootRanges[WALK_SPEED].high<floor+.03,'Walk lost continuous sole contact by more than 3 cm');
assert.ok(bootRanges[RUN_SPEED].high>floor+.06,'Run lost its airborne stride phase');
assert.ok(bootRanges[RUN_SPEED].low>floor-.03,'Running boot penetrated the floor by more than 3 cm');
assert.ok(bootRanges[RUN_SPEED].low<floor+.03,'Running boots never reach ground contact');

// The athletic body's bounce reaches about 19.6 m/s². A finite difference
// expressed as physical acceleration catches contact jolts at every rate,
// without replacing the reference bounce with the flatter procedural run.
for(const hz of [60,120,240]){
  const r=rig();let previousY,previousVelocity,maxChange=0;
  for(let i=0;i<hz*5;i++){
    step(r,{grounded:true,speed:RUN_SPEED},1/hz);
    const y=r.frame.getWorldPosition(new T.Vector3()).y;
    const velocity=previousY===undefined?undefined:(y-previousY)*hz;
    if(i>=hz*2&&previousVelocity!==undefined)maxChange=Math.max(maxChange,Math.abs(velocity-previousVelocity));
    previousY=y;previousVelocity=velocity;
  }
  const acceleration=maxChange*hz;
  assert.ok(acceleration<20,`Run body jolted at ${hz} Hz (${acceleration.toFixed(2)} m/s²)`);
}
// Inspect final visible rotations, after all animation processing. A capped
// angular speed can still reverse suddenly. Compare actual
// angular-velocity vectors at two rates: a hidden discontinuity grows as the
// sampling interval shrinks, while a smooth turn has a converging acceleration.
const runJointAcceleration={};
for(const hz of [120,240]){
  const r=rig(),joints=r.controller.chains.flatMap(c=>c.nodes.map((bone,i)=>({bone,type:c.type,name:c.side+' '+(c.type==='leg'?['thigh','knee','ankle']:['shoulder','elbow','wrist'])[i]})));
  const previous=joints.map(j=>j.bone.quaternion.clone().normalize());
  const previousVelocity=joints.map(()=>null),peaks=joints.map(()=>0);
  for(let i=0;i<hz*5;i++){
    step(r,{grounded:true,speed:RUN_SPEED},1/hz);
    joints.forEach((joint,j)=>{
      const current=joint.bone.quaternion.clone().normalize();
      const delta=current.clone().multiply(previous[j].clone().invert()).normalize();
      if(delta.w<0)delta.set(-delta.x,-delta.y,-delta.z,-delta.w);
      const sin=Math.hypot(delta.x,delta.y,delta.z);
      const velocity=new T.Vector3(delta.x,delta.y,delta.z).multiplyScalar(2*Math.atan2(sin,delta.w)*hz/Math.max(sin,1e-10));
      if(i>=hz*2&&previousVelocity[j])peaks[j]=Math.max(peaks[j],velocity.distanceTo(previousVelocity[j])*hz);
      previous[j].copy(current);previousVelocity[j]=velocity;
    });
  }
  joints.forEach((joint,j)=>assert.ok(peaks[j]<(joint.type==='leg'?1600:1200),`${joint.name} running rotation jolted at ${hz} Hz (${peaks[j].toFixed(0)} rad/s²)`));
  runJointAcceleration[hz]=peaks;
}
runJointAcceleration[240].forEach((peak,j)=>assert.ok(peak<Math.max(1,runJointAcceleration[120][j]*1.6),`Running joint ${j} acceleration grows with finer sampling`));

// The production idle mixer runs before the body controller. Later idle keys
// used to rotate/translate the pelvis and clavicles behind the solver's back;
// a fixture frozen on idle key zero could not reveal that ownership conflict.
const clean=rig(),polluted=rig(),pollution=new T.Quaternion().setFromAxisAngle(new T.Vector3(0,1,0),.25);
assert.equal(polluted.controller.bodyAnchors.length,5,'Root/Center/Hip/clavicle ownership is incomplete');
for(let i=0;i<180;i++){
  for(const a of polluted.controller.bodyAnchors){a.bone.quaternion.multiply(pollution);a.bone.position.x+=.3;a.bone.scale.multiplyScalar(1.02);}
  for(const t of polluted.controller.torso){t.bone.position.z+=.1;t.bone.scale.multiplyScalar(1.01);}
  for(const c of polluted.controller.chains)for(const helper of c.segments){helper.bone.quaternion.multiply(pollution);helper.bone.position.y+=.2;}
  const state={grounded:true,speed:i<60?WALK_SPEED:RUN_SPEED};step(clean,state);step(polluted,state);
  clean.frame.updateWorldMatrix(true,true);polluted.frame.updateWorldMatrix(true,true);
  for(let c=0;c<clean.controller.chains.length;c++)for(let j=0;j<3;j++){
    const expected=clean.controller.chains[c].nodes[j],actual=polluted.controller.chains[c].nodes[j];
    assert.ok(expected.getWorldPosition(new T.Vector3()).distanceTo(actual.getWorldPosition(new T.Vector3()))<1e-7,'Idle mixer polluted the controller-owned body pose');
    assert.ok(expected.getWorldQuaternion(new T.Quaternion()).normalize().angleTo(actual.getWorldQuaternion(new T.Quaternion()).normalize())<1e-6,'Idle mixer retained a competing joint rotation');
  }
}
// Preserve the athletic reference: a strong shoulder pump, variable elbow
// flexion, deep heel recovery and forward torso lean. A smooth but shallow
// sinusoidal mannequin run must not pass by satisfying counter-swing alone.
const runningRig=rig();
const runRanges={L:{arm:[],thigh:[],knee:[],elbow:[]},R:{arm:[],thigh:[],knee:[],elbow:[]}};
const sourceErrors={};
const canonicalFacing=new T.Quaternion().setFromAxisAngle(new T.Vector3(0,1,0),Math.PI);
let torsoError=0,torsoSamples=0;
for(let i=0;i<300;i++){
  step(runningRig,{grounded:true,speed:RUN_SPEED});if(i<120)continue;
  const f=runningRig.controller.phase*(GodmanRunMotion.frames.length-1),k=Math.floor(f),u=f-k;
  const sourceA=GodmanRunMotion.frames[k],sourceB=GodmanRunMotion.frames[Math.min(k+1,GodmanRunMotion.frames.length-1)];
  for(const c of runningRig.controller.chains){
    const p=c.nodes.map(n=>n.getWorldPosition(new T.Vector3()));
    const angle=p[0].clone().sub(p[1]).angleTo(p[2].clone().sub(p[1]));
    const canonical=p.map(point=>runningRig.player.worldToLocal(point.clone()).applyQuaternion(canonicalFacing));
    const upper=canonical[1].clone().sub(canonical[0]).normalize(),lower=canonical[2].clone().sub(canonical[1]).normalize();
    const ranges=runRanges[c.side];
    if(c.type==='arm'){
      assert.ok(angle>.9&&angle<2.2,'Running elbow lost its bent athletic carriage');
      ranges.arm.push(upper.z);ranges.elbow.push(Math.PI-angle);
    }else{
      ranges.thigh.push(upper.z);ranges.knee.push(Math.PI-angle);
    }
    const key=c.side+'_'+c.type,a=sourceA[key],b=sourceB[key];
    const expectedUpper=new T.Vector3().fromArray(a).lerp(new T.Vector3().fromArray(b),u).normalize();
    const expectedLower=new T.Vector3().fromArray(a,3).lerp(new T.Vector3().fromArray(b,3),u).normalize();
    const errors=sourceErrors[key]||(sourceErrors[key]={upper:0,lower:0,max:0,count:0});
    const upperError=upper.angleTo(expectedUpper),lowerError=lower.angleTo(expectedLower);
    errors.upper+=upperError;errors.lower+=lowerError;errors.max=Math.max(errors.max,upperError,lowerError);errors.count++;
  }
  const chest=runningRig.controller.torso.find(t=>t.source==='Spine2');
  const actual=canonicalFacing.clone().multiply(runningRig.player.getWorldQuaternion(new T.Quaternion()).invert()).multiply(chest.bone.getWorldQuaternion(new T.Quaternion())).multiply(chest.inFrame.clone().invert()).normalize();
  const expected=new T.Quaternion().fromArray(sourceA.torso.Spine2).slerp(new T.Quaternion().fromArray(sourceB.torso.Spine2),u).normalize();
  torsoError+=actual.angleTo(expected);torsoSamples++;
}
for(const ranges of Object.values(runRanges)){
  assert.ok(Math.max(...ranges.arm)-Math.min(...ranges.arm)>.80,'Running arm swing lost the athletic shoulder pump');
  assert.ok(Math.max(...ranges.elbow)-Math.min(...ranges.elbow)>.30,'Running elbows became fixed hinges');
  assert.ok(Math.max(...ranges.knee)>1.8&&Math.max(...ranges.knee)-Math.min(...ranges.knee)>1.2,'Running knee lost deep heel recovery');
  const armMean=ranges.arm.reduce((a,b)=>a+b)/ranges.arm.length,thighMean=ranges.thigh.reduce((a,b)=>a+b)/ranges.thigh.length;
  let covariance=0,armVariance=0,thighVariance=0;
  for(let i=0;i<ranges.arm.length;i++){
    const arm=ranges.arm[i]-armMean,thigh=ranges.thigh[i]-thighMean;
    covariance+=arm*thigh;armVariance+=arm*arm;thighVariance+=thigh*thigh;
  }
  assert.ok(covariance/Math.sqrt(armVariance*thighVariance)<-.5,'Running arms do not counter the same-side thighs');
}
let armUpperError=0,armLowerError=0,armSamples=0;
for(const [key,errors]of Object.entries(sourceErrors)){
  const arm=key.endsWith('_arm');
  assert.ok(errors.upper/errors.count<(arm?.30:.22)&&errors.lower/errors.count<(arm?.30:.25),`${key} lost the original athletic timing or swing`);
  assert.ok(errors.max<.65,`${key} grossly distorted the athletic reference`);
  if(arm){armUpperError+=errors.upper;armLowerError+=errors.lower;armSamples+=errors.count;}
}
// The original reference check averaged both arms: the pressure suit needs
// more glove clearance on its left side, without changing the shoulder pump.
assert.ok(armUpperError/armSamples<.18&&armLowerError/armSamples<.18,'Run lost the original athletic shoulder/elbow timing');
assert.ok(torsoError/torsoSamples<.12,'Run lost the athletic forward torso lean');
// A complete settled stride must return to the same pose and height. Derive
// the period from the running phase so this check does not prescribe cadence.
const loopingRun=rig();
for(let i=0;i<480;i++)step(loopingRun,{grounded:true,speed:RUN_SPEED},1/120);
const initialPhase=loopingRun.controller.phase;
const initialJoints=loopingRun.controller.chains.flatMap(c=>c.nodes.map(n=>n.quaternion.clone()));
const initialRoot=loopingRun.frame.position.clone();
step(loopingRun,{grounded:true,speed:RUN_SPEED},1/120);
const cadence=((loopingRun.controller.phase-initialPhase+1)%1)*120;
assert.ok(cadence>1&&cadence<2.5,'Run cadence is outside a usable stride range');
let remaining=1/cadence-1/120;
while(remaining>1e-8){const h=Math.min(1/120,remaining);step(loopingRun,{grounded:true,speed:RUN_SPEED},h);remaining-=h;}
const loopedJoints=loopingRun.controller.chains.flatMap(c=>c.nodes.map(n=>n.quaternion));
loopedJoints.forEach((q,i)=>assert.ok(q.angleTo(initialJoints[i])<.03,'Running stride does not loop back to the same pose'));
assert.ok(loopingRun.frame.position.distanceTo(initialRoot)<.01,'Running stride changes body height from one loop to the next');
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
console.log(`PASS: actual sanitized GLB; 30 finger, 3 spine, 20 sleeve helper bindings; knee-Z/elbow-Y hinges and deformation helpers; planted crouch, authored walk and suit running with real flight, jump/landing approach, coast, flight, brake, swimming; ${handSamples.length} glove and ${bootSurface.length} boot surface samples; 30/144fps convergence. Max joint step ${worstStep.toFixed(3)} rad.`);
