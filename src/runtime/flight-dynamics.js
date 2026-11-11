/* Shared flight forces. World-space inputs; velocity is relative to the
 * current co-rotating frame. Surface lift and steering use the same force
 * vector supplied to the character's repulsor controller. */
(function(g){
  'use strict';
  const T=g.THREE,damp=(a,b,k,dt)=>T.MathUtils.lerp(a,b,1-Math.exp(-k*dt));
  class FlightDynamics{
    constructor({jumpStages=16,cruiseScale=1,surfaceThrustScale=1}={}){
      this.jumpStages=jumpStages;this.cruiseScale=cruiseScale;
      this.surfaceThrustScale=surfaceThrustScale;
      this.spool=0;this.throttle=0;this.brake=0;this.powered=false;this.acceleration=0;this.fuelUsed=0;
      this.force=new T.Vector3();this.direction=new T.Vector3(0,1,0);
      this.previousVelocity=new T.Vector3();this.relative=new T.Vector3();
      this.desired=new T.Vector3();this.turn=new T.Quaternion();this.identity=new T.Quaternion();
      this.rig=g.GodmanPropulsorRig?new g.GodmanPropulsorRig():null;this.coordinated=false;
      this.launchImpulse=new T.Vector3();this.launchAim=new T.Vector3();this.launchAge=99;this.launchDuration=0;this.launchFlash=0;this.launchCharge=0;this.launchCost=0;this.launchDelay=.16;this.launchQueued=false;this.preparedDt=-1;this.integrationScale=1;
      this.hovering=false;this.hoverLocked=false;this.hoverRadius=NaN;this.hoverBody=null;
      this.hoverVelocity=new T.Vector3();this.hoverAim=new T.Vector3(0,1,0);this.hoverUp=new T.Vector3();
      this.brakeForce=new T.Vector3();this.brakeDirection=new T.Vector3();this.brakeHeading=new T.Vector3();this.brakeReach=0;
      this.primaryForce=new T.Vector3();this.steeringForce=new T.Vector3();this.steeringThrottle=0;
    }
    reset(){this.spool=this.throttle=this.brake=this.acceleration=this.fuelUsed=0;this.powered=false;this.force.set(0,0,0);this.coordinated=false;if(this.rig)this.rig.reset();this.launchAge=99;this.launchFlash=0;this.launchQueued=false;this.preparedDt=-1;this.integrationScale=1;this.hovering=this.hoverLocked=false;this.hoverRadius=NaN;this.hoverBody=null;this.steeringThrottle=this.brakeReach=0;this.brakeForce.set(0,0,0);this.brakeDirection.set(0,0,0);this.primaryForce.set(0,0,0);this.steeringForce.set(0,0,0);}
    beginLaunch(charge,aim,up,gravity,radius,fuel=100){
      if(fuel<.5)return false;
      this.reset();this.launchCharge=T.MathUtils.clamp(charge,0,1);
      // The cinematic takeoff is vertical. Aerial steering begins after lift-off.
      this.launchImpulse.copy(up).multiplyScalar(this.jumpVelocity(charge,gravity,radius));
      this.launchAim.copy(up);this.direction.copy(up);this.desired.copy(up);
      this.launchDuration=.16+.29*this.launchCharge;this.launchAge=0;this.launchFlash=0;this.launchQueued=true;this.launchCost=Math.min(fuel,.8+3.2*this.launchCharge);
      this.launchImpulse.multiplyScalar(Math.sqrt(Math.min(1,fuel/(.8+3.2*this.launchCharge))));
      return true;
    }
    prepareLaunch(dt){
      if(!this.launchQueued)return false;
      const remaining=this.launchDelay-this.launchAge;
      this.launchAge=Math.min(this.launchDelay,this.launchAge+dt);
      if(this.launchAge>=this.launchDelay){
        this.launchQueued=false;this.preparedDt=Math.max(0,dt-remaining);return true;
      }return false;
    }
    update(dt,s){
      this.integrationScale=1;
      if(this.preparedDt>=0){const frameDt=dt;dt=this.preparedDt;this.preparedDt=-1;this.integrationScale=frameDt>0?dt/frameDt:0;}
      const v=s.velocity;this.previousVelocity.copy(v);
      const launching=this.launchAge<this.launchDelay+this.launchDuration;
      const wants=!!s.thrust&&s.fuel>0&&!s.braking&&!launching;
      // Shift holds the radius captured on press. Releasing it immediately
      // hands control back to normal coasting or powered flight.
      const holdAltitude=!!s.braking&&!launching;
      if(!holdAltitude){
        this.hoverLocked=false;
        this.hoverRadius=NaN;
      }else{
        if(!this.hovering||this.hoverBody!==s.body){
          this.hoverBody=s.body;
          this.brakeHeading.copy(v).sub(s.frameVelocity).projectOnPlane(s.up);
          if(this.rig?.initialized){
            // Keep the suit's left/right axis when coming out of a dive,
            // even if the player is already looking in another direction.
            this.hoverAim.set(1,0,0).applyQuaternion(this.rig.attitude).projectOnPlane(s.up);
            if(this.hoverAim.lengthSq()>.04)this.brakeHeading.crossVectors(s.up,this.hoverAim);
          }
          if(this.brakeHeading.lengthSq()<1e-6&&s.heading)this.brakeHeading.copy(s.heading).projectOnPlane(s.up);
          if(this.brakeHeading.lengthSq()<1e-6){
            this.brakeHeading.set(Math.abs(s.up.z)<.9?0:1,0,-1).projectOnPlane(s.up);
          }
          this.brakeHeading.normalize();
          this.hoverLocked=false;
          this.hoverRadius=s.position&&s.center?s.position.distanceTo(s.center):NaN;
        }
        this.hoverVelocity.copy(v).sub(s.frameVelocity);
        this.hoverUp.copy(s.up);
        if(s.position&&s.center){
          this.hoverAim.copy(s.position).sub(s.center);
          if(this.hoverAim.lengthSq()>1)this.hoverUp.copy(this.hoverAim).normalize();
        }
        const upright=!this.rig||!this.rig.initialized||
          (this.rig.bodyUp.dot(s.up)>.995&&this.rig.angularVelocity.length()<.05);
        this.hoverLocked=this.hoverVelocity.length()<.025&&upright;
        this.desired.copy(s.up);
      }
      this.hovering=holdAltitude;
      if(wants)this.desired.copy(s.aim).normalize();
      if(launching)this.desired.copy(this.launchAim);
      if(s.braking&&!this.hovering){this.desired.copy(v).sub(s.frameVelocity);if(this.desired.lengthSq()>.01)this.desired.normalize().negate();else this.desired.copy(s.up);}
      if(s.heading&&this.rig){
        const correcting=this.rig.angularVelocity.length()>.04&&s.fuel>0;
        const active=wants||launching||this.hovering||this.spool>.015||this.brake>.015||correcting;
        const pressure=this.hovering?1:T.MathUtils.smoothstep(s.fuel,0,4);
        this.rig.update(dt,{up:s.up,heading:this.hovering?this.brakeHeading:wants||launching||!this.rig.initialized?s.heading:this.rig.heading,aim:this.desired.lengthSq()>.5?this.desired:s.up,active,braking:this.hovering,drive:!this.hovering&&!launching,surface:s.surface,hover:this.hoverLocked,authority:(this.hovering?Math.max(s.gravity.length(),8):Math.max(correcting?8:0,this.acceleration*this.spool))*pressure});
        this.coordinated=true;this.direction.copy(this.rig.direction);
      }
      const surface=T.MathUtils.clamp(s.surface,0,1);
      // Higher surface output takes a little longer to spool up so it
      // delivers a stronger burn with a comparable initial force ramp.
      const surfaceSpoolRate=Math.min(4.5,7/this.surfaceThrustScale);
      const spoolUpRate=T.MathUtils.lerp(4.5,surfaceSpoolRate,surface);
      const previousSpool=this.spool,target=wants?1:0,rate=wants?spoolUpRate:s.braking?10:6;
      this.spool=damp(this.spool,target,rate,dt);
      // Integrate the spool curve, rather than using its end-of-frame value.
      // Thrust and fuel consumption then agree at different frame rates.
      const meanSpool=dt>0?target+(previousSpool-target)*(-Math.expm1(-rate*dt))/(rate*dt):previousSpool;
      this.brake=damp(this.brake,s.braking?1:0,s.braking?8:7.5,dt);
      this.force.set(0,0,0);this.fuelUsed=0;this.throttle=0;
      if(s.fuel>0&&meanSpool>.00001){
        this.relative.copy(v).sub(s.frameVelocity);
        const speed=this.relative.length();
        // Aim is authoritative, including downwards. Surface authority is
        // sufficient to arrest a fall when aimed up; cruise retains its speed
        // growth without letting a large charged jump multiply surface thrust.
        const local=T.MathUtils.clamp(s.gravity.length()*2.6,56,80)*this.surfaceThrustScale;
        const cruise=Math.min((s.nearBlackhole?2.2e6:2.4e21)*this.cruiseScale,Math.max(64*this.cruiseScale,speed*.72));
        const requested=T.MathUtils.lerp(cruise,local,surface);
        const localCap=80*this.surfaceThrustScale;
        const limit=localCap*surface+Math.max(localCap,cruise)*(1-surface);
        if(previousSpool<.001)this.acceleration=requested;
        else this.acceleration=damp(this.acceleration,requested,4,dt);
        this.acceleration=Math.min(this.acceleration,limit);
        if(this.coordinated){this.direction.copy(this.rig.direction);}
        else if(wants){
          this.desired.copy(s.aim).normalize();
          if(this.desired.lengthSq()>.5){
            if(previousSpool<.001)this.direction.copy(this.desired);
            else{
              this.turn.setFromUnitVectors(this.direction,this.desired);
              const angle=this.turn.angleTo(this.identity);
              this.turn.slerp(this.identity,1-Math.min(1,4.5*dt/Math.max(angle,1e-8)));
              this.direction.applyQuaternion(this.turn).normalize();
            }
          }
        }
        // Twice the previous endurance. The final few percent ease out
        // instead of dropping full thrust abruptly when the tank empties.
        const burn=T.MathUtils.lerp(2,10,surface);
        this.fuelUsed=Math.min(s.fuel,burn*meanSpool*dt);
        const pressure=T.MathUtils.smoothstep(s.fuel-this.fuelUsed*.5,0,4);
        this.throttle=this.spool*pressure;
        this.force.copy(this.direction).multiplyScalar(this.acceleration*meanSpool*pressure*(1-this.brake));
        if(this.coordinated){this.force.multiplyScalar(this.rig.alignment);this.throttle*=this.rig.alignment;this.fuelUsed*=this.rig.alignment;}
      }else if(s.fuel<=0){this.spool=0;}
      const previousLaunchAge=this.launchAge;
      if(launching){
        const a=T.MathUtils.clamp((this.launchAge-this.launchDelay)/this.launchDuration,0,1);
        this.launchAge+=dt;if(this.launchAge>=this.launchDelay)this.launchQueued=false;const b=T.MathUtils.clamp((this.launchAge-this.launchDelay)/this.launchDuration,0,1);
        const fraction=(b*b*(3-2*b)-a*a*(3-2*a)),cost=this.launchCost*fraction;
        const burned=Math.min(Math.max(0,s.fuel-this.fuelUsed),cost),pressure=cost>0?burned/cost:0;
        if(dt>0)this.force.addScaledVector(this.launchImpulse,fraction*pressure/dt);
        this.fuelUsed+=burned;this.direction.copy(this.launchAim);
        this.throttle=Math.max(this.throttle,Math.min(1,fraction*this.launchDuration/Math.max(dt,1e-8)/1.5)*pressure);
      }else if(this.launchAge<2)this.launchAge+=dt;
      this.launchFlash=this.launchAge>=this.launchDelay&&this.launchAge<2?(previousLaunchAge<=this.launchDelay?1:Math.exp(-(this.launchAge-this.launchDelay)*15))*(1+this.launchCharge):0;
      let holdVerticalSpeed=0;
      this.brakeForce.set(0,0,0);
      this.brakeDirection.set(0,0,0);
      this.brakeReach=0;
      if(this.hovering){
        const height=s.position&&s.center?s.position.distanceTo(s.center):NaN;
        const error=Number.isFinite(height)&&Number.isFinite(this.hoverRadius)?this.hoverRadius-height:0;
        const vertical=this.hoverVelocity.dot(this.hoverUp);
        const gravitySupport=Math.max(0,-s.gravity.dot(this.hoverUp));
        const correction=T.MathUtils.clamp(error*5-vertical*2,-gravitySupport,40);
        holdVerticalSpeed=T.MathUtils.clamp(error*3,-24,24);
        this.force.copy(s.gravity).negate().addScaledVector(this.hoverUp,correction);
        const authority=T.MathUtils.clamp(Math.max(56,s.gravity.length()*2.6),56,80);
        this.force.clampLength(0,authority);
        this.direction.copy(this.force.lengthSq()>.000001?this.hoverAim.copy(this.force).normalize():s.up);
        this.throttle=Math.max(.08,this.force.length()/authority);
        this.fuelUsed=0;
      }
      this.primaryForce.copy(this.force);this.steeringThrottle=0;
      if(this.coordinated&&!launching){
        const pressure=this.hovering?1:T.MathUtils.smoothstep(s.fuel,0,4);
        const rated=this.hovering?T.MathUtils.clamp(Math.max(56,s.gravity.length()*2.6),56,80):Math.max(1,this.acceleration);
        const budget=this.hovering?rated*pressure:Math.min(rated,rated*Math.max(this.spool,meanSpool))*pressure;
        const cost=this.hoverLocked?0:this.rig.controlCost;
        this.primaryForce.clampLength(0,Math.max(0,budget-cost));
        this.steeringForce.copy(this.rig.controlNet).applyQuaternion(this.rig.attitude);
        if(this.hovering)this.primaryForce.copy(this.force).sub(this.steeringForce);
        if(this.surfaceThrustScale>1&&!this.hovering&&cost>budget)this.steeringForce.multiplyScalar(budget/cost);
        this.force.copy(this.primaryForce).add(this.steeringForce);
        if(this.force.lengthSq()>.000001)this.direction.copy(this.force).normalize();
        this.steeringThrottle=T.MathUtils.clamp(cost/rated,0,1);
        this.throttle=Math.max(this.throttle,this.force.length()/rated,this.steeringThrottle);
        const burn=T.MathUtils.lerp(2,10,surface);
        this.fuelUsed=this.hovering?0:Math.min(s.fuel,burn*(this.primaryForce.length()+cost)/rated*dt);
      }
      if(this.hovering&&!this.hoverLocked){
        this.brakeDirection.copy(this.hoverVelocity).projectOnPlane(this.hoverUp);
        const speed=this.brakeDirection.length();
        const moving=T.MathUtils.smoothstep(speed,.25,2.5);
        this.brakeReach=T.MathUtils.smoothstep(this.brake,.02,.62)*moving;
        if(dt>0&&speed>1e-6){
          this.brakeDirection.divideScalar(speed);
          // Give the arms a brief lead before the counter-thrust builds.
          const ignition=T.MathUtils.smoothstep(this.brake,.915,.985);
          const cruise=1-T.MathUtils.clamp(s.surface,0,1);
          const cap=64+Math.min(560,speed*1.18)+cruise*speed*1.8;
          const deceleration=ignition*Math.min(cap,speed*(-Math.expm1(-4.2*dt))/dt);
          this.brakeForce.copy(this.brakeDirection).multiplyScalar(-deceleration);
          this.force.add(this.brakeForce);
          this.throttle=Math.max(this.throttle,Math.min(1,deceleration/64));
        }
      }
      const gravityTime=launching?Math.min(dt,Math.max(0,this.launchAge-this.launchDelay)):dt;
      v.addScaledVector(s.gravity,gravityTime).addScaledVector(this.force,dt);
      // No invisible WASD acceleration during a ballistic jump.
      if(this.brake>.001||this.hovering){
        const damping=this.brake*3;
        this.relative.copy(v).sub(s.frameVelocity);
        if(!this.hovering)this.relative.multiplyScalar(Math.exp(-damping*dt));
        if(this.hovering){
          // Keep the original horizontal braking. Radially, slow toward a
          // bounded correction speed so a fast climb can return to its hold point.
          const radialSpeed=this.relative.dot(this.hoverUp);
          const verticalSpeed=damp(radialSpeed,holdVerticalSpeed,16,dt);
          this.relative.addScaledVector(this.hoverUp,verticalSpeed-radialSpeed);
        }
        v.copy(s.frameVelocity).add(this.relative);
      }
      this.powered=this.throttle>.015&&(this.force.lengthSq()>.0001||this.hovering);
      if(this.coordinated&&this.rig.updatePorts)this.rig.updatePorts(this.primaryForce,this.hoverLocked,launching,this.brakeForce);
      return this;
    }
    integrate(position,velocity,dt){
      dt*=this.integrationScale;
      position.addScaledVector(this.previousVelocity,dt*.5).addScaledVector(velocity,dt*.5);
    }
    jumpStage(charge){return Math.max(1,Math.min(this.jumpStages,Math.floor(T.MathUtils.clamp(charge,0,1)*this.jumpStages+1e-9)));}
    jumpDirection(aim,up,out){
      out.copy(aim).normalize();
      // Keep the viewed heading while clearing the surface when the
      // crosshair points into the ground. Upward aim is followed directly.
      const elevation=out.dot(up);
      if(elevation<.2)out.addScaledVector(up,.2-elevation).normalize();
      return out;
    }
    jumpHeight(charge){return 1.2*2**(this.jumpStage(charge)-1);}
    jumpVelocity(charge,gravity=9.81,radius=637100){
      const height=this.jumpHeight(charge);
      // Energy for a radial ballistic arc under inverse-square gravity.
      return Math.sqrt(2*gravity*radius*height/(radius+height));
    }
    jumpImpulse(aim,up,charge,gravity,radius,out){
      this.jumpDirection(aim,up,out);
      const stage=this.jumpStage(charge),speed=this.jumpVelocity(charge,gravity,radius);
      const elevation=out.dot(up);
      // Small jumps need leg-driven lift even when looking along the ground.
      // Additional charge can extend the aimed leap without lowering its arc.
      const lift=this.jumpVelocity(Math.min(stage,3)/this.jumpStages,gravity,radius);
      const forward=T.MathUtils.lerp(.45,1,T.MathUtils.smoothstep(stage,1,6));
      out.addScaledVector(up,-elevation).multiplyScalar(speed*forward);
      return out.addScaledVector(up,Math.max(speed*elevation,lift));
    }
  }
  g.GodmanFlightDynamics=FlightDynamics;
})(typeof window==='undefined'?globalThis:window);
