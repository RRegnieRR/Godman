(function () {
  'use strict';

  class DeepSkyRenderer {
    constructor(THREE) {
      this.THREE = THREE;
      this.nebulae = [];
      this.clusters = [];
      this.cameraWorld = new THREE.Vector3();
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

    update(time, observer, cameraOffset, visibility) {
      this.cameraWorld.copy(observer).add(cameraOffset);
      for (const entry of this.nebulae) {
        entry.material.uniforms.time.value=time;
        entry.material.uniforms.visibility.value=visibility;
        entry.material.uniforms.cameraLocal.value.copy(this.cameraWorld).sub(entry.body.center).divideScalar(entry.body.r);
        entry.mesh.visible=visibility>.003;
      }
      for (const entry of this.clusters) {
        entry.material.opacity=visibility*.9;
        entry.mesh.visible=visibility>.003;
      }
    }
  }

  window.GodmanDeepSkyRenderer = DeepSkyRenderer;
})();
