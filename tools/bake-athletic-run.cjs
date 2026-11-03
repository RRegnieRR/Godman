/* Bake the original athletic reference onto the real astronaut once. Runtime
 * playback never reruns IK, skin clearance, or contact/root feedback. */
'use strict';
const fs=require('node:fs'),path=require('node:path');
const ROOT=path.resolve(__dirname,'..');
const T=global.THREE=require(path.join(ROOT,'vendor/three.r128.min.js'));
require(path.join(ROOT,'src/runtime/character-motion.js'));
global.window=global;require(path.join(ROOT,'src/data/run-motion.js'));
const Rig=global.GodmanCharacterMotion,source=global.GodmanRunMotion;
const clamp=T.MathUtils.clamp,smooth=(a,b,x)=>T.MathUtils.smoothstep(x,a,b);
const FACING=new T.Quaternion().setFromAxisAngle(new T.Vector3(0,1,0),Math.PI);
const file=fs.readFileSync(path.join(ROOT,'assets/character/rigged-astronaut.glb'));
const jsonLength=file.readUInt32LE(12),doc=JSON.parse(file.toString('utf8',20,20+jsonLength)),binary=28+jsonLength;
function numbers(index){
  const a=doc.accessors[index],v=doc.bufferViews[a.bufferView],size={SCALAR:1,VEC2:2,VEC3:3,VEC4:4,MAT4:16}[a.type];
  const bytes={5121:1,5123:2,5126:4}[a.componentType],out=[];
  for(let i=0;i<a.count;i++)for(let k=0;k<size;k++){
    const offset=binary+(v.byteOffset||0)+(a.byteOffset||0)+i*(v.byteStride||size*bytes)+k*bytes;
    out.push(bytes===1?file.readUInt8(offset):bytes===2?file.readUInt16LE(offset):file.readFloatLE(offset));
  }
  return out;
}
const nodes=doc.nodes.map(n=>{
  const b=new T.Bone();b.name=T.PropertyBinding.sanitizeNodeName(n.name||'');
  if(n.translation)b.position.fromArray(n.translation);if(n.rotation)b.quaternion.fromArray(n.rotation);if(n.scale)b.scale.fromArray(n.scale);
  b.userData.motionBindQuaternion=b.quaternion.clone();return b;
});
doc.nodes.forEach((n,i)=>(n.children||[]).forEach(c=>nodes[i].add(nodes[c])));
const model=new T.Group();doc.scenes[0].nodes.forEach(i=>model.add(nodes[i]));model.updateMatrixWorld(true);
const box=new T.Box3();
doc.nodes.forEach((n,i)=>{if(n.mesh===undefined)return;for(const p of doc.meshes[n.mesh].primitives){
  const a=doc.accessors[p.attributes.POSITION];box.union(new T.Box3(new T.Vector3().fromArray(a.min),new T.Vector3().fromArray(a.max)).applyMatrix4(nodes[i].matrixWorld));
}});
const fit=4.48/box.getSize(new T.Vector3()).y;model.scale.setScalar(fit);box.min.multiplyScalar(fit);box.max.multiplyScalar(fit);
const center=box.getCenter(new T.Vector3());model.position.set(-center.x,-.62-box.min.y,-center.z);
const idle=doc.animations.find(a=>a.name==='idle');
for(const c of idle.channels){const v=numbers(idle.samplers[c.sampler].output),n=nodes[c.target.node];if(c.target.path==='rotation')n.quaternion.fromArray(v);if(c.target.path==='translation')n.position.fromArray(v);if(c.target.path==='scale')n.scale.fromArray(v);}
const scene=new T.Scene(),player=new T.Group(),frame=new T.Group();player.scale.setScalar(.45);frame.quaternion.copy(FACING);scene.add(player);player.add(frame);frame.add(model);scene.updateMatrixWorld(true);
const bones={};nodes.forEach((b,i)=>{bones[b.name]=b;bones[doc.nodes[i].name]=b;});
const rig=new Rig(frame,bones),legs=rig.chains.filter(c=>c.type==='leg');
rig.move=rig.run=1;rig.air=rig.water=rig.power=rig.brake=0;rig.soleFloor=-.62;
for(const c of rig.chains){
  c.lengthA=c.points[0].distanceTo(c.points[1]);c.lengthB=c.points[1].distanceTo(c.points[2]);
  c.runTracking=1;c.runSoleClearance=undefined;c.soleSamples=[];
  for(const q of c.previous)q.rotateTowards=function(target){return this.copy(target);};
}
const initial=nodes.map(n=>({q:n.quaternion.clone(),p:n.position.clone(),s:n.scale.clone()}));
const named=doc.skins[0].joints.map(index=>({node:nodes[index],index}));
const torso=rig.groundTorso.concat(rig.headJoints).map(t=>{
  const name=t.bone.name,key=/Spine_1/.test(name)?'Spine':/Spine_2/.test(name)?'Spine1':/Spine_3/.test(name)?'Spine2':/^neck/i.test(name)?'Neck':'Head';
  const ancestors=[];let n=t.bone;while(n&&n!==frame){ancestors.push(n);n=n.parent;}
  const neutral=new T.Quaternion();for(let i=ancestors.length-1;i>=0;i--)neutral.multiply(ancestors[i].userData.motionBindQuaternion||ancestors[i].quaternion);
  return {bone:t.bone,key,neutral};
});
const skin=doc.skins[0],inverseData=numbers(skin.inverseBindMatrices),inverses=skin.joints.map((_,i)=>new T.Matrix4().fromArray(inverseData,i*16));
const parents={};doc.nodes.forEach((n,i)=>(n.children||[]).forEach(c=>parents[c]=i));
function surfaceGroup(joint){let n=skin.joints[joint];while(n!==undefined){const name=doc.nodes[n].name||'',foot=name.match(/^([LR])_Ankle/);if(foot)return foot[1];if(/^[LR]_Wrist/.test(name))return 'hand';n=parents[n];}return null;}
const surfaces={L:[],R:[],hand:[]};
for(const mesh of doc.meshes)for(const primitive of mesh.primitives){
  const p=numbers(primitive.attributes.POSITION),ids=numbers(primitive.attributes.JOINTS_0),w=numbers(primitive.attributes.WEIGHTS_0);
  for(let i=0;i<p.length/3;i++){
    const sums={L:0,R:0,hand:0};for(let k=0;k<4;k++){const group=surfaceGroup(ids[i*4+k]);if(group)sums[group]+=w[i*4+k];}
    for(const group of ['L','R','hand'])if(sums[group]>.95&&(group!=='hand'||i%7===0))surfaces[group].push({p:new T.Vector3().fromArray(p,i*3),ids:ids.slice(i*4,i*4+4),w:w.slice(i*4,i*4+4)});
  }
}
const matrices=inverses.map(()=>new T.Matrix4()),v=new T.Vector3(),tmp=new T.Vector3(),q=new T.Quaternion(),parentQ=new T.Quaternion(),worldQ=new T.Quaternion();
function updateSkin(){frame.updateWorldMatrix(true,true);skin.joints.forEach((n,j)=>matrices[j].multiplyMatrices(nodes[n].matrixWorld,inverses[j]));}
function skinPoint(sample,out){out.set(0,0,0);for(let k=0;k<4;k++)out.addScaledVector(tmp.copy(sample.p).applyMatrix4(matrices[sample.ids[k]]),sample.w[k]);return out;}
function soleHeights(){updateSkin();return legs.map(c=>{let low=Infinity;for(const sample of surfaces[c.side]){player.worldToLocal(skinPoint(sample,v));low=Math.min(low,v.y);}return low;});}
function handPenetrations(){updateSkin();let count=0;for(const sample of surfaces.hand){frame.worldToLocal(skinPoint(sample,v));if(v.y>1.2&&v.y<2.55&&v.x*v.x/(.67*.67)+(v.z-.04)**2/(.58*.58)<1)count++;}return count;}
const hip=legs[0].points[0].clone().add(legs[1].points[0]).multiplyScalar(.5),baseHip=hip.clone().applyQuaternion(FACING);
const floor=(legs[0].points[2].y+legs[1].points[2].y)*.5,reach=legs[0].lengthA+legs[0].lengthB;
function sampleSource(phase){
  const f=phase*(source.frames.length-1),i=Math.floor(f),a=source.frames[i],b=source.frames[Math.min(i+1,source.frames.length-1)],u=f-i;
  const clearanceBySide={L:T.MathUtils.lerp(a.footClearance.L,b.footClearance.L,u),R:T.MathUtils.lerp(a.footClearance.R,b.footClearance.R,u)};
  return {vector(key,offset=0){return new T.Vector3().fromArray(a[key],offset).lerp(new T.Vector3().fromArray(b[key],offset),u).normalize();},rotation(key){return new T.Quaternion().fromArray(a.torso[key]).slerp(new T.Quaternion().fromArray(b.torso[key]),u).normalize();},height:T.MathUtils.lerp(a.pelvisHeight,b.pelvisHeight,u),clearanceBySide,clearance:Math.min(clearanceBySide.L,clearanceBySide.R)};
}
function pose(phase,extraClearance=.025){
  nodes.forEach((n,i)=>{n.quaternion.copy(initial[i].q);n.position.copy(initial[i].p);n.scale.copy(initial[i].s);});
  const s=sampleSource(phase),body=s.rotation('Hips'),inverse=body.clone().invert();
  frame.quaternion.copy(FACING).multiply(body);v.copy(hip).applyQuaternion(frame.quaternion);
  frame.position.set(baseHip.x-v.x,floor+s.height*reach-v.y,baseHip.z-v.z);
  frame.updateWorldMatrix(true,true);frame.getWorldQuaternion(worldQ);
  for(const t of torso){
    const target=s.rotation(t.key).premultiply(inverse);q.copy(worldQ).multiply(target).multiply(t.neutral);
    t.bone.parent.getWorldQuaternion(parentQ).invert();t.bone.quaternion.copy(parentQ).multiply(q);t.bone.updateWorldMatrix(false,true);
  }
  for(const f of rig.runningFingers)f.bone.quaternion.copy(f.target);
  for(const c of rig.chains){
    const origin=frame.worldToLocal(c.nodes[0].getWorldPosition(new T.Vector3())),key=c.side+'_'+c.type;
    const upper=s.vector(key).applyQuaternion(inverse),lower=s.vector(key,3).applyQuaternion(inverse);
    c.pole.copy(origin).addScaledVector(upper,c.lengthA);c.goal.copy(c.pole).addScaledVector(lower,c.lengthB);
    let pitch=0;c.footPlant=1;
    if(c.type==='leg'){const forward=s.vector(c.side+'_footForward');pitch=clamp(Math.atan2(-forward.y,Math.hypot(forward.x,forward.z)),-.55,.65);}
    else{
      // Rotate the whole athletic arm, preserving its elbow angle. A broad
      // approach band has no entry gate at the front of the torso envelope.
      const z=(c.goal.z-.04)/.77,clearance=.14+.78*Math.sqrt(Math.max(0,1-z*z));
      if(Math.abs(z)<1.32&&c.sign*c.goal.x<clearance){
        v.copy(c.goal).sub(origin);const dx=c.sign*v.x,dy=v.y,radius=Math.hypot(dx,dy),target=clearance-c.sign*origin.x;
        const heightWeight=smooth(1,1.2,c.goal.y)*(1-smooth(2.55,2.8,c.goal.y));
        const angle=clamp(-Math.acos(clamp(target/Math.max(radius,.001),-1,1))-Math.atan2(dy,dx),0,.60)*(1-smooth(1,1.32,Math.abs(z)))*heightWeight;
        q.setFromAxisAngle(new T.Vector3(0,0,1),c.sign*angle);c.goal.copy(v.applyQuaternion(q)).add(origin);c.pole.sub(origin).applyQuaternion(q).add(origin);
      }
      // Uniform pressure-suit allowance is smooth and keeps fingers outside
      // the mesh after periodic filtering. It adds no new arm timing.
      q.setFromAxisAngle(new T.Vector3(0,0,1),c.sign*extraClearance);c.goal.sub(origin).applyQuaternion(q).add(origin);c.pole.sub(origin).applyQuaternion(q).add(origin);
      q.setFromAxisAngle(new T.Vector3(1,0,0),-.065);c.goal.sub(origin).applyQuaternion(q).add(origin);c.pole.sub(origin).applyQuaternion(q).add(origin);
    }
    rig.solve(c,1,pitch);
    if(c.type==='arm'){
      // The source contains limb directions, not palm aiming. Preserve a
      // straight athletic wrist rather than baking the old palm-aim branch.
      c.nodes[2].quaternion.copy(c.nodes[2].userData.motionBindQuaternion||c.rest[2]);
      for(const segment of c.segments)segment.bone.quaternion.copy(segment.rest);
      c.nodes[0].updateWorldMatrix(false,true);
    }
  }
  const lows=soleHeights(),contact=1-smooth(.015,.09,s.clearance);
  const correction=Math.max((-.62-Math.min(...lows))*contact,-.62-Math.min(...lows));
  frame.position.y+=correction;
  return {root:frame.position.toArray(),facing:frame.quaternion.toArray(),joints:named.flatMap(x=>x.node.quaternion.clone().normalize().toArray())};
}
function smoothFrames(frames,passes=8){
  const N=frames.length;
  for(let pass=0;pass<passes;pass++){
    const prior=frames.map(f=>({root:f.root.slice(),facing:f.facing.slice(),joints:f.joints.slice()}));
    for(let i=0;i<N;i++){
      const f=frames[i];f.root=[0,0,0];f.facing=[0,0,0,0];f.joints=new Array(named.length*4).fill(0);
      for(const [d,w] of [[-2,1],[-1,4],[0,6],[1,4],[2,1]]){
        const p=prior[(i+d+N)%N];for(let k=0;k<3;k++)f.root[k]+=p.root[k]*w/16;
        const facingSign=new T.Quaternion().fromArray(p.facing).dot(new T.Quaternion().fromArray(prior[i].facing))<0?-1:1;
        for(let k=0;k<4;k++)f.facing[k]+=p.facing[k]*w/16*facingSign;
        for(let j=0;j<named.length;j++){
          let dot=0;for(let k=0;k<4;k++)dot+=p.joints[j*4+k]*prior[i].joints[j*4+k];const sign=dot<0?-1:1;
          for(let k=0;k<4;k++)f.joints[j*4+k]+=p.joints[j*4+k]*w/16*sign;
        }
      }
      new T.Quaternion().fromArray(f.facing).normalize().toArray(f.facing);
      for(let j=0;j<named.length;j++)new T.Quaternion().fromArray(f.joints,j*4).normalize().toArray(f.joints,j*4);
    }
  }
}
function smoothRoot(frames,passes=312){
  // The source body's vertical channels contain linear keyframe corners.
  // Give the root a wider periodic filter without softening athletic limbs.
  const N=frames.length;
  for(let pass=0;pass<passes;pass++){
    const previous=frames.map(f=>f.root.slice());
    for(let i=0;i<N;i++)for(let k=0;k<3;k++)frames[i].root[k]=(previous[(i+N-2)%N][k]+4*previous[(i+N-1)%N][k]+6*previous[i][k]+4*previous[(i+1)%N][k]+previous[(i+2)%N][k])/16;
  }
}
function adaptSupport(frames){
  // The root is already final. Calibrate each boot offline to that smooth
  // body trajectory, preserving the source's separate support/flight timing.
  const sourcePoses=frames.map(f=>({root:f.root.slice(),facing:f.facing.slice(),joints:f.joints.slice()}));
  for(let i=0;i<frames.length;i++){
    const phase=i/frames.length,s=sampleSource(phase);applyClip(sourcePoses,phase);
    for(let side=0;side<legs.length;side++){
      const c=legs[side],weight=1-smooth(.015,.09,s.clearanceBySide[c.side]);
      if(weight<1e-5)continue;
      const initialGoal=frame.worldToLocal(c.nodes[2].getWorldPosition(new T.Vector3()));
      c.goal.copy(initialGoal);c.pole.copy(frame.worldToLocal(c.nodes[1].getWorldPosition(new T.Vector3())));
      const forward=s.vector(c.side+'_footForward'),pitch=clamp(Math.atan2(-forward.y,Math.hypot(forward.x,forward.z)),-.55,.65);
      for(let iteration=0;iteration<5;iteration++){
        const low=soleHeights()[side],correction=clamp((-.62-low)*weight,-.08,.08);
        const axis=new T.Vector3(0,1,0).applyQuaternion(frame.quaternion.clone().invert());
        const proposed=c.goal.clone().addScaledVector(axis,correction);
        v.copy(proposed).sub(initialGoal);if(v.length()>.08)proposed.copy(initialGoal).add(v.setLength(.08));
        c.goal.copy(proposed);rig.solve(c,1,pitch);
      }
    }
    frames[i].joints=named.flatMap(x=>x.node.quaternion.clone().normalize().toArray());
  }
  // Filter only the calibrated legs; root and upper-body athletic poses stay
  // untouched. Playback receives a periodic curve with no support gate.
  const indices=rig.chains.filter(c=>c.type==='leg').flatMap(c=>c.nodes).map(n=>named.findIndex(x=>x.node===n));
  for(let pass=0;pass<12;pass++){
    const previous=frames.map(f=>f.joints.slice()),N=frames.length;
    for(let i=0;i<N;i++)for(const j of indices){
      const offset=j*4,values=[0,0,0,0];
      for(const [d,w]of[[-2,1],[-1,4],[0,6],[1,4],[2,1]]){
        const p=previous[(i+d+N)%N];let dot=0;for(let k=0;k<4;k++)dot+=p[offset+k]*previous[i][offset+k];
        for(let k=0;k<4;k++)values[k]+=p[offset+k]*w/16*(dot<0?-1:1);
      }
      new T.Quaternion().fromArray(values).normalize().toArray(frames[i].joints,offset);
    }
  }
}
function cubic(a,b,c,d,u){return b+.5*u*(c-a+u*(2*a-5*b+4*c-d+u*(3*(b-c)+d-a)));}
function applyClip(frames,phase){
  const f=phase*frames.length,i=Math.floor(f),u=f-i,N=frames.length;
  const keys=[frames[(i+N-1)%N],frames[i%N],frames[(i+1)%N],frames[(i+2)%N]];
  const read=(key,k)=>cubic(...keys.map(x=>x[key][k]),u);
  for(let k=0;k<3;k++)frame.position.setComponent(k,read('root',k));
  const rotation=(key,offset,target)=>{
    const values=keys.map(x=>x[key].slice(offset,offset+4)),reference=values[1];
    for(const a of values)if(a.reduce((sum,n,k)=>sum+n*reference[k],0)<0)for(let k=0;k<4;k++)a[k]*=-1;
    target.set(...[0,1,2,3].map(k=>cubic(...values.map(a=>a[k]),u))).normalize();
  };
  rotation('facing',0,frame.quaternion);
  for(let j=0;j<named.length;j++)rotation('joints',j*4,named[j].node.quaternion);
  frame.updateWorldMatrix(true,true);
}
function bake(){
  const count=256;let frames,collisions=0,lift=0,extra=.025;
  for(let attempt=0;attempt<6;attempt++){
    frames=Array.from({length:count},(_,i)=>pose(i/count,extra));smoothFrames(frames);smoothRoot(frames);adaptSupport(frames);
    lift=0;collisions=0;
    for(let i=0;i<count*4;i++){applyClip(frames,i/(count*4));lift=Math.max(lift,-.62-Math.min(...soleHeights()));collisions+=handPenetrations();}
    console.error(JSON.stringify({attempt,extra,collisions,lift}));
    if(!collisions)break;extra+=.025;
  }
  if(collisions)throw Error('Baked gloves penetrate torso: '+collisions+' samples');
  lift+=.002;for(const f of frames)f.root[1]+=lift;
  const round=a=>a.map(n=>Number(n.toFixed(7)));
  const result={duration:.625,boneNames:named.map(x=>x.node.name),positions:named.flatMap(x=>initial[x.index].p.toArray()),scales:named.flatMap(x=>initial[x.index].s.toArray()),frames:frames.map(f=>({root:round(f.root),facing:round(f.facing),joints:round(f.joints)})),source:source.source+'; independently retargeted onto the bundled astronaut; periodic filtered local poses and offline boot-floor calibration.'};
  const output=path.join(ROOT,'src/data/athletic-run.js');fs.writeFileSync(output,'window.GodmanAthleticRun='+JSON.stringify(result)+';\n');
  let min=Infinity,max=-Infinity;for(let i=0;i<120;i++){applyClip(frames,i/120);const low=Math.min(...soleHeights());min=Math.min(min,low);max=Math.max(max,low);}
  console.log(JSON.stringify({output,bones:named.length,frames:count,handClearanceRadians:extra,constantSafetyLift:lift,soleHeightRange:[min,max],gloveCollisions:collisions}));
  return result;
}
if(require.main===module)bake();
module.exports={bake,applyClip,rig,frame,player,nodes,named,source,sampleSource,soleHeights,handPenetrations};
