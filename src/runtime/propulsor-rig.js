/* One inertial flight frame for both acceleration and the rendered suit.
 * Boot gimbals handle small corrections; large turns rotate the whole suit. */
(function(g){
  'use strict';
  const T=g.THREE,clamp=T.MathUtils.clamp;
  class PropulsorRig{
    constructor(){
      this.attitude=new T.Quaternion();this.target=new T.Quaternion();this.tilt=new T.Quaternion();
      this.error=new T.Quaternion();this.step=new T.Quaternion();this.basis=new T.Matrix4();
      this.angularVelocity=new T.Vector3();this.axis=new T.Vector3();this.heading=new T.Vector3(0,0,-1);
      this.right=new T.Vector3();this.back=new T.Vector3();this.bodyUp=new T.Vector3(0,1,0);
      this.coneTarget=new T.Vector3(0,1,0);this.direction=new T.Vector3(0,1,0);this.initialized=false;this.alignment=1;
      this.inertia=new T.Vector3(.42,.32,.42);this.controlTorque=new T.Vector3();this.controlNet=new T.Vector3();this.moment=new T.Vector3();
      this.localForce=new T.Vector3();this.inverse=new T.Quaternion();this.controlCost=0;this.steer=0;this.effort=0;
      this.poseDriven=false;this.bootDrive=false;
      this.poseOrigin=new T.Vector3();this.posePoint=new T.Vector3();this.poseInverse=new T.Quaternion();
      this.pitchMoment=new T.Vector3();this.yawMoment=new T.Vector3();this.rollMoment=new T.Vector3();
      this.biasMoment=new T.Vector3();this.allocator=new T.Matrix3();this.requestedTorque=new T.Vector3();
      this.command=new T.Vector3();this.localBrake=new T.Vector3();this.bootAxis=new T.Vector3();this.rotatingMomentum=new T.Vector3();
      this.ports=[['hand',1,-.45,-.25],['hand',-1,.45,-.25],['foot',1,-.16,-.9],['foot',-1,.16,-.9]].map(p=>({type:p[0],side:p[1],lever:new T.Vector3(p[2],p[3],0),rest:new T.Vector3(p[2],p[3],0),control:new T.Vector3(),force:new T.Vector3(),exhaust:new T.Vector3(0,-1,0),power:0}));
    }
    reset(){this.initialized=false;this.poseDriven=this.bootDrive=false;this.angularVelocity.set(0,0,0);this.alignment=1;this.controlTorque.set(0,0,0);this.controlNet.set(0,0,0);this.controlCost=this.steer=this.effort=0;for(const p of this.ports){p.control.set(0,0,0);p.force.set(0,0,0);p.lever.copy(p.rest);p.power=0;}}
    samplePose(chains,attitude,dt){
      const leftLeg=chains.find(c=>c.type==='leg'&&c.sign===1);
      const rightLeg=chains.find(c=>c.type==='leg'&&c.sign===-1);
      if(!leftLeg||!rightLeg)return;
      leftLeg.nodes[0].getWorldPosition(this.poseOrigin);
      this.poseOrigin.add(rightLeg.nodes[0].getWorldPosition(this.posePoint)).multiplyScalar(.5);
      this.poseInverse.copy(attitude).invert();
      this.poseOrigin.add(this.posePoint.set(0,.24,0).applyQuaternion(attitude));
      for(const port of this.ports){
        const chain=chains.find(c=>c.sign===port.side&&c.type===(port.type==='foot'?'leg':'arm'));
        if(!chain)continue;
        chain.nodes[2].getWorldPosition(this.posePoint).sub(this.poseOrigin).applyQuaternion(this.poseInverse);
        this.posePoint.x=clamp(this.posePoint.x,port.rest.x-.30,port.rest.x+.30);
        this.posePoint.y=clamp(this.posePoint.y,port.rest.y-.35,port.rest.y+.35);
        this.posePoint.z=clamp(this.posePoint.z,-.40,.40);
        port.lever.lerp(this.posePoint,1-Math.exp(-12*dt));
      }
      this.poseDriven=true;
    }
    allocate(acceleration,authority,dt=0){
      this.controlTorque.copy(acceleration).multiply(this.inertia);
      let yaw=this.controlTorque.y/.9,pitch=this.controlTorque.x/1.3,roll=this.controlTorque.z/.9;
      // Opposing hand jets supply yaw/roll; hands against boots supply pitch.
      // A common upward bias keeps palm jets within a bounded steering cone.
      const [left,right,leftBoot,rightBoot]=this.ports;
      if(this.poseDriven){
        // Each column is the torque from one unit of the corresponding jet
        // couple. Recalculate it from the posed arms and boots.
        const y=this.poseOrigin.set(0,1,0),z=this.posePoint.set(0,0,1);
        this.pitchMoment.copy(left.lever).add(right.lever).sub(leftBoot.lever).sub(rightBoot.lever).cross(z);
        this.yawMoment.copy(left.lever).sub(right.lever).cross(z);
        this.rollMoment.copy(right.lever).sub(left.lever).cross(y);
        this.biasMoment.copy(left.lever).add(right.lever).cross(y);
        const a=this.pitchMoment,b=this.yawMoment,c=this.rollMoment;
        this.allocator.set(a.x,b.x,c.x,a.y,b.y,c.y,a.z,b.z,c.z);
        if(Math.abs(this.allocator.determinant())>.08){
          this.allocator.invert();
          this.requestedTorque.copy(this.controlTorque);
          let commonLift=0;
          for(let i=0;i<4;i++){
            this.command.copy(this.requestedTorque).addScaledVector(this.biasMoment,-commonLift).applyMatrix3(this.allocator).clampLength(0,4);
            pitch=this.command.x;yaw=this.command.y;roll=this.command.z;
            commonLift=Math.abs(roll)+Math.max(Math.abs(pitch+yaw),Math.abs(pitch-yaw))/Math.tan(.55);
          }
        }
      }
      let bias=Math.abs(roll)+Math.max(Math.abs(pitch+yaw),Math.abs(pitch-yaw))/Math.tan(.55);
      const scale=Math.min(1,Math.max(0,authority)*.32/Math.max(bias,1e-8));
      yaw*=scale;pitch*=scale;roll*=scale;bias*=scale;
      const response=this.poseDriven&&authority>0?1-Math.exp(-24*dt):1;
      left.control.lerp(this.command.set(0,bias-roll,pitch+yaw),response);
      right.control.lerp(this.command.set(0,bias+roll,pitch-yaw),response);
      leftBoot.control.lerp(this.command.set(0,0,-pitch),response);
      rightBoot.control.lerp(this.command,response);
      this.controlTorque.set(0,0,0);this.controlNet.set(0,0,0);this.controlCost=0;
      for(const p of this.ports){this.controlTorque.add(this.moment.crossVectors(p.lever,p.control));this.controlNet.add(p.control);this.controlCost+=p.control.length();}
      // Bound the resulting acceleration as well as the requested one.
      // Poor leverage from a tucked limb should not kick the suit around.
      const responseLimit=this.command.copy(this.controlTorque).divide(this.inertia).length();
      if(responseLimit>5){
        const safeScale=5/responseLimit;
        for(const port of this.ports)port.control.multiplyScalar(safeScale);
        this.controlTorque.multiplyScalar(safeScale);
        this.controlNet.multiplyScalar(safeScale);
        this.controlCost*=safeScale;
      }
      this.steer=clamp(this.controlTorque.y/(this.inertia.y*5),-1,1);
      this.effort=clamp(this.controlTorque.length()/2,0,1);
      return this.controlTorque;
    }
    updatePorts(primaryForce,handsOff=false,launch=false,brakeForce=null){
      this.inverse.copy(this.attitude).invert();this.localForce.copy(primaryForce).applyQuaternion(this.inverse);
      this.localBrake.set(0,0,0);
      if(brakeForce)this.localBrake.copy(brakeForce).applyQuaternion(this.inverse);
      const ref=Math.max(1,primaryForce.length()*.5+this.controlNet.length()*.5,this.localBrake.length()*.32);
      const bootSpan=this.bootAxis.copy(this.ports[2].lever).add(this.ports[3].lever).length();
      for(const p of this.ports){
        const weight=launch?.25:p.type==='foot'?.5:0;
        p.force.copy(this.localForce).multiplyScalar(weight);
        if(this.bootDrive&&p.type==='foot'&&bootSpan>1e-6){
          // Aim the paired boot thrust through the center of mass. Steering
          // couples add their own off-center forces to this main drive.
          p.force.copy(p.lever).multiplyScalar(-primaryForce.length()/bootSpan);
        }
        if(!handsOff){
          p.force.add(p.control);
          p.force.addScaledVector(this.localBrake,p.type==='hand'?.15:.35);
        }
        const length=p.force.length();p.power=clamp(length/ref,0,1.5);
        if(length>1e-6)p.exhaust.copy(p.force).multiplyScalar(-1/length);
        else p.exhaust.set(0,-1,0);
        if(handsOff&&p.type==='hand')p.power=0;
        if(handsOff&&p.type==='foot'&&primaryForce.length()<.01)p.power=.5;
      }
    }
    initialize(attitude,up){
      this.attitude.copy(attitude);this.angularVelocity.set(0,0,0);
      this.bodyUp.set(0,1,0).applyQuaternion(attitude);this.direction.copy(this.bodyUp);
      this.heading.set(0,0,-1).applyQuaternion(attitude).projectOnPlane(up);
      if(this.heading.lengthSq()<1e-8)this.heading.set(1,0,0).projectOnPlane(up);
      this.heading.normalize();this.initialized=true;this.alignment=1;
    }
    constrain(from,to,angle,out){
      const theta=Math.acos(clamp(from.dot(to),-1,1));this.axis.crossVectors(from,to);
      if(this.axis.lengthSq()<1e-8)this.axis.crossVectors(from,this.heading);
      if(this.axis.lengthSq()<1e-8)this.axis.set(1,0,0).projectOnPlane(from);
      this.axis.normalize();this.step.setFromAxisAngle(this.axis,Math.min(theta,angle));
      return out.copy(from).applyQuaternion(this.step).normalize();
    }
    update(dt,s){
      this.heading.copy(s.heading).projectOnPlane(s.up);
      if(s.active){
        this.back.copy(s.aim).projectOnPlane(s.up);
        if(this.back.lengthSq()>1e-6)this.heading.copy(this.back);
      }
      if(this.heading.lengthSq()<1e-8)this.heading.set(Math.abs(s.up.z)<.9?0:1,0,Math.abs(s.up.z)<.9?-1:0).projectOnPlane(s.up);
      this.heading.normalize();this.right.crossVectors(this.heading,s.up).normalize();this.back.copy(this.heading).negate();
      this.basis.makeBasis(this.right,s.up,this.back);this.target.setFromRotationMatrix(this.basis);
      if(!this.initialized){this.attitude.copy(this.target);this.direction.copy(s.up);this.initialized=true;}
      if(s.active){
        // Pitch in the pilot's heading plane. The heading still defines the
        // bend axis when aiming straight down, where up × aim has no axis.
        // The soles trail the travel direction at every elevation.
        const pitch=Math.atan2(Math.max(0,s.aim.dot(this.heading)),clamp(s.aim.dot(s.up),-1,1));
        this.tilt.setFromAxisAngle(this.right,-pitch);
        this.target.premultiply(this.tilt);
      }else if(s.surface<.2){this.target.copy(this.attitude);}
      const n=Math.max(1,Math.ceil(dt*120)),h=dt/n;
      for(let i=0;i<n;i++){
        this.error.copy(this.attitude).invert().multiply(this.target).normalize();
        if(this.error.w<0)this.error.set(-this.error.x,-this.error.y,-this.error.z,-this.error.w);
        const sin=Math.hypot(this.error.x,this.error.y,this.error.z),angle=2*Math.atan2(sin,this.error.w);
        this.axis.set(this.error.x,this.error.y,this.error.z).multiplyScalar(angle/Math.max(sin,1e-8));
        const stiffness=s.braking?10:20;
        const damping=s.braking?9.5:9;
        this.axis.multiplyScalar(stiffness).addScaledVector(this.angularVelocity,-damping).clampLength(0,s.braking?3:5);
        if(s.hover){
          // Once settled, small boot-gimbal corrections hold the frame;
          // the captured heading does not follow mouse-look.
          this.controlTorque.set(0,0,0);this.controlNet.set(0,0,0);this.controlCost=this.steer=this.effort=0;
          for(const p of this.ports)p.control.set(0,0,0);
        }else{
          const authority=s.authority===undefined?56:s.authority;
          this.allocate(this.axis,s.active?authority:0,h);
          this.rotatingMomentum.copy(this.angularVelocity).multiply(this.inertia);
          this.moment.crossVectors(this.angularVelocity,this.rotatingMomentum);
          this.axis.copy(this.controlTorque).sub(this.moment).divide(this.inertia);
          if(!s.active)this.axis.addScaledVector(this.angularVelocity,-(1.4+1.2*s.surface));
        }
        this.angularVelocity.addScaledVector(this.axis,h).clampLength(0,2.2);
        const rate=this.angularVelocity.length();
        if(rate>1e-8){this.axis.copy(this.angularVelocity).divideScalar(rate);this.step.setFromAxisAngle(this.axis,rate*h);this.attitude.multiply(this.step).normalize();}
      }
      this.bodyUp.set(0,1,0).applyQuaternion(this.attitude);
      // A turn cannot ask the boots to fire through the body. Fade while the
      // requested heading is behind the suit, then spool back into the turn.
      this.constrain(this.bodyUp,s.aim,.65,this.coneTarget);
      this.constrain(this.direction,this.coneTarget,2.8*dt,this.direction);
      this.constrain(this.bodyUp,this.direction,.72,this.direction);
      this.bootDrive=this.poseDriven&&!!s.drive;
      if(this.bootDrive){
        this.direction.copy(this.ports[2].lever).add(this.ports[3].lever).negate().normalize().applyQuaternion(this.attitude);
      }
      this.alignment=T.MathUtils.lerp(this.alignment,T.MathUtils.smoothstep(this.direction.dot(s.aim),-.15,.65),1-Math.exp(-6*dt));
      return this;
    }
  }
  g.GodmanPropulsorRig=PropulsorRig;
  g.GodmanPropulsorFlash=function(){
    const material=new T.ShaderMaterial({transparent:true,depthWrite:false,blending:T.AdditiveBlending,side:T.DoubleSide,
      uniforms:{strength:{value:0}},vertexShader:`varying vec2 uvFlash;
        #include <common>
        #include <logdepthbuf_pars_vertex>
        void main(){uvFlash=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);
        #include <logdepthbuf_vertex>
        }`,fragmentShader:`varying vec2 uvFlash;uniform float strength;
        #include <common>
        #include <logdepthbuf_pars_fragment>
        void main(){
        #include <logdepthbuf_fragment>
        float r=length(uvFlash-.5)*2.;float halo=exp(-r*r*6.)*(1.-smoothstep(.65,1.,r));
        vec3 col=mix(vec3(.12,.45,1.6),vec3(4.,4.5,5.),exp(-r*r*38.));
        gl_FragColor=vec4(col,halo*strength);
        #include <tonemapping_fragment>
        #include <encodings_fragment>
        }`});
    const group=new T.Group(),geometry=new T.PlaneGeometry(.7,.7);
    for(let i=0;i<3;i++){const plane=new T.Mesh(geometry,material);if(i===1)plane.rotation.y=Math.PI/2;if(i===2)plane.rotation.x=Math.PI/2;group.add(plane);}
    group.userData.material=material;return group;
  };
})(typeof window==='undefined'?globalThis:window);
