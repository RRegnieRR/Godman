/* Playback of the athletic run retargeted offline onto this suit. No live
 * endpoint solver, contact correction, or frame-history filter owns the run. */
(function(g){
  'use strict';
  const T=g.THREE;
  const cubic=(a,b,c,d,u)=>b+.5*u*(c-a+u*(2*a-5*b+4*c-d+u*(3*(b-c)+d-a)));
  const dot=(a,b,o)=>a[o]*b[o]+a[o+1]*b[o+1]+a[o+2]*b[o+2]+a[o+3]*b[o+3];
  class AthleticRun{
    constructor(frame,chains){
      this.frame=frame;this.chains=chains;this.clip=g.GodmanAthleticRun;
      if(!this.clip)throw new Error('Athletic run clip is missing');
      this.cadence=1/this.clip.duration;
      const byName=new Map();frame.traverse(b=>byName.set(b.name,b));
      this.bones=this.clip.boneNames.map(name=>{
        const bone=byName.get(name);if(!bone)throw new Error('Athletic run bone missing: '+name);return bone;
      });
      this.root=new T.Vector3();this.facing=new T.Quaternion();
      this.q=new T.Quaternion();this.identity=new T.Quaternion();this.v=new T.Vector3();
      this.indices=[0,0,0,0];this.u=0;
    }
    sampleQuaternion(key,offset,out){
      const f=this.clip.frames,ids=this.indices;
      const a=f[ids[0]][key],b=f[ids[1]][key],c=f[ids[2]][key],d=f[ids[3]][key];
      const sa=dot(a,b,offset)<0?-1:1,sc=dot(c,b,offset)<0?-1:1,sd=dot(d,b,offset)<0?-1:1;
      out.set(cubic(sa*a[offset],b[offset],sc*c[offset],sd*d[offset],this.u),
        cubic(sa*a[offset+1],b[offset+1],sc*c[offset+1],sd*d[offset+1],this.u),
        cubic(sa*a[offset+2],b[offset+2],sc*c[offset+2],sd*d[offset+2],this.u),
        cubic(sa*a[offset+3],b[offset+3],sc*c[offset+3],sd*d[offset+3],this.u)).normalize();
      return out;
    }
    apply(phase,weight,laser=false,previous=null,maxStep=0){
      const data=this.clip,f=data.frames,n=f.length,t=((phase%1)+1)%1*n,i=Math.floor(t);
      this.indices[0]=(i+n-1)%n;this.indices[1]=i;this.indices[2]=(i+1)%n;this.indices[3]=(i+2)%n;this.u=t-i;
      const ids=this.indices;
      for(let k=0;k<3;k++)this.root.setComponent(k,cubic(f[ids[0]].root[k],f[ids[1]].root[k],f[ids[2]].root[k],f[ids[3]].root[k],this.u));
      this.sampleQuaternion('facing',0,this.facing);
      this.frame.position.lerp(this.root,weight);this.frame.quaternion.slerp(this.facing,weight);
      for(let j=0;j<this.bones.length;j++){
        const bone=this.bones[j];
        if(laser&&/^R_(Arm|Elbow|Wrist|thumb|index|middle|ring|pinky)/i.test(bone.name))continue;
        this.sampleQuaternion('joints',j*4,this.q);bone.quaternion.slerp(this.q,weight);
        if(data.positions)bone.position.lerp(this.v.fromArray(data.positions,j*3),weight);
        if(data.scales)bone.scale.lerp(this.v.fromArray(data.scales,j*3),weight);
      }
      // Bound only the entry/exit blend. Established running follows the
      // complete baked pose directly, with no history-dependent filtering.
      if(previous){
        let j=0;
        for(const c of this.chains)for(const bone of c.nodes){
          this.q.copy(previous[j++]).rotateTowards(bone.quaternion,maxStep);
          bone.quaternion.copy(this.q);
        }
      }
      // Skin helpers are exact functions of the final joints. Interpolating
      // them independently can produce a second knee or a twisting sleeve.
      for(const c of this.chains){
        if(c.kneeSupport){
          this.q.copy(c.rest[1]).invert().multiply(c.nodes[1].quaternion).slerp(this.identity,.5);
          c.kneeSupport.quaternion.copy(c.supportRest).multiply(this.q);
          c.kneeSupport.position.copy(c.supportPosition);c.kneeSupport.scale.copy(c.supportScale);
        }
        if(c.type==='arm'){
          let twist=2*Math.atan2(c.nodes[2].quaternion.x,c.nodes[2].quaternion.w);
          twist=T.MathUtils.euclideanModulo(twist+Math.PI,2*Math.PI)-Math.PI;
          for(const helper of c.segments){
            helper.bone.quaternion.copy(helper.rest);
            if(helper.forearm&&helper.index>=2&&helper.index<=4)helper.bone.quaternion.multiply(this.q.setFromAxisAngle(this.v.set(1,0,0),twist/3));
            helper.bone.position.copy(helper.position);helper.bone.scale.copy(helper.scale);
          }
        }
        for(const toe of c.toes){toe.bone.quaternion.copy(toe.q);toe.bone.position.copy(toe.p);toe.bone.scale.copy(toe.s);}
      }
      this.frame.updateWorldMatrix(true,true);
    }
  }
  g.GodmanRunningGait=AthleticRun;
})(typeof window==='undefined'?globalThis:window);
