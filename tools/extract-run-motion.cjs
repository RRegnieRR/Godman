// Extract direction-only locomotion. No source meshes/textures are copied.
const fs=require('node:fs'),T=require('../vendor/three.r128.min.js');
const file=fs.readFileSync(process.argv[2]),len=file.readUInt32LE(12);
const doc=JSON.parse(file.toString('utf8',20,20+len)),start=28+len;
function read(i){const a=doc.accessors[i],v=doc.bufferViews[a.bufferView],n={SCALAR:1,VEC3:3,VEC4:4}[a.type],out=[];if(a.componentType!==5126)throw Error('Expected float accessor');for(let j=0;j<a.count;j++)for(let k=0;k<n;k++)out.push(file.readFloatLE(start+(v.byteOffset||0)+(a.byteOffset||0)+j*(v.byteStride||n*4)+k*4));return out;}
const nodes=doc.nodes.map(n=>{const o=new T.Object3D();o.name=n.name||'';if(n.translation)o.position.fromArray(n.translation);if(n.rotation)o.quaternion.fromArray(n.rotation);if(n.scale)o.scale.fromArray(n.scale);return o;});
doc.nodes.forEach((n,i)=>(n.children||[]).forEach(j=>nodes[i].add(nodes[j])));
const scene=new T.Group();doc.scenes[doc.scene||0].nodes.forEach(i=>scene.add(nodes[i]));scene.updateMatrixWorld(true);
const find=n=>nodes.find(o=>o.name==='mixamorig:'+n);
const bindHipQ=find('Hips').getWorldQuaternion(new T.Quaternion());
const basis=bindHipQ.clone().invert();
const bindHipP=find('Hips').getWorldPosition(new T.Vector3());
const referenceLeg=find('LeftUpLeg').getWorldPosition(new T.Vector3()).distanceTo(find('LeftLeg').getWorldPosition(new T.Vector3()))+find('LeftLeg').getWorldPosition(new T.Vector3()).distanceTo(find('LeftFoot').getWorldPosition(new T.Vector3()));
const torsoNames=['Hips','Spine','Spine1','Spine2','Neck','Head'];
const bindTorso=Object.fromEntries(torsoNames.map(n=>[n,find(n).getWorldQuaternion(new T.Quaternion()).invert()]));
const footUpLocal={},footForwardLocal={};
for(const side of ['Left','Right']){
  const foot=find(side+'Foot'),forward=find(side+'Toe_End').getWorldPosition(new T.Vector3()).sub(find(side+'ToeBase').getWorldPosition(new T.Vector3())).normalize();
  const up=new T.Vector3(0,1,0).applyQuaternion(bindHipQ).projectOnPlane(forward).normalize();
  const inverse=foot.getWorldQuaternion(new T.Quaternion()).invert();
  footUpLocal[side]=up.applyQuaternion(inverse);
  footForwardLocal[side]=forward.applyQuaternion(inverse);
}
const clipName=process.argv[3]||'Run';
if(!['Run','Walk'].includes(clipName))throw Error('Use Run or Walk');
const clip=doc.animations.find(a=>a.name===clipName);
if(!clip)throw Error('Missing '+clipName+' clip');
const channels=clip.channels.map(c=>{const s=clip.samplers[c.sampler];return {node:nodes[c.target.node],path:c.target.path,t:read(s.input),v:read(s.output)};});
const duration=Math.max(...channels.map(c=>c.t[c.t.length-1]));
const defs={L_leg:['LeftUpLeg','LeftLeg','LeftFoot'],R_leg:['RightUpLeg','RightLeg','RightFoot'],L_arm:['LeftArm','LeftForeArm','LeftHand'],R_arm:['RightArm','RightForeArm','RightHand']};
const frames=[];
for(let f=0;f<=60;f++){
  const time=f/60*duration;
  for(const c of channels){let i=0;while(i<c.t.length-2&&c.t[i+1]<time)i++;const u=Math.max(0,Math.min(1,(time-c.t[i])/(c.t[i+1]-c.t[i]||1)));if(c.path==='rotation')c.node.quaternion.fromArray(c.v,i*4).slerp(new T.Quaternion().fromArray(c.v,(i+1)*4),u);else if(c.path==='translation')c.node.position.fromArray(c.v,i*3).lerp(new T.Vector3().fromArray(c.v,(i+1)*3),u);}
  scene.updateMatrixWorld(true);const frame={};
  for(const [name,list]of Object.entries(defs)){
    const p=list.map(n=>find(n).getWorldPosition(new T.Vector3()));
    const upper=p[1].clone().sub(p[0]).normalize().applyQuaternion(basis);
    const lower=p[2].clone().sub(p[1]).normalize().applyQuaternion(basis);
    frame[name]=[...upper.toArray(),...lower.toArray()].map(n=>Number(n.toFixed(6)));
  }
  for(const side of ['Left','Right']){
    const prefix=side==='Left'?'L':'R',foot=find(side+'Foot');
    const forward=footForwardLocal[side].clone().applyQuaternion(foot.getWorldQuaternion(new T.Quaternion())).applyQuaternion(basis);
    const up=footUpLocal[side].clone().applyQuaternion(foot.getWorldQuaternion(new T.Quaternion())).applyQuaternion(basis);
    frame[prefix+'_footForward']=forward.toArray().map(n=>Number(n.toFixed(6)));
    frame[prefix+'_footUp']=up.toArray().map(n=>Number(n.toFixed(6)));
  }
  frame.torso={};
  for(const name of torsoNames){
    const delta=basis.clone().multiply(find(name).getWorldQuaternion(new T.Quaternion())).multiply(bindTorso[name]).multiply(bindHipQ).normalize();
    frame.torso[name]=delta.toArray().map(n=>Number(n.toFixed(6)));
  }
  frame.pelvisOffset=find('Hips').getWorldPosition(new T.Vector3()).sub(bindHipP).applyQuaternion(basis).divideScalar(referenceLeg).toArray().map(n=>Number(n.toFixed(6)));
  frame.pelvisHeight=find('Hips').getWorldPosition(new T.Vector3()).applyQuaternion(basis).y/referenceLeg;
  frame.footClearance={L:find('LeftFoot').getWorldPosition(new T.Vector3()).applyQuaternion(basis).y/referenceLeg,R:find('RightFoot').getWorldPosition(new T.Vector3()).applyQuaternion(basis).y/referenceLeg};
  frames.push(frame);
}
// One floor across the complete clip preserves genuine run flight phases.
// Taking the lower ankle EACH frame would incorrectly pin a foot in midair.
const floor=Math.min(...frames.flatMap(f=>Object.values(f.footClearance)));
for(const frame of frames){
  frame.pelvisHeight=Number((frame.pelvisHeight-floor).toFixed(6));
  frame.footClearance.L=Number((frame.footClearance.L-floor).toFixed(6));
  frame.footClearance.R=Number((frame.footClearance.R-floor).toFixed(6));
}
const data={duration,frames,source:'Three.js examples/models/gltf/Soldier.glb, '+clipName+' clip; direction-only retarget data',coordinates:'Hips bind frame; +Y up, +Z forward. Unit limb/foot direction vectors; torso world deltas in the same frame; pelvisOffset is in source leg-length units.'};
// Output consumed by the build command, which installs it using apply_patch.
process.stdout.write('window.Godman'+clipName+'Motion='+JSON.stringify(data)+';\n');
