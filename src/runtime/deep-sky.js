(function () {
  'use strict';

  class DeepSkyRenderer {
    constructor(THREE) {
      this.THREE = THREE;
      this.nebulae = [];
      this.clusters = [];
      this.galaxies = [];
      this.backdrops = [];
      this.cameraWorld = new THREE.Vector3();
    }

    createCosmicBackdrop(spec) {
      const THREE=this.THREE,count=spec.count||18000,radius=spec.radius||5e22;
      let state=(spec.seed||0x41c64e6d)>>>0;
      const random=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};
      const positions=new Float32Array(count*3),colors=new Float32Array(count*3),sizes=new Float32Array(count),alphas=new Float32Array(count);
      const warm=new THREE.Color(0xffd6aa),cool=new THREE.Color(0xb8d1ff),neutral=new THREE.Color(0xe8ecf4),color=new THREE.Color();
      for(let i=0;i<count;i++){
        const z=random()*2-1,a=random()*Math.PI*2,r=Math.sqrt(Math.max(0,1-z*z));
        positions.set([Math.cos(a)*r*radius,z*radius,Math.sin(a)*r*radius],i*3);
        const tint=random();color.copy(tint<.13?warm:tint>.78?cool:neutral).multiplyScalar(.48+random()*.45);
        colors.set([color.r,color.g,color.b],i*3);
        // Most sources remain sub-pixel stars. A tiny fraction read as remote
        // unresolved galaxies without using image cards or extra draw calls.
        const distantGalaxy=random()<.012;
        sizes[i]=distantGalaxy?1.45+random()*1.3:.42+Math.pow(random(),4)*1.05;
        alphas[i]=distantGalaxy?.3+random()*.25:.12+random()*.34;
      }
      const geometry=new THREE.BufferGeometry();
      geometry.setAttribute('position',new THREE.BufferAttribute(positions,3));
      geometry.setAttribute('color',new THREE.BufferAttribute(colors,3));
      geometry.setAttribute('pointSize',new THREE.BufferAttribute(sizes,1));
      geometry.setAttribute('pointAlpha',new THREE.BufferAttribute(alphas,1));
      geometry.boundingSphere=new THREE.Sphere(new THREE.Vector3(),radius*1.01);
      const material=new THREE.ShaderMaterial({
        uniforms:{visibility:{value:0}},
        vertexShader:[
          '#include <common>','#include <logdepthbuf_pars_vertex>',
          'attribute float pointSize,pointAlpha;attribute vec3 color;uniform float visibility;',
          'varying vec3 vColor;varying float vAlpha;',
          'void main(){vColor=color;vAlpha=pointAlpha*visibility;gl_PointSize=pointSize;',
          'gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);','#include <logdepthbuf_vertex>','}'
        ].join('\n'),
        fragmentShader:[
          '#include <common>','#include <logdepthbuf_pars_fragment>','varying vec3 vColor;varying float vAlpha;',
          'void main(){','#include <logdepthbuf_fragment>','vec2 q=gl_PointCoord-.5;float d=dot(q,q);if(d>.25)discard;',
          'float a=smoothstep(.25,.025,d)*vAlpha;gl_FragColor=vec4(vColor,a);','}'
        ].join('\n'),
        transparent:true,depthWrite:false,depthTest:false,blending:THREE.AdditiveBlending
      });
      const points=new THREE.Points(geometry,material);points.frustumCulled=false;points.renderOrder=-50;
      this.backdrops.push({points:points,material:material});
      return points;
    }

    createNebula(spec, track) {
      const THREE = this.THREE;
      const material = new THREE.ShaderMaterial({
        uniforms: {
          cameraLocal: { value: new THREE.Vector3(0, 0, 4) },
          colorA: { value: new THREE.Color(spec.colorA) },
          colorB: { value: new THREE.Color(spec.colorB) },
          dustColor: { value: new THREE.Color(spec.dustColor || 0x08070b) },
          time: { value: 0 },
          seed: { value: spec.seed || 1 },
          mode: { value: spec.mode || 0 },
          visibility: { value: 0 }
        },
        vertexShader: [
          '#include <common>',
          '#include <logdepthbuf_pars_vertex>',
          'varying vec3 vDeepLocal;',
          'void main(){',
          '  vDeepLocal=position;',
          '  gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);',
          '  #include <logdepthbuf_vertex>',
          '}'
        ].join('\n'),
        fragmentShader: [
          '#include <common>',
          '#include <logdepthbuf_pars_fragment>',
          'uniform vec3 cameraLocal,colorA,colorB,dustColor;',
          'uniform float time,seed,mode,visibility;',
          'varying vec3 vDeepLocal;',
          'float hash31(vec3 p){p=fract(p*.1031);p+=dot(p,p.yzx+33.33);return fract((p.x+p.y)*p.z);}',
          'float noise3(vec3 p){',
          '  vec3 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);',
          '  float n000=hash31(i),n100=hash31(i+vec3(1,0,0)),n010=hash31(i+vec3(0,1,0)),n110=hash31(i+vec3(1,1,0));',
          '  float n001=hash31(i+vec3(0,0,1)),n101=hash31(i+vec3(1,0,1)),n011=hash31(i+vec3(0,1,1)),n111=hash31(i+vec3(1,1,1));',
          '  return mix(mix(mix(n000,n100,f.x),mix(n010,n110,f.x),f.y),mix(mix(n001,n101,f.x),mix(n011,n111,f.x),f.y),f.z);',
          '}',
          'float fbm(vec3 p){float a=.52,v=0.0;for(int i=0;i<5;i++){v+=a*noise3(p);p=p*2.03+vec3(1.7,-2.1,.9);a*=.5;}return v;}',
          'float gasDensity(vec3 p,out float dust,out float ion){',
          '  vec3 drift=vec3(time*.0031,-time*.0017,time*.0012);',
          '  vec3 warp=vec3(fbm(p*1.7+seed+drift),fbm(p*1.7+seed*1.7-drift),fbm(p*1.7-seed*.8+drift))-.5;',
          '  vec3 q=p+warp*.29;',
          '  float r=length(q);float cloud=1.0-smoothstep(.28,1.0,r);',
          '  float billow=fbm(q*3.15+seed*.37);float filaments=pow(fbm(q*7.2-seed*.21),2.3);',
          '  float shell=exp(-abs(r-.64)*13.0)*(1.0-smoothstep(.84,1.0,r));',
          '  float body=mix(cloud,shell,step(.5,mode));',
          '  if(mode>1.5)body=mix(shell,cloud*.28,.18);',
          '  dust=smoothstep(.50,.79,fbm(q*5.4+vec3(seed*2.1)))*body;',
          '  ion=clamp(exp(-length(q*vec3(1.0,1.24,.86))*2.8)+filaments*.48,0.0,1.0);',
          '  return max(0.0,billow-.38)*(1.35+filaments*1.8)*body;',
          '}',
          'void main(){',
          '  #include <logdepthbuf_fragment>',
          '  vec3 ro=cameraLocal,rd=normalize(vDeepLocal-ro);',
          '  float b=dot(ro,rd),c=dot(ro,ro)-1.0,h=b*b-c;if(h<=0.0)discard;',
          '  h=sqrt(h);float t0=max(0.0,-b-h),t1=-b+h;if(t1<=t0)discard;',
          '  float stepLen=(t1-t0)/36.0,trans=1.0;vec3 radiance=vec3(0.0);',
          '  for(int i=0;i<36;i++){',
          '    float t=t0+(float(i)+.5)*stepLen;vec3 p=ro+rd*t;float dust,ion;float density=gasDensity(p,dust,ion);',
          '    float absorption=density*(2.2+dust*5.5);vec3 emission=mix(colorA,colorB,ion)*density*(.42+ion*1.35);',
          '    if(mode>1.5)emission*=1.0+pow(max(0.0,1.0-abs(length(p)-.64)*4.0),4.0)*1.8;',
          '    radiance+=trans*emission*stepLen;trans*=exp(-absorption*stepLen);',
          '  }',
          '  float alpha=clamp(1.0-trans,0.0,.9)*visibility;',
          '  vec3 color=mix(dustColor,radiance/max(.08,alpha),clamp(length(radiance)*2.0,0.0,1.0));',
          '  gl_FragColor=vec4(color,alpha);',
          '  #include <tonemapping_fragment>',
          '  #include <encodings_fragment>',
          '}'
        ].join('\n'),
        transparent: true,
        depthWrite: false,
        depthTest: true,
        side: THREE.BackSide,
        blending: THREE.NormalBlending
      });
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32), material);
      mesh.scale.setScalar(spec.radius);
      mesh.rotation.set(spec.rotationX || 0, spec.rotationY || 0, spec.rotationZ || 0);
      mesh.renderOrder = 40;
      track(mesh, spec.center);
      const body = {
        name: spec.name, center: spec.center, r: spec.radius,
        bodyType: spec.bodyType || 'NEBULA', catalogOnly: true,
        searchAliases: spec.aliases || [], mesh: mesh,
        archiveData: { distanceLy: spec.distanceLy, source: spec.source || 'NASA' }
      };
      this.nebulae.push({ body: body, mesh: mesh, material: material });
      return body;
    }

    createCluster(spec, track) {
      const THREE = this.THREE, count = spec.count || 900;
      let state = (spec.seed || 1) >>> 0;
      const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
      const positions = new Float32Array(count * 3), colors = new Float32Array(count * 3);
      const warm = new THREE.Color(spec.warm || 0xffc29b), cool = new THREE.Color(spec.cool || 0xbdd9ff), color = new THREE.Color();
      for (let i = 0; i < count; i++) {
        let x, y, z, l;
        do { x=random()*2-1;y=random()*2-1;z=random()*2-1;l=x*x+y*y+z*z; } while(l>1||l<1e-5);
        const concentration=Math.pow(random(),spec.globular?2.8:.8),scale=concentration/Math.sqrt(l);
        positions.set([x*scale,y*scale,z*scale],i*3);
        color.copy(cool).lerp(warm,Math.pow(random(),1.7)).multiplyScalar(.62+random()*.65);
        colors.set([color.r,color.g,color.b],i*3);
      }
      const geometry=new THREE.BufferGeometry();
      geometry.setAttribute('position',new THREE.BufferAttribute(positions,3));
      geometry.setAttribute('color',new THREE.BufferAttribute(colors,3));
      geometry.computeBoundingSphere();
      const material=new THREE.PointsMaterial({
        size:spec.radius*(spec.globular?.055:.085),sizeAttenuation:true,vertexColors:true,
        transparent:true,opacity:0,depthWrite:false,blending:THREE.AdditiveBlending
      });
      const points=new THREE.Points(geometry,material);points.scale.setScalar(spec.radius);points.renderOrder=35;
      track(points,spec.center);
      const body={name:spec.name,center:spec.center,r:spec.radius,bodyType:spec.bodyType||'STAR CLUSTER',catalogOnly:true,
        searchAliases:spec.aliases||[],mesh:points,archiveData:{distanceLy:spec.distanceLy,source:spec.source||'NASA'}};
      this.clusters.push({body:body,mesh:points,material:material});return body;
    }

    createGalaxy(spec, track) {
      const THREE=this.THREE,count=spec.count||500000,initialCount=Math.min(count,spec.initialCount||4096);
      // Only a stable numeric star id is stored on the CPU. The vertex shader
      // turns each id into a deterministic 3D star position and colour, which
      // keeps multi-million-particle galaxies practical without large position
      // and colour buffers or millions of scene objects.
      // A one-component position attribute is sufficient: WebGL supplies zero
      // for the unused y/z components of the shader's vec3 position. This cuts
      // galaxy vertex memory and upload bandwidth by two thirds.
      const positions=new Float32Array(initialCount);
      for(let i=0;i<initialCount;i++)positions[i]=i;
      const geometry=new THREE.BufferGeometry();
      geometry.setAttribute('position',new THREE.BufferAttribute(positions,1));
      geometry.boundingSphere=new THREE.Sphere(new THREE.Vector3(),spec.radius*1.08);
      geometry.setDrawRange(0,initialCount);
      const material=new THREE.ShaderMaterial({
        uniforms:{
          radius:{value:spec.radius},seed:{value:spec.seed||1},arms:{value:spec.arms||4},
          twist:{value:spec.twist||5.6},thickness:{value:spec.thickness||.035},
          ellipticity:{value:spec.ellipticity||1},bulgeFraction:{value:spec.bulgeFraction||.18},
          bulgeHeight:{value:spec.bulgeHeight||.55},barStrength:{value:spec.barStrength||0},pointScale:{value:spec.pointScale||.012},
          coreColor:{value:new THREE.Color(spec.core||0xffd5a2)},armColor:{value:new THREE.Color(spec.arm||0xa9caff)},
          dustColor:{value:new THREE.Color(spec.dust||0x65565c)},visibility:{value:0}
        },
        vertexShader:[
          '#include <common>','#include <logdepthbuf_pars_vertex>',
          'uniform float radius,seed,arms,twist,thickness,ellipticity,bulgeFraction,bulgeHeight,barStrength,pointScale,visibility;',
          'uniform vec3 coreColor,armColor,dustColor;','varying vec3 vGalaxyColor;varying float vGalaxyAlpha;',
          'float h(float n){n=fract(n*.1031+seed*.0137);n*=n+33.33;return fract(n*(n+n));}',
          'float bell(float n){return h(n)+h(n+17.7)+h(n+39.1)+h(n+91.3)-2.0;}',
          'void main(){',
          '  float id=position.x+1.0;float selector=h(id*.731);vec3 p;float radial;float brightness;',
          '  if(selector<bulgeFraction){',
          '    radial=pow(h(id+2.1),2.45)*.36;float az=h(id+5.3)*PI*2.0;float cy=h(id+8.7)*2.0-1.0;',
          '    float sy=sqrt(max(0.0,1.0-cy*cy));p=vec3(cos(az)*sy,cy*bulgeHeight,sin(az)*sy)*radial;',
          '    vec3 bar=vec3((h(id+21.0)*2.0-1.0)*.43,bell(id+24.0)*.035,bell(id+27.0)*.095);p=mix(p,bar,barStrength);',
          '    brightness=.75+h(id+13.2)*.72;vGalaxyColor=coreColor*brightness;',
          '  }else{',
          '    radial=.055+pow(h(id+2.1),.62)*.945;float lane=floor(h(id+4.8)*arms);',
          '    float theta=lane*PI*2.0/arms+twist*radial+bell(id+8.0)*(.055+.16*radial);',
          '    p=vec3(cos(theta)*radial,bell(id+19.0)*thickness*(.22+.78*radial),sin(theta)*radial*ellipticity);',
          '    float young=pow(1.0-radial,.7),dustLane=step(.84,h(id+31.0));',
          '    vGalaxyColor=mix(armColor,coreColor,young*.58);vGalaxyColor=mix(vGalaxyColor,dustColor,dustLane*.62);',
          '    brightness=.48+h(id+47.0)*.78;vGalaxyColor*=brightness;',
          '  }',
          '  vec4 mvPosition=modelViewMatrix*vec4(p*radius,1.0);gl_Position=projectionMatrix*mvPosition;',
          '  float coreBoost=1.0+2.1*max(0.0,.18-radial)/.18;',
          '  gl_PointSize=clamp(radius*pointScale*650.0/max(1.0,-mvPosition.z)*coreBoost,.42,2.65);',
          '  vGalaxyAlpha=visibility*(.24+.42*h(id+71.0));','#include <logdepthbuf_vertex>','}'
        ].join('\n'),
        fragmentShader:[
          '#include <common>','#include <logdepthbuf_pars_fragment>','varying vec3 vGalaxyColor;varying float vGalaxyAlpha;',
          'void main(){','#include <logdepthbuf_fragment>','vec2 q=gl_PointCoord-.5;float d=dot(q,q);if(d>.25)discard;',
          'float a=smoothstep(.25,.015,d)*vGalaxyAlpha;gl_FragColor=vec4(vGalaxyColor*a,a);',
          '#include <tonemapping_fragment>','#include <encodings_fragment>','}'
        ].join('\n'),
        transparent:true,depthWrite:false,depthTest:true,blending:THREE.AdditiveBlending
      });
      const points=new THREE.Points(geometry,material);
      points.rotation.set(spec.rotationX||0,spec.rotationY||0,spec.rotationZ||0);
      if(spec.quaternion)points.quaternion.copy(spec.quaternion);
      // With 100 galaxies, culling off-screen volumes is essential. The manual
      // physical bounding sphere remains stable under the game's floating origin.
      points.renderOrder=32;points.frustumCulled=true;
      track(points,spec.center);
      const body={name:spec.name,center:spec.center,r:spec.radius,bodyType:spec.bodyType||'GALAXY',catalogOnly:true,
        searchAliases:spec.aliases||[],mesh:points,starSamples:count,estimatedStars:spec.estimatedStars||null,
        planetsPerStar:spec.planetsPerStar||0,homeGalaxy:!!spec.homeGalaxy,
        archiveData:{distanceLy:spec.distanceLy,estimatedStars:spec.estimatedStars||null,source:spec.source||'NASA'}};
      const capacityLimit=Math.min(count,spec.capacityLimit||(spec.homeGalaxy?260000:48000));
      this.galaxies.push({body:body,mesh:points,material:material,geometry:geometry,maxCount:count,capacity:initialCount,
        capacityLimit:capacityLimit,residentCount:Math.min(capacityLimit,spec.residentCount||initialCount),
        homeGalaxy:!!spec.homeGalaxy,expanding:false,lastDrawCount:0,lastLodTime:-Infinity});
      return body;
    }

    update(time, observer, cameraOffset, visibility) {
      this.cameraWorld.copy(observer).add(cameraOffset);
      for (const entry of this.nebulae) {
        entry.material.uniforms.time.value=time;
        entry.material.uniforms.visibility.value=visibility;
        entry.material.uniforms.cameraLocal.value.copy(this.cameraWorld).sub(entry.body.center).divideScalar(entry.body.r);
        entry.mesh.visible=visibility>.025;
      }
      for (const entry of this.clusters) {
        entry.material.opacity=visibility*.9;
        entry.mesh.visible=visibility>.025;
      }
      for(const entry of this.backdrops){
        // Following only the observer position creates an unreachable celestial
        // sphere: direction remains world-fixed, but no hard boundary can be hit.
        entry.points.position.copy(cameraOffset);
        entry.material.uniforms.visibility.value=visibility*.74;
        entry.points.visible=visibility>.002;
      }
      for (const entry of this.galaxies) {
        const distance=Math.max(entry.body.r*.02,observer.distanceTo(entry.body.center));
        const angular=entry.body.r/distance;
        // The deterministic population is streamed to the GPU on approach,
        // while real angular size controls how many samples are rasterized. A
        // galaxy only reveals all of its stars after the player reaches it.
        const inside=entry.homeGalaxy&&observer.distanceTo(entry.body.center)<entry.body.r;
        const lod=angular>.18?1:angular>.07?.62:angular>.02?.24:angular>.006?.08:.018;
        const desiredCount=inside?entry.residentCount:
          Math.min(entry.capacityLimit,Math.max(384,Math.floor(entry.capacityLimit*lod)));
        // Far galaxies start with a compact sample. Crossing their approach
        // threshold streams the complete deterministic population during an
        // idle slice, so millions of points never block ordinary planet play.
        const targetCapacity=inside?entry.residentCount:entry.capacityLimit;
        const shouldExpand=(inside||angular>.07)&&entry.capacity<targetCapacity;
        if(shouldExpand&&!entry.expanding){
          entry.expanding=true;
          const expand=()=>{
            const ids=new Float32Array(targetCapacity);
            for(let i=0;i<targetCapacity;i++)ids[i]=i;
            entry.geometry.setAttribute('position',new THREE.BufferAttribute(ids,1));
            entry.capacity=targetCapacity;entry.expanding=false;entry.lastDrawCount=-1;
          };
          if(typeof requestIdleCallback==='function')requestIdleCallback(expand,{timeout:900});
          else setTimeout(expand,0);
        }
        // LOD draw-range changes are deliberately throttled. Updating 100
        // BufferGeometry ranges every animation frame caused driver stalls during
        // intergalactic travel even when most galaxies were only a few pixels.
        if(time-entry.lastLodTime>.18){
          const drawCount=Math.min(entry.capacity,desiredCount);
          if(drawCount!==entry.lastDrawCount){entry.geometry.setDrawRange(0,drawCount);entry.lastDrawCount=drawCount;}
          entry.lastLodTime=time;
        }
        entry.material.uniforms.visibility.value=visibility*.92;
        entry.mesh.visible=visibility>.025;
      }
    }
  }

  window.GodmanDeepSkyRenderer = DeepSkyRenderer;
})();
