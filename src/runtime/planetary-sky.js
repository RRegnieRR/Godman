/* Local single-scattering sky and curved procedural cloud decks. Distances in
 * profiles are physical metres; the game uses 1:10 scale. No network assets. */
(function(g){
  'use strict';
  const PROFILES={
    Earth:{rayleigh:1,mie:.3,scale:8000,aerosolScale:1200,top:100000,tint:0x72aaff,haze:0,clouds:[{height:2200,thickness:1550,coverage:.45,opacity:.82,scale:2550},{height:9000,thickness:1400,coverage:.28,opacity:.23,scale:390}]},
    Mars:{rayleigh:.015,mie:.22,scale:11000,aerosolScale:11000,top:90000,tint:0xd8a080,haze:.16,mars:1,clouds:[{height:22000,coverage:.23,opacity:.16,scale:510}]},
    Venus:{rayleigh:3,mie:8,scale:15000,aerosolScale:12000,top:150000,tint:0xd6b779,haze:.65,clouds:[{height:48000,coverage:1,opacity:1,scale:230}]},
    Titan:{rayleigh:1.2,mie:3,scale:20000,aerosolScale:18000,top:160000,tint:0xc58a43,haze:.48,clouds:[{height:18000,coverage:.67,opacity:.68,scale:320}]},
    Triton:{rayleigh:.002,mie:.001,scale:8000,aerosolScale:2000,top:35000,tint:0x91a9cf,haze:0,clouds:[]},
    Jupiter:{rayleigh:2,mie:2,scale:27000,aerosolScale:18000,top:180000,tint:0xd5bc98,haze:.30,clouds:[{height:10000,coverage:.86,opacity:.95,scale:180}]},
    Saturn:{rayleigh:2,mie:2,scale:50000,aerosolScale:23000,top:250000,tint:0xd6c08c,haze:.35,clouds:[{height:12000,coverage:.83,opacity:.92,scale:180}]},
    Uranus:{rayleigh:1,mie:.7,scale:27000,aerosolScale:18000,top:160000,tint:0x75c5cf,haze:.30,clouds:[{height:9000,coverage:.65,opacity:.72,scale:210}]},
    Neptune:{rayleigh:1,mie:.6,scale:20000,aerosolScale:14000,top:140000,tint:0x5282da,haze:.24,clouds:[{height:11000,coverage:.58,opacity:.75,scale:210}]}
  };
  const DEFAULT={rayleigh:1,mie:.8,scale:8000,aerosolScale:1600,top:100000,haze:.08,clouds:[]};
  function profileFor(body){
    if(!body||body.isStar)return null;
    if(PROFILES[body.name])return PROFILES[body.name];
    if(!body.atmosphere)return null;
    return Object.assign({},DEFAULT,{tint:body.atmosphere,clouds:body.clouds?[{height:2600,coverage:.50,opacity:.90,scale:620}]:[]});
  }
  function clamp(x,a,b){return Math.max(a,Math.min(b,x));}
  function smooth(a,b,x){const u=clamp((x-a)/(b-a),0,1);return u*u*(3-2*u);}
  function daylight(sunHeight){return smooth(-.19,.08,sunHeight);}
  const vertex=`varying vec2 vNdc;
    void main(){vNdc=position.xy;gl_Position=vec4(position.xy,1.,1.);}`;
  const fragment=`precision highp float;
    varying vec2 vNdc;
    uniform mat4 inverseProjection;
    uniform mat3 cameraBasis;
    uniform vec3 observer,sunDirection,betaR,betaM,betaO,sunColor,hazeTint;
    uniform float topRadius,rayHeight,mieHeight,ozoneHeight,ozoneWidth,irradiance,eclipse,haze,mars;
    const float PI=3.14159265359;
    vec2 sphere(vec3 p,vec3 d,float r){float b=dot(p,d),c=dot(p,p)-r*r,h=b*b-c;if(h<0.)return vec2(-1.);h=sqrt(h);return vec2(-b-h,-b+h);}
    vec3 density(vec3 p){float h=max(0.,length(p)-1.);return vec3(exp(-h/vec2(rayHeight,mieHeight)),max(0.,1.-abs(h-ozoneHeight)/ozoneWidth));}
    void main(){
      vec4 view=inverseProjection*vec4(vNdc,0.,1.);
      vec3 rd=normalize(cameraBasis*normalize(view.xyz/view.w));
      vec3 ro=observer;
      vec2 outer=sphere(ro,rd,topRadius);
      float start=max(0.,outer.x),end=outer.y;
      vec2 ground=sphere(ro,rd,1.);
      if(ground.x>0.)end=min(end,ground.x);
      if(end<=start){gl_FragColor=vec4(0.0003,0.0006,0.0015,1.);return;}
      float ds=(end-start)/8.;
      vec3 optical=vec3(0.);vec3 scatterR=vec3(0.),scatterM=vec3(0.);
      for(int i=0;i<8;i++){
        vec3 p=ro+rd*(start+(float(i)+.5)*ds);
        vec3 den=density(p),segment=den*ds;
        optical+=segment*.5;
        vec2 shadow=sphere(p,sunDirection,1.);
        if(shadow.x<0.){
          float farSun=max(0.,sphere(p,sunDirection,topRadius).y);
          vec3 sunOptical=vec3(0.);
          for(int j=0;j<4;j++){
            float a=float(j)/4.,b=(float(j)+1.)/4.;
            float lo=a*a*farSun,hi=b*b*farSun;
            sunOptical+=density(p+sunDirection*((lo+hi)*.5))*(hi-lo);
          }
          vec3 extinction=exp(-betaR*(optical.x+sunOptical.x)-betaM*1.1*(optical.y+sunOptical.y)-betaO*(optical.z+sunOptical.z));
          scatterR+=segment.x*extinction;scatterM+=segment.y*extinction;
        }
        optical+=segment*.5;
      }
      float mu=dot(rd,sunDirection),g=.76;
      float rayPhase=3./(16.*PI)*(1.+mu*mu);
      float miePhase=3./(8.*PI)*((1.-g*g)*(1.+mu*mu))/((2.+g*g)*pow(max(.04,1.+g*g-2.*g*mu),1.5));
      float sunHeight=dot(normalize(ro),sunDirection);
      float day=smoothstep(-.19,.08,sunHeight);
      float horizon=pow(1.-abs(dot(rd,normalize(ro))),3.);
      float lowSun=exp(-pow((sunHeight+.025)*8.,2.));
      vec3 dustColor=mix(vec3(.9,.52,.27),vec3(.12,.37,.95),lowSun*pow(max(0.,mu),14.));
      vec3 mieColor=mix(vec3(1.),dustColor*.22,mars);
      vec3 color=(scatterR*betaR*rayPhase+scatterM*betaM*miePhase*mieColor)*22.*sunColor*pow(irradiance,.3)*eclipse;
      color+=hazeTint*haze*day*(.45+.55*horizon)*pow(irradiance,.25)*eclipse;
      // Dust on Mars reddens the broad sky; its forward-scattered sunset
      // aureole is blue, unlike Earth's red/orange low-Sun horizon.
      color+=mars*vec3(.14,.29,.49)*pow(max(0.,mu),38.)*lowSun*day*eclipse;
      color+=vec3(.0003,.0006,.0015)*(1.-day);
      gl_FragColor=vec4(max(color,vec3(0.)),1.);
      #include <tonemapping_fragment>
      #include <encodings_fragment>
    }`;
  const noise=`
    float hash(vec3 p){p=fract(p*.1031);p+=dot(p,p.yzx+33.33);return fract((p.x+p.y)*p.z);}
    float noise(vec3 p){vec3 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
      return mix(mix(mix(hash(i),hash(i+vec3(1,0,0)),f.x),mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),
      mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z);}
    // Band-limit procedural detail at the pixel footprint. Without this,
    // kilometre-scale cloud edges sparkle and alias when seen from orbit.
    float fbm(vec3 p){float a=.55,v=0.,pixel=max(length(dFdx(p)),length(dFdy(p)));
      for(int i=0;i<4;i++){float detail=1.-smoothstep(.15,.6,pixel);v+=a*mix(.5,noise(p),detail);p=p*2.03+vec3(12.1,7.7,19.3);pixel*=2.03;a*=.48;}return v;}`;
  const cloudVertex=`#include <common>
    #include <logdepthbuf_pars_vertex>
    varying vec3 vNormalW,vCloud;
    void main(){vCloud=normalize(position);vNormalW=normalize(mat3(modelMatrix)*normal);
      gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);
      #include <logdepthbuf_vertex>
    }`;
  const cloudFragment=`#include <common>
    #include <logdepthbuf_pars_fragment>
    varying vec3 vNormalW,vCloud;
    uniform vec3 sunDirection,sunLocal,sunColor,tint,wind;
    uniform float coverage,opacity,frequency,irradiance,eclipse,horizonDip;
    ${noise}
    void main(){
      #include <logdepthbuf_fragment>
      vec3 p=vCloud*frequency+wind;
      float n=fbm(p),threshold=mix(.74,.20,coverage);
      float d=smoothstep(threshold,threshold+.20,n);
      float alpha=(1.-exp(-d*4.))*opacity;
      if(alpha<.005)discard;
      float elevation=dot(normalize(vNormalW),sunDirection);
      float day=smoothstep(-horizonDip-.025,.08,elevation);
      float lit=clamp(.72+(n-fbm(p+sunLocal*.65))*2.4,.32,1.);
      float warm=exp(-pow((elevation+.015)*5.,2.));
      vec3 light=mix(sunColor,vec3(1.,.39,.12),warm*.72);
      vec3 shade=mix(vec3(.38,.45,.56),vec3(1.),lit);
      vec3 col=tint*shade*light*day*pow(irradiance,.25)*eclipse;
      col+=tint*vec3(.0025,.0035,.006)*(1.-day);
      gl_FragColor=vec4(col,alpha);
      #include <tonemapping_fragment>
      #include <encodings_fragment>
    }`;
  const cloudVolumeVertex=`#include <common>
    #include <logdepthbuf_pars_vertex>
    varying vec3 vCloudWorld;
    void main(){
      vCloudWorld=(modelMatrix*vec4(position,1.)).xyz;
      gl_Position=projectionMatrix*viewMatrix*vec4(vCloudWorld,1.);
      #include <logdepthbuf_vertex>
    }`;
  const cloudVolumeFragment=`#include <common>
    #include <logdepthbuf_pars_fragment>
    varying vec3 vCloudWorld;
    uniform vec3 cloudObserver,sunLocal,sunColor,tint,wind;
    uniform mat3 cloudBasis;
    uniform mat4 cloudProjection;
    uniform float cloudBase,cloudTop,planetRadius,coverage,opacity,frequency,irradiance,eclipse,horizonDip;
    ${noise}

    // Distances are in planet radii to keep the curved ray calculation
    // well conditioned at ground level and during the climb to orbit.
    vec2 cloudSphere(vec3 ro,vec3 ray,float radius){
      float b=dot(ro,ray);
      float h=b*b-dot(ro,ro)+radius*radius;
      if(h<0.)return vec2(-1.);
      float root=sqrt(h);
      return vec2(-b-root,-b+root);
    }

    void main(){
      vec3 rayWorld=normalize(vCloudWorld-cameraPosition);
      vec3 ray=cloudBasis*rayWorld;
      vec2 outer=cloudSphere(cloudObserver,ray,cloudTop);
      vec2 inner=cloudSphere(cloudObserver,ray,cloudBase);
      float start=max(0.,outer.x),end=outer.y;
      // Only march the nearest occupied interval. From below the base, the
      // interval starts on the far side of the inner sphere.
      if(inner.x>start)end=min(end,inner.x);
      else if(inner.y>start)start=inner.y;
      vec2 surface=cloudSphere(cloudObserver,ray,1.);
      if(surface.x>0.)end=min(end,surface.x);
      float thickness=cloudTop-cloudBase;
      float path=end-start;
      if(path<=0.)discard;

      // A smooth density profile across the deck, integrated with three
      // heights. Sample the horizontal cloud pattern once per ray so sparse
      // march points cannot show up as parallel bands on the terrain.
      vec3 middle=cloudObserver+ray*(start+end)*.5;
      float startHeight=clamp((length(cloudObserver+start*ray)-cloudBase)/thickness,0.,1.);
      float endHeight=clamp((length(cloudObserver+end*ray)-cloudBase)/thickness,0.,1.);
      float midHeight=clamp((length(middle)-cloudBase)/thickness,0.,1.);
      float verticalDensity=(startHeight*(1.-startHeight)+4.*midHeight*(1.-midHeight)+endHeight*(1.-endHeight))*2./3.;
      vec3 midRadial=normalize(middle);
      vec3 p=midRadial*frequency+wind;
      float footprint=max(length(dFdx(p)),length(dFdy(p)));
      float field=fbm(p);
      float threshold=mix(.72,.27,coverage);
      float density=smoothstep(threshold,threshold+.16,field);
      density*=1.-smoothstep(.20,1.10,footprint);
      // At grazing angles the column approximation spans too much weather
      // to look like individual clouds. Fade into the existing sky haze.
      density*=smoothstep(.10,.30,abs(dot(ray,midRadial)));
      float optical=density*verticalDensity*min(path/thickness,2.6);
      float alpha=(1.-exp(-optical*2.65))*opacity;
      if(alpha<.008)discard;

      // The mesh is only a proxy; keep the cloud behind foreground objects.
      // This representative depth stays continuous across the cloud layer.
      float cloudDepth=start+path*mix(.40,.25,density);
      float viewDepth=cloudDepth*planetRadius*-(mat3(viewMatrix)*rayWorld).z;
      #if defined( USE_LOGDEPTHBUF ) && defined( USE_LOGDEPTHBUF_EXT )
        gl_FragDepthEXT=log2(1.+max(0.,viewDepth))*logDepthBufFC*.5;
      #else
        vec4 clip=cloudProjection*vec4(0.,0.,-viewDepth,1.);
        gl_FragDepthEXT=.5+.5*clip.z/clip.w;
      #endif

      vec3 radial=normalize(cloudObserver+cloudDepth*ray);
      float elevation=dot(radial,sunLocal);
      float day=smoothstep(-horizonDip-.025,.08,elevation);
      float warm=exp(-pow((elevation+.015)*5.,2.));
      vec3 light=mix(sunColor,vec3(1.,.39,.12),warm*.72);
      float topFacing=smoothstep(-.5,.5,-dot(ray,radial));
      float lit=mix(.53,.98,topFacing)*mix(.85,1.,density);
      vec3 shade=mix(vec3(.32,.41,.54),vec3(1.),lit);
      vec3 color=tint*(shade*light*day*pow(irradiance,.25)*eclipse+vec3(.0025,.0035,.006)*(1.-day));
      gl_FragColor=vec4(color,alpha);
      #include <tonemapping_fragment>
      #include <encodings_fragment>
    }`;

  class PlanetarySky{
    constructor(T,scene,fragmentDepth=true,metersPerUnit=10){
      this.T=T;this.scene=scene;this.fragmentDepth=fragmentDepth;this.metersPerUnit=metersPerUnit;this.body=null;this.profile=null;this.layers=[];
      this.inverse=new T.Quaternion();this.rotation=new T.Matrix4();this.relative=new T.Vector3();this.up=new T.Vector3();this.sun=new T.Vector3();this.sunColor=new T.Color();
      this.state={enabled:false,daylight:0,skyFactor:0,starVisibility:1,altitude:0,sunHeight:-1};
      const uniforms={inverseProjection:{value:new T.Matrix4()},cameraBasis:{value:new T.Matrix3()},observer:{value:new T.Vector3(0,1.00001,0)},sunDirection:{value:new T.Vector3(0,1,0)},
        betaR:{value:new T.Vector3()},betaM:{value:new T.Vector3()},betaO:{value:new T.Vector3()},ozoneHeight:{value:.004},ozoneWidth:{value:.0024},sunColor:{value:new T.Color(1,1,1)},hazeTint:{value:new T.Color()},
        topRadius:{value:1.016},rayHeight:{value:.00125},mieHeight:{value:.00019},irradiance:{value:1},eclipse:{value:1},haze:{value:0},mars:{value:0}};
      // Draw last among opaque objects, at the far depth. Early depth testing
      // skips atmospheric scattering behind terrain, planets and the suit.
      this.material=new T.ShaderMaterial({uniforms,vertexShader:vertex,fragmentShader:fragment,depthTest:true,depthWrite:false,fog:false});
      this.mesh=new T.Mesh(new T.PlaneGeometry(2,2),this.material);this.mesh.frustumCulled=false;this.mesh.renderOrder=100000;this.mesh.visible=false;scene.add(this.mesh);
      this.geometries=new Map();this.geometry=null;
    }
    setBody(body){
      const key=body?[body.name,body.r,body.atmosphere,!!body.clouds,!!body.isStar].join('|'):'';
      if(body===this.body&&key===this.bodyKey)return;
      this.bodyKey=key;this.body=body;this.profile=profileFor(body);
      for(const l of this.layers){this.scene.remove(l);l.material.dispose();}this.layers=[];
      const p=this.profile;if(!p)return;
      const T=this.T;
      // Cloud density is procedural, independent of mesh resolution. Keep
      // enough curvature to stay above the surface, with finer shells only
      // where a large planet's low cloud deck actually needs them.
      if(p.clouds.length){
        const height=Math.min(...p.clouds.map(deck=>deck.height))/this.metersPerUnit;
        let segments=64;
        while(segments<1024&&(body.r+height)*(1-Math.cos(Math.PI/segments))>=height*.9)segments*=2;
        if(!this.geometries.has(segments))this.geometries.set(segments,new T.SphereGeometry(1,segments*2,segments));
        this.geometry=this.geometries.get(segments);
      }
      for(const deck of p.clouds){
        const volume=!!deck.thickness&&this.fragmentDepth;
        const uniforms={
          sunDirection:{value:new T.Vector3()},sunLocal:{value:new T.Vector3()},
          sunColor:{value:new T.Color()},tint:{value:new T.Color(p.haze>.3?p.tint:0xffffff)},
          wind:{value:new T.Vector3()},coverage:{value:deck.coverage},opacity:{value:deck.opacity},
          frequency:{value:deck.scale},horizonDip:{value:Math.sqrt(2*deck.height/(body.r*this.metersPerUnit))},
          irradiance:{value:1},eclipse:{value:1}
        };
        const radius=body.r+deck.height/this.metersPerUnit;
        let proxyRadius=radius;
        if(volume){
          const half=deck.thickness/(2*this.metersPerUnit);
          Object.assign(uniforms,{
            cloudBase:{value:(radius-half)/body.r},cloudTop:{value:(radius+half)/body.r},
            cloudObserver:{value:new T.Vector3()},cloudBasis:{value:new T.Matrix3()},
            cloudProjection:{value:new T.Matrix4()},planetRadius:{value:body.r}
          });
          // Inflate the proxy enough to enclose the analytic outer sphere
          // even between its vertices.
          const segmentAngle=Math.PI/this.geometry.parameters.heightSegments;
          proxyRadius=(radius+half)/(Math.cos(segmentAngle)**2);
        }
        const material=new T.ShaderMaterial({
          uniforms,vertexShader:volume?cloudVolumeVertex:cloudVertex,
          fragmentShader:volume?cloudVolumeFragment:cloudFragment,
          extensions:{derivatives:true,fragDepth:volume},
          transparent:true,depthWrite:false,side:T.BackSide,fog:false
        });
        const mesh=new T.Mesh(this.geometry,material);
        mesh.scale.setScalar(proxyRadius);mesh.frustumCulled=false;mesh.renderOrder=10000-this.layers.length;
        mesh.userData.deck=deck;mesh.userData.volume=volume;
        this.scene.add(mesh);this.layers.push(mesh);
      }
    }

    update(camera,body,observer,star,time,eclipse=1,au=1.496e11/this.metersPerUnit){
      this.setBody(body);
      const p=this.profile,s=this.state,T=this.T;
      this.relative.copy(observer).add(camera.position).sub(body.center);
      s.altitude=this.relative.length()-body.r;this.up.copy(this.relative).normalize();
      this.sun.copy(star.center).sub(observer).sub(camera.position).normalize();
      s.sunHeight=this.up.dot(this.sun);s.daylight=daylight(s.sunHeight)*eclipse;
      const depth=p?p.top/this.metersPerUnit:1;
      s.enabled=!!p&&s.altitude<depth*1.5;
      const immersion=p?1-smooth(depth*.12,depth*1.25,Math.max(0,s.altitude)):0;
      s.immersion=immersion;
      s.skyFactor=s.daylight*immersion;
      const nightTransmission=p&&p.haze>.3?Math.exp(-p.haze*18):1;
      s.starVisibility=p?(1-(1-Math.pow(1-s.daylight,3))*immersion)*(1-immersion+nightTransmission*immersion):1;
      this.mesh.visible=s.enabled;
      const distance=star.center.distanceTo(observer)/au;
      const irradiance=clamp((star.luminosity||1)/(distance*distance),.00005,18);
      if(g.GodmanBlackbodyRgb)g.GodmanBlackbodyRgb(T,star.temperature||5772,this.sunColor);else this.sunColor.setRGB(1,.96,.9);
      for(const l of this.layers){
        l.visible=!!p&&s.altitude<body.r*10;
        const {deck,volume}=l.userData;
        if(!volume){
          const side=s.altitude*this.metersPerUnit<deck.height?T.BackSide:T.FrontSide;
          if(l.material.side!==side){l.material.side=side;l.material.needsUpdate=true;}
        }
        l.position.copy(body.center).sub(observer);
        if(body.mesh)l.quaternion.copy(body.mesh.quaternion);
        l.rotateY(time*(l.userData.deck.height>5000?.00001:.000003));
        const u=l.material.uniforms;
        this.inverse.copy(l.quaternion).invert();
        u.sunDirection.value.copy(this.sun);u.sunLocal.value.copy(this.sun).applyQuaternion(this.inverse);
        u.sunColor.value.copy(this.sunColor);u.irradiance.value=irradiance;u.eclipse.value=eclipse;
        if(volume){
          u.cloudBasis.value.setFromMatrix4(this.rotation.makeRotationFromQuaternion(this.inverse));
          u.cloudObserver.value.copy(this.relative).applyQuaternion(this.inverse).divideScalar(body.r);
          u.cloudProjection.value.copy(camera.projectionMatrix);
        }else if(deck.thickness){
          // Devices without programmable depth still get a soft crossing.
          const distance=Math.abs(s.altitude*this.metersPerUnit-deck.height);
          u.opacity.value=deck.opacity*smooth(0,deck.thickness*.5,distance);
        }
        u.wind.value.set(time*.00012,0,time*.00005);
      }
      if(!s.enabled)return s;
      const u=this.material.uniforms,physicalRadius=body.r*this.metersPerUnit;
      camera.updateMatrixWorld();u.inverseProjection.value.copy(camera.projectionMatrixInverse);u.cameraBasis.value.setFromMatrix4(camera.matrixWorld);
      u.observer.value.copy(this.relative).divideScalar(body.r);u.sunDirection.value.copy(this.sun);u.sunColor.value.copy(this.sunColor);
      u.topRadius.value=1+p.top/physicalRadius;u.rayHeight.value=p.scale/physicalRadius;u.mieHeight.value=p.aerosolScale/physicalRadius;
      u.betaR.value.set(5.8e-6,13.5e-6,33.1e-6).multiplyScalar(physicalRadius*p.rayleigh);
      u.betaM.value.setScalar(21e-6*physicalRadius*p.mie);
      u.betaO.value.set(.65e-6,1.881e-6,.085e-6).multiplyScalar(body.name==='Earth'?physicalRadius:0);
      u.ozoneHeight.value=25000/physicalRadius;u.ozoneWidth.value=15000/physicalRadius;
      if(p.mars){u.betaM.value.x*=1.3;u.betaM.value.y*=.8;u.betaM.value.z*=.45;}
      u.hazeTint.value.setHex(p.tint);u.haze.value=p.haze;u.mars.value=p.mars||0;u.irradiance.value=irradiance;u.eclipse.value=eclipse;
      return s;
    }
    dispose(){this.scene.remove(this.mesh);this.mesh.geometry.dispose();this.material.dispose();for(const l of this.layers){this.scene.remove(l);l.material.dispose();}for(const geometry of this.geometries.values())geometry.dispose();this.geometries.clear();}
  }
  g.GodmanSkyProfiles=PROFILES;g.GodmanSkyProfile=profileFor;g.GodmanSkyDaylight=daylight;g.GodmanPlanetarySky=PlanetarySky;
})(typeof window==='undefined'?globalThis:window);
