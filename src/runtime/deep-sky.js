(function () {
  'use strict';

  function makeGalacticDustMap(THREE){
    const size=256,pixels=new Uint8Array(size*size*4);
    function value(x,y,period){
      let n=Math.imul(x%period+1,374761393)^Math.imul(y%period+1,668265263)^Math.imul(period,2246822519);
      n=Math.imul(n^(n>>>13),1274126177);
      return ((n^(n>>>16))>>>0)/4294967296;
    }
    function noise(x,y,period){
      const i=Math.floor(x),j=Math.floor(y);
      let u=x-i,v=y-j;
      u=u*u*(3-2*u);v=v*v*(3-2*v);
      const a=value(i,j,period)*(1-u)+value(i+1,j,period)*u;
      const b=value(i,j+1,period)*(1-u)+value(i+1,j+1,period)*u;
      return a*(1-v)+b*v;
    }
    for(let y=0;y<size;y++)for(let x=0;x<size;x++){
      const coarse=noise(x*5/size,y*5/size,5);
      const knots=noise(x*13/size,y*13/size,13);
      const wisps=noise(x*43/size,y*43/size,43);
      const i=(y*size+x)*4;
      pixels[i]=255*(coarse*.5+knots*.32+wisps*.18);
      pixels[i+1]=255*(knots*.68+wisps*.32);
      pixels[i+2]=255*coarse;
      pixels[i+3]=255;
    }
    const map=new THREE.DataTexture(pixels,size,size);
    map.wrapS=map.wrapT=THREE.RepeatWrapping;
    map.minFilter=THREE.LinearMipmapLinearFilter;
    map.magFilter=THREE.LinearFilter;
    map.generateMipmaps=true;
    map.needsUpdate=true;
    return map;
  }

  function makeGalacticDiskMap(THREE){
    const size=512,pixels=new Uint8Array(size*size*4);
    const pitch=[.2234,.2025,.2356,.1885].map(Math.tan),phase=[.17,1.71,3.34,4.92];
    const barAngle=29*Math.PI/180,barCos=Math.cos(barAngle),barSin=Math.sin(barAngle);
    for(let j=0;j<size;j++)for(let i=0;i<size;i++){
      const x=((i+.5)/size-.5)*2.3,z=((j+.5)/size-.5)*2.3;
      const r=Math.hypot(x,z),azimuth=Math.atan2(z,x);
      const winding=Math.log(Math.max(.055,r)/.50),width=.12+.033/Math.max(.18,r);
      let arms=0;
      for(let lane=0;lane<4;lane++){
        const ridge=phase[lane]-winding/pitch[lane]+.12*Math.sin(r*22+phase[lane])+.065*Math.sin(r*47-phase[lane]);
        const delta=(azimuth-ridge)/(2*Math.PI),d=(delta-Math.round(delta))*2*Math.PI;
        arms=Math.max(arms,Math.exp(-.5*(d/width)**2)*(lane%2?.61:1));
      }
      const bx=x*barCos+z*barSin,bz=-x*barSin+z*barCos;
      const bulge=Math.exp(-Math.hypot(bx/.145,bz/.068)*1.5);
      const taper=1-THREE.MathUtils.smoothstep(r,.78,1.08);
      const disk=Math.exp(-r/.31)*taper*(.43+.57*arms*THREE.MathUtils.smoothstep(r,.12,.30));
      const k=(j*size+i)*4;
      pixels[k]=Math.round(disk*255);
      pixels[k+1]=Math.round(bulge*255);
      pixels[k+2]=Math.round(taper*Math.exp(-r/.83)*255);
      pixels[k+3]=255;
    }
    const texture=new THREE.DataTexture(pixels,size,size);
    texture.generateMipmaps=true;
    texture.minFilter=THREE.LinearMipmapLinearFilter;
    texture.magFilter=THREE.LinearFilter;
    texture.needsUpdate=true;
    return texture;
  }

  // Evaluate coverage at the actual pixel center. GL point coordinates alone
  // inherit the rasterizer's rounded center and make faint stars blink in pans.
  const pointCoverageVertex=`
    uniform vec2 starViewport;
    varying vec2 starCenter;
    varying float starSigma;
    void placeStar(float sigma){
      starCenter=(gl_Position.xy/gl_Position.w*.5+.5)*starViewport;
      starSigma=sigma;
      gl_PointSize=5.0;
    }
  `;
  const pointCoverageFragment=`
    varying vec2 starCenter;
    varying float starSigma;
    float starCoverage(){
      vec2 pixelOffset=gl_FragCoord.xy-starCenter;
      vec2 offset=pixelOffset/starSigma;
      float edge=1.-smoothstep(1.5,2.,max(abs(pixelOffset.x),abs(pixelOffset.y)));
      return exp(-.5*dot(offset,offset))*edge*.34/(starSigma*starSigma);
    }
  `;

  const milkyVolumeFragment=`
    varying vec2 screenRay;
    uniform mat4 inverseProjection;
    uniform mat3 galacticCameraBasis;
    uniform vec3 galaxyObserver;
    uniform sampler2D diskMap,galacticDust,galacticPanorama;
    uniform float visibility,panoramaMix;

    void showGalaxy(vec3 light){
      if(max(light.r,max(light.g,light.b))<.00005)discard;
      gl_FragColor=vec4(light,visibility);
      #include <tonemapping_fragment>
      #include <encodings_fragment>
    }

    void main(){
      vec4 view=inverseProjection*vec4(screenRay,0.,1.);
      vec3 ray=normalize(galacticCameraBasis*(view.xyz/view.w));
      vec3 photo=vec3(0.);
      if(panoramaMix>0.){
        const float PI=3.14159265359;
        vec2 uv=vec2(.5-atan(ray.z,-ray.x)/(2.*PI),.5+asin(clamp(ray.y,-1.,1.))/PI);
        #ifdef TEXTURE_LOD_EXT
          vec2 dx=dFdx(uv),dy=dFdy(uv);
          dx.x-=floor(dx.x+.5);
          dy.x-=floor(dy.x+.5);
          vec3 photograph=texture2DGradEXT(galacticPanorama,uv,dx,dy).rgb;
        #else
          vec3 photograph=texture2D(galacticPanorama,uv).rgb;
        #endif
        photo=pow(photograph,vec3(2.2))*.57*panoramaMix;
        if(panoramaMix>=.999){showGalaxy(photo);return;}
      }
      vec3 origin=galaxyObserver;
      float along=-dot(origin,ray);
      vec3 closest=origin+ray*along;
      float chord=1.15*1.15-dot(closest,closest);
      if(chord<=0.){showGalaxy(photo);return;}
      float halfChord=sqrt(chord);
      float start=max(0.,along-halfChord),end=along+halfChord;
      // The luminous disk is thin. Intersect the ray with its vertical bounds
      // so oblique and exterior views spend samples inside the actual disk.
      if(abs(ray.y)>.00001){
        vec2 slab=(vec2(-.16,.16)-origin.y)/ray.y;
        start=max(start,min(slab.x,slab.y));
        end=min(end,max(slab.x,slab.y));
      }else if(abs(origin.y)>.16){showGalaxy(photo);return;}
      float ds=(end-start)/20.;
      if(ds<=0.){showGalaxy(photo);return;}

      // A nearby dust complex is seen in silhouette against the integrated
      // disk. Keep its smaller filaments instead of averaging them away
      // over the full length of the sightline.
      float localDisk=(1.-smoothstep(.76,1.08,length(origin.xz)))*
        (1.-smoothstep(.016,.065,abs(origin.y)));
      float foregroundDistance=min(.11,(end-start)*.46);
      float foregroundStep=floor(foregroundDistance/ds);
      vec3 nearby=origin+ray*(start+foregroundDistance);
      vec3 broadDust=texture2D(galacticDust,nearby.xz*4.7+vec2(.22,.58)).rgb;
      vec3 fineDust=texture2D(galacticDust,nearby.xz*24.6+vec2(.49,.14)).rgb;
      float nearbyHeight=abs(nearby.y-(broadDust.b-.5)*.025-(fineDust.g-.5)*.006);
      float nearbyLane=smoothstep(.38,.67,.70*broadDust.r+.30*fineDust.r);
      float foregroundTau=localDisk*nearbyLane*exp(-nearbyHeight/.0065)*2.15;

      vec3 radiance=vec3(0.);
      float transmission=1.;
      for(int i=0;i<20;i++){
        vec3 p=origin+ray*(start+(float(i)+.5)*ds);
        vec3 structure=texture2D(diskMap,p.xz/2.3+.5).rgb;
        vec3 clouds=texture2D(galacticDust,p.xz*3.1+vec2(.37,.81)).rgb;
        vec3 filaments=texture2D(galacticDust,p.xz*13.6+vec2(.19,.64)).rgb;
        float midplane=(clouds.b-.5)*.024+(filaments.g-.5)*.009;
        float y=abs(p.y-midplane);
        float diffuse=structure.r*(exp(-abs(p.y)/.019)+.23*exp(-abs(p.y)/.052));
        diffuse*=mix(.48,1.34,smoothstep(.24,.76,clouds.g*.64+filaments.r*.36));
        float bulge=structure.g*exp(-abs(p.y)/.053)*.78;
        float dust=smoothstep(.31,.71,clouds.r*.66+filaments.r*.34);
        float tau=ds*exp(-y/.0075)*structure.b*mix(.9,22.,dust);
        if(float(i)==foregroundStep)tau+=foregroundTau;
        float remaining=exp(-tau);
        radiance+=transmission*sqrt(remaining)*ds*(
          diffuse*vec3(.63,.68,.79)+bulge*vec3(1.,.79,.58)
        );
        transmission*=remaining;
      }
      showGalaxy(photo+radiance*.91*(1.-panoramaMix));
    }
  `;

  const milkyWayDustGLSL=`
    uniform sampler2D galacticDust;
    uniform vec3 galaxyObserver;

    // Integrate the vertical density of the dust disk over the sightline.
    // Each star keeps its true position and receives its own extinction.
    float dustIntegral(float y,float scaleHeight){
      return sign(y)*scaleHeight*(1.0-exp(-abs(y)/scaleHeight));
    }
    vec3 galacticTransmission(vec3 star){
      float nearY=galaxyObserver.y,farY=star.y;
      float heightChange=farY-nearY;
      float midplane=abs(heightChange)>.0001?clamp(-nearY/heightChange,0.0,1.0):.5;
      // Sample the foreground side of the path so neighboring rays through
      // the same dust complex reveal a continuous lane across the star field.
      vec2 foreground=mix(galaxyObserver.xz,star.xz,mix(.20,midplane,.62));
      vec3 field=texture2D(galacticDust,foreground*3.7+vec2(.37,.81)).rgb;
      float ridge=(field.b-.5)*.017+(field.g-.5)*.006;
      float scaleHeight=mix(.0038,.0072,field.g);
      nearY-=ridge;
      farY-=ridge;
      float meanDensity=abs(heightChange)>.0001
        ? (dustIntegral(farY,scaleHeight)-dustIntegral(nearY,scaleHeight))/heightChange
        : exp(-abs(nearY)/scaleHeight);
      float dust=smoothstep(.32,.69,field.r);
      float disk=1.0-smoothstep(.57,1.10,length(foreground));
      float column=clamp(length(star-galaxyObserver)*meanDensity,0.0,1.2);
      return exp(-column*dust*disk*vec3(6.0,8.3,10.7));
    }
  `;

  class DeepSkyRenderer {
    constructor(THREE) {
      this.THREE = THREE;
      this.nebulae = [];
      this.clusters = [];
      this.galaxies = [];
      this.backdrops = [];
      this.veils = [];
      this.cameraWorld = new THREE.Vector3();
      this.starViewport = new THREE.Vector2(1,1);
      this.skyRotation = new THREE.Quaternion();
      this.skyMatrix = new THREE.Matrix4();
      this.solarPosition = new THREE.Vector3(.513,0,0);
      this.densityScale = 1;
      this.targetDensityScale = 1;
      this.preparePanoramaTexture = null;
    }

    setDensityScale(scale) {
      this.targetDensityScale=Math.max(.34,Math.min(1,scale));
    }

    createCosmicBackdrop(spec) {
      const THREE=this.THREE,count=spec.count||18000,radius=spec.radius||5e22;
      let state=(spec.seed||0x41c64e6d)>>>0;
      const random=()=>{
        state=(state+0x6d2b79f5)>>>0;
        let value=state;
        value=Math.imul(value^(value>>>15),value|1);
        value^=value+Math.imul(value^(value>>>7),value|61);
        return ((value^(value>>>14))>>>0)/4294967296;
      };
      const positions=new Float32Array(count*3),colors=new Float32Array(count*3),sizes=new Float32Array(count),alphas=new Float32Array(count);
      // Approximate visible black-body colours. Cooler M/K stars are much
      // more numerous, while rare hot stars remain conspicuously blue-white.
      // Keeping every channel below clipping preserves hue through ACES.
      const mStar=new THREE.Color(0xff6f47),kStar=new THREE.Color(0xffa85f),gStar=new THREE.Color(0xffdfad),
        fStar=new THREE.Color(0xd3e2ff),bStar=new THREE.Color(0x82adff);
      for(let i=0;i<count;i++){
        // Independent directions make every adaptive draw-range prefix uniform
        // without leaving a Fibonacci lattice or low-discrepancy grid visible
        // at the farthest view. Varying depth removes the impression of a
        // single spherical end wall even though the field follows the camera.
        const z=random()*2-1,a=random()*Math.PI*2;
        const r=Math.sqrt(Math.max(0,1-z*z));
        const depth=radius*(.38+Math.pow(random(),.42)*.61);
        const k=i*3;
        positions[k]=Math.cos(a)*r*depth;positions[k+1]=z*depth;positions[k+2]=Math.sin(a)*r*depth;
        const tint=random();
        const color=tint<.20?mStar:tint<.53?kStar:tint<.78?gStar:tint<.94?fStar:bStar;
        const classLum=tint<.20?.32:tint<.53?.55:tint<.78?.8:tint<.94?1.05:1.4;
        const brightness=(.58+random()*.34)*classLum;
        colors[k]=color.r*brightness;colors[k+1]=color.g*brightness;colors[k+2]=color.b*brightness;
        // A tiny fraction read as remote unresolved galaxies without using
        // image cards or extra draw calls.
        const distantGalaxy=random()<.012;
        // Vary the width and flux of the continuous pixel filter.
        sizes[i]=distantGalaxy?1.8+random()*1.55:1.02+Math.pow(random(),4)*1.08;
        alphas[i]=distantGalaxy?.46+random()*.32:.22+random()*.38;
      }
      const geometry=new THREE.BufferGeometry();
      geometry.setAttribute('position',new THREE.BufferAttribute(positions,3));
      geometry.setAttribute('color',new THREE.BufferAttribute(colors,3));
      geometry.setAttribute('pointSize',new THREE.BufferAttribute(sizes,1));
      geometry.setAttribute('pointAlpha',new THREE.BufferAttribute(alphas,1));
      geometry.boundingSphere=new THREE.Sphere(new THREE.Vector3(),radius*1.01);
      const material=new THREE.ShaderMaterial({
        uniforms:{visibility:{value:0},starViewport:{value:this.starViewport}},
        vertexShader:[
          '#include <common>','#include <logdepthbuf_pars_vertex>',
          'attribute float pointSize,pointAlpha;attribute vec3 color;uniform float visibility;',
          'varying vec3 vColor;varying float vAlpha;',pointCoverageVertex,
          'void main(){vColor=color;vAlpha=pointAlpha*visibility;',
          'gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);',
          'placeStar(.44+pointSize*.16);','#include <logdepthbuf_vertex>','}'
        ].join('\n'),
        fragmentShader:[
          '#include <common>','#include <logdepthbuf_pars_fragment>','varying vec3 vColor;varying float vAlpha;',pointCoverageFragment,
          'void main(){','#include <logdepthbuf_fragment>',
          'float a=starCoverage()*vAlpha;float l=dot(vColor,vec3(.2126,.7152,.0722));',
          'vec3 c=max(vec3(0.0),mix(vec3(l),vColor,1.42));gl_FragColor=vec4(c,a);',
          '#include <tonemapping_fragment>','#include <encodings_fragment>','}'
        ].join('\n'),
        // Sky particles render late because they are transparent, so they must
        // still test against opaque planet and character depth.  Disabling this
        // made dense stars shine through Earth and the astronaut.
        transparent:true,depthWrite:false,depthTest:true,blending:THREE.NormalBlending
      });
      const points=new THREE.Points(geometry,material);points.frustumCulled=false;points.renderOrder=-50;
      // One fixed population prevents adaptive-quality oscillation from
      // repeatedly adding and removing stars in open space. This is a single
      // GPU draw call, so keeping its draw range stable is inexpensive.
      this.backdrops.push({points:points,material:material,maxCount:count,scalable:true,stableDensity:true,homeSky:false,homeVisibility:1,lastDrawCount:count,lastLodTime:-Infinity});
      return points;
    }

    createGalacticVeil(spec) {
      const THREE=this.THREE;
      const material=new THREE.ShaderMaterial({
        uniforms:{
          normal:{value:spec.normal.clone().normalize()},
          centerDirection:{value:spec.centerDirection.clone().normalize()},
          warmColor:{value:new THREE.Color(spec.warmColor||0xb77b52)},
          coolColor:{value:new THREE.Color(spec.coolColor||0x315b91)},
          ionColor:{value:new THREE.Color(spec.ionColor||0x8b405d)},
          visibility:{value:0},time:{value:0},seed:{value:spec.seed||4.7},width:{value:spec.width||.115}
        },
        vertexShader:[
          '#include <common>','#include <logdepthbuf_pars_vertex>','varying vec3 vSkyDirection;',
          'void main(){vSkyDirection=normalize(position);gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);',
          '#include <logdepthbuf_vertex>','}'
        ].join('\n'),
        fragmentShader:[
          '#include <common>','#include <logdepthbuf_pars_fragment>',
          'uniform vec3 normal,centerDirection,warmColor,coolColor,ionColor;uniform float visibility,time,seed,width;varying vec3 vSkyDirection;',
          'float hash31(vec3 p){p=fract(p*.1031);p+=dot(p,p.yzx+33.33);return fract((p.x+p.y)*p.z);}',
          'float noise3(vec3 p){vec3 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);',
          'return mix(mix(mix(hash31(i),hash31(i+vec3(1,0,0)),f.x),mix(hash31(i+vec3(0,1,0)),hash31(i+vec3(1,1,0)),f.x),f.y),mix(mix(hash31(i+vec3(0,0,1)),hash31(i+vec3(1,0,1)),f.x),mix(hash31(i+vec3(0,1,1)),hash31(i+vec3(1,1,1)),f.x),f.y),f.z);}',
          'float fbm(vec3 p){float value=0.0,amp=.52;for(int i=0;i<5;i++){value+=noise3(p)*amp;p=p*2.03+vec3(1.7,-2.1,.9);amp*=.5;}return value;}',
          'void main(){','#include <logdepthbuf_fragment>','vec3 d=normalize(vSkyDirection);float latitude=abs(dot(d,normal));',
          'float thin=exp(-pow(latitude/max(width,.001),1.35)*3.1);float broad=exp(-latitude*latitude/(width*width*8.0));',
          'float cloud=fbm(d*7.0+seed)+.48*fbm(d*19.0-seed*.7);float detail=fbm(d*43.0+seed*2.1);',
          'float dust=smoothstep(.58,.9,fbm(d*25.0+vec3(seed*3.0))+.2*fbm(d*71.0));',
          'float core=pow(max(0.0,dot(d,centerDirection)),4.0);float opposite=pow(max(0.0,-dot(d,centerDirection)),7.0);',
          'vec3 stellar=mix(coolColor,warmColor,clamp(.18+core*.82+cloud*.16-opposite*.12,0.0,1.0));',
          'float ion=thin*pow(max(0.0,detail-.66),2.4)*5.0;stellar=mix(stellar,ionColor,clamp(ion,0.0,.55));',
          'float luminance=(broad*.055+thin*(.11+cloud*.24+core*.29))*(1.0-dust*.9);',
          'float alpha=clamp(luminance*visibility,0.0,.68);if(alpha<.001)discard;gl_FragColor=vec4(stellar*1.28,alpha);',
          '#include <tonemapping_fragment>','#include <encodings_fragment>','}'
        ].join('\n'),
        transparent:true,depthWrite:false,depthTest:true,side:THREE.BackSide,blending:THREE.NormalBlending
      });
      const mesh=new THREE.Mesh(new THREE.SphereGeometry(spec.radius||4.8e22,64,40),material);
      mesh.frustumCulled=false;mesh.renderOrder=-60;
      this.veils.push({mesh,material,homeSky:!!spec.homeSky,homeVisibility:1});
      return mesh;
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
      const independentSeeds=!!spec.homeGalaxy;
      const mix32=value=>{
        let x=value>>>0;
        x=Math.imul(x^(x>>>16),0x7feb352d);
        x=Math.imul(x^(x>>>15),0x846ca68b);
        return (x^(x>>>16))>>>0;
      };
      const buildIndependentSeeds=size=>{
        const values=new Uint16Array(size*4);
        const salts=[0x9e3779b9,0x243f6a88,0xb7e15162,0xdeadbeef];
        for(let i=0;i<size;i++)for(let channel=0;channel<4;channel++)
          values[i*4+channel]=mix32((i+1)^salts[channel])&0xffff;
        return values;
      };
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
      if(independentSeeds)geometry.setAttribute('randomSeed',new THREE.BufferAttribute(buildIndependentSeeds(initialCount),4,true));
      geometry.boundingSphere=new THREE.Sphere(new THREE.Vector3(),spec.radius*1.08);
      geometry.setDrawRange(0,initialCount);
      const material=new THREE.ShaderMaterial({
        defines:independentSeeds?{MILKY_WAY:1}:{},
        uniforms:{
          radius:{value:spec.radius},seed:{value:spec.seed||1},arms:{value:spec.arms||4},
          twist:{value:spec.twist||5.6},thickness:{value:spec.thickness||.035},
          ellipticity:{value:spec.ellipticity||1},bulgeFraction:{value:spec.bulgeFraction||.18},
          bulgeHeight:{value:spec.bulgeHeight||.55},barStrength:{value:spec.barStrength||0},pointScale:{value:spec.pointScale||.012},
          milkyMorphology:{value:spec.homeGalaxy?1:0},haloFraction:{value:spec.haloFraction||0},
          barLength:{value:spec.barLength||.48},barAngle:{value:spec.barAngle||0},diskScale:{value:spec.diskScale||.16},
          thinScaleHeight:{value:spec.thinScaleHeight||spec.thickness||.035},thickScaleHeight:{value:spec.thickScaleHeight||spec.thickness*3||.09},
          coreColor:{value:new THREE.Color(spec.core||0xffd5a2)},armColor:{value:new THREE.Color(spec.arm||0xa9caff)},
          dustColor:{value:new THREE.Color(spec.dust||0x65565c)},visibility:{value:0},densityCompensation:{value:1},
          brightness:{value:spec.brightness??1},saturation:{value:independentSeeds?.84:1.38},
          starViewport:{value:this.starViewport}
        },
        vertexShader:[
          '#include <common>','#include <logdepthbuf_pars_vertex>',
          'uniform float radius,seed,arms,twist,thickness,ellipticity,bulgeFraction,bulgeHeight,barStrength,pointScale,visibility,densityCompensation;',
          'uniform float milkyMorphology,haloFraction,barLength,barAngle,diskScale,thinScaleHeight,thickScaleHeight;',
          'uniform vec3 coreColor,armColor,dustColor;','varying vec3 vGalaxyColor;varying float vGalaxyAlpha;',
          independentSeeds?'attribute vec4 randomSeed;':'',
          independentSeeds?pointCoverageVertex:'',
          independentSeeds?milkyWayDustGLSL:'',
          independentSeeds?
            'float h(float salt){vec4 p=fract(randomSeed+salt*vec4(.1031,.11369,.13787,.09987)+seed*vec4(.0013,.0017,.0019,.0023));p+=dot(p,p.wzxy+33.33);return fract((p.x+p.y)*(p.z+p.w));}':
            'float h(float salt){float n=position.x+1.0+salt;float cell=floor(n/2048.0);float local=n-cell*2048.0;vec3 p=fract(vec3(local,cell,local+cell)*vec3(.1031,.1030,.0973)+vec3(seed*.0137,seed*.0191,seed*.0113));p+=dot(p,p.yzx+33.33);return fract((p.x+p.y)*p.z);}',
          'float bell(float n){return h(n)+h(n+17.7)+h(n+39.1)+h(n+91.3)-2.0;}',
          'void main(){',
          '  float selector=h(.731);vec3 p;float radial;float brightness;float edgeFade=1.0;float populationAlpha=1.0;',
          // The Milky Way's sparse, old stellar halo follows a steep power-law
          // density and is flattened slightly. It is a volume, not a shell.
          '  if(milkyMorphology>.5&&selector<haloFraction){',
          '    float haloU=max(.018,1.0-h(2.1));radial=min(1.42,.115*pow(haloU,-1.25));',
          '    float az=h(5.3)*PI*2.0;float cy=h(8.7)*2.0-1.0;float sy=sqrt(max(0.0,1.0-cy*cy));',
          '    p=vec3(cos(az)*sy,cy*.68,sin(az)*sy)*radial;brightness=.42+h(13.2)*.58;',
          '    vGalaxyColor=mix(vec3(.54,.65,.86),coreColor,.44)*brightness;populationAlpha=.34;edgeFade=1.0-smoothstep(1.05,1.42,radial);',
          '  }else if(selector<bulgeFraction){',
          '    radial=pow(h(2.1),2.45)*.36;float az=h(5.3)*PI*2.0;float cy=h(8.7)*2.0-1.0;',
          '    float sy=sqrt(max(0.0,1.0-cy*cy));p=vec3(cos(az)*sy,cy*bulgeHeight,sin(az)*sy)*radial;',
          // Sample the Galactic bar as a centrally concentrated ellipsoid.
          // Its silhouette is continuous in every direction: no independent
          // bounded X/Y/Z coordinates and therefore no box-shaped edge.
          '    float barRadius=pow(h(21.0),1.72);float barAz=h(24.0)*PI*2.0;',
          '    float barCy=h(27.0)*2.0-1.0;float barSy=sqrt(max(0.0,1.0-barCy*barCy));',
          // The Galactic bar is a rotated, box/peanut-shaped triaxial body.
          // Its half-length and 29-degree viewing angle are supplied in units
          // of the 15.9 kpc stellar-disk radius.
          '    float barX=cos(barAz)*barSy*barLength*barRadius;float peanut=.032+.046*pow(abs(barX)/max(.001,barLength),.72);',
          '    float barY=barCy*peanut*barRadius;float barZ=sin(barAz)*barSy*barLength*.27*barRadius;',
          '    float ca=cos(barAngle),sa=sin(barAngle);vec3 bar=vec3(ca*barX-sa*barZ,barY,sa*barX+ca*barZ);',
          '    float barBlend=barStrength*(.4+.6*(1.0-barRadius));p=mix(p,bar,barBlend);',
          '    brightness=.75+h(13.2)*.72;vGalaxyColor=coreColor*brightness;',
          '  }else{',
          '    float lane=floor(h(4.8)*arms);float diffuse=smoothstep(.69,.985,h(61.0));float localArm=step(.935,h(421.0));',
          '    if(milkyMorphology>.5){',
          // A two-dimensional exponential disk has a gamma-distributed radius.
          // A small outer-disk component preserves the observed low-density
          // population near and just beyond the conventional stellar edge.
          '      radial=-log(max(1e-5,h(2.1)*h(3.7)))*diskScale;',
          '      radial=mix(radial,.38+pow(h(509.0),.78)*.77,step(.86,h(503.0)));radial=min(radial,1.18);',
          '    }else radial=.035+pow(h(2.1),.68)*.965;',
          // The Milky Way mixes a broad older disk with clumpy arm ridges.
          // Keep the same distribution in milkySamplePosition for navigation.
          '    float armTheta;',
          '    if(milkyMorphology>.5){',
          // Logarithmic arm ridges: Scutum-Centaurus and Perseus dominate the
          // old stellar light; Sagittarius-Carina and Norma-Outer are softer.
          '      float pitch=lane<.5?.2234:lane<1.5?.2025:lane<2.5?.2356:.1885;',
          '      float phase=lane<.5?.17:lane<1.5?1.71:lane<2.5?3.34:4.92;',
          '      armTheta=phase-log(max(.055,radial)/.50)/tan(pitch)+bell(8.0)*(.055+.040/max(.13,radial));',
          '      armTheta+=.12*sin(radial*22.0+phase)+.065*sin(radial*47.0-phase);',
          '      diffuse=step(.46+.13*smoothstep(.13,.30,radial),h(61.0));',
          // The Local (Orion) Arm is a finite ~6 kpc spur at the Sun's radius,
          // rather than a fifth spiral extending around the whole Galaxy.
          '      if(localArm>.5){radial=.385+pow(h(427.0),.82)*.285;armTheta=-log(radial/.513)/tan(.2025)+bell(433.0)*.045;diffuse=0.0;}',
          '    }else armTheta=lane*PI*2.0/arms+twist*radial+bell(8.0)*(.055+.16*radial);',
          '    float diskTheta=h(67.0)*PI*2.0;float theta=mix(armTheta,diskTheta,diffuse);',
          // Real disks do not terminate on a perfect circle. Multiple angular
          // modes, arm-dependent reach and per-star scatter create a ragged,
          // progressively thinning boundary with a sparse outer population.
          '    float armReach=.94+.075*sin(theta*3.0+seed*.071)+.045*sin(theta*7.0-seed*.113);',
          '    armReach+=(lane-(arms-1.0)*.5)*.012+(h(307.0)-.5)*.075;if(milkyMorphology<.5)radial*=armReach;',
          // The Milky Way has no circular wall: its warped, flared outskirts
          // fade at different radii with azimuth and retain sparse outliers.
          '    float edge=.94+.055*sin(theta*3.0+.8)+.032*sin(theta*5.0-1.1)+.02*sin(theta*9.0);',
          '    edgeFade=1.0-smoothstep(edge-.12,edge+.13,radial);edgeFade*=.72+.28*h(331.0);',
          '    float vertical;',
          '    if(milkyMorphology>.5){',
          '      float thick=step(.875,h(193.0));float scale=mix(thinScaleHeight,thickScaleHeight,thick);',
          '      float flare=1.0+pow(max(0.0,(radial-.48)/.62),1.45)*mix(1.55,3.0,thick);',
          '      vertical=(h(197.0)<.5?-1.0:1.0)*(-log(max(.002,h(19.0))))*scale*flare;',
          '      float warp=pow(max(0.0,(radial-.52)/.58),1.55)*.044*sin(theta-.38);vertical+=warp;',
          '      populationAlpha*=mix(1.0,.68,thick);if(lane==1.0||lane==3.0)populationAlpha*=mix(.58,1.0,diffuse);',
          '    }else{float flare=(.22+.78*radial)*mix(1.0,1.7,diffuse);vertical=(bell(19.0)+bell(193.0)*.28)*thickness*flare;}',
          '    p=vec3(cos(theta)*radial,vertical,sin(theta)*radial*ellipticity);',
          '    float young=pow(max(0.0,1.0-radial),.7),dustLane=step(.84,h(31.0));',
          '    vGalaxyColor=mix(armColor,coreColor,young*.58);',
          '    float hot=pow(h(103.0),8.0),redGiant=pow(h(137.0),11.0),hII=step(.965,h(151.0))*(1.0-young*.35);',
          '    vGalaxyColor=mix(vGalaxyColor,vec3(.42,.68,1.0),hot*.62);vGalaxyColor=mix(vGalaxyColor,vec3(1.0,.42,.22),redGiant*.5);',
          '    vGalaxyColor=mix(vGalaxyColor,vec3(1.0,.24,.48),hII*.38);',
          '    if(milkyMorphology<.5)vGalaxyColor=mix(vGalaxyColor,dustColor,dustLane*.68);',
          '    brightness=.48+h(47.0)*.78;vGalaxyColor*=brightness;',
          '  }',
          '  vec4 mvPosition=modelViewMatrix*vec4(p*radius,1.0);gl_Position=projectionMatrix*mvPosition;',
          '#include <logdepthbuf_vertex>',
          // Position still comes from the same catalogue seed. Skip shading
          // and dust sampling for points outside the camera's viewport.
          '  if(gl_Position.w<=0.0||max(abs(gl_Position.x),abs(gl_Position.y))>gl_Position.w*1.02){',
          '    vGalaxyAlpha=0.0;gl_PointSize=1.0;return;',
          '  }',
          // Stellar-population tinting prevents a dense galaxy from becoming
          // a monochrome white particle cloud: cool O/B stars are rare, warm
          // K/M stars dominate, and a small giant population stays prominent.
          '  float spectrum=h(223.0);vec3 spectralTint;float spectralLum;',
          '  if(spectrum<.22){spectralTint=vec3(1.0,.29,.13);spectralLum=.28;}',
          '  else if(spectrum<.56){spectralTint=vec3(1.0,.57,.25);spectralLum=.52;}',
          '  else if(spectrum<.81){spectralTint=vec3(1.0,.82,.58);spectralLum=.82;}',
          '  else if(spectrum<.955){spectralTint=vec3(.72,.82,1.0);spectralLum=1.15;}',
          '  else{spectralTint=vec3(.28,.5,1.0);spectralLum=1.75;}',
          // Bulge and halo populations are old and metal-rich, so their
          // integrated light is warmer and contains fewer luminous blue stars.
          '  float oldPopulation=1.0-step(bulgeFraction,selector);',
          '  spectralTint=mix(spectralTint,vec3(1.0,.55,.28),oldPopulation*(.45+.28*h(263.0)));',
          '  float spectralMix=mix(.32+.16*h(251.0),.56+.14*h(251.0),oldPopulation);',
          '  vGalaxyColor=mix(vGalaxyColor,spectralTint,spectralMix)*spectralLum;',
          '#ifdef MILKY_WAY',
          '  float starCloud=texture2D(galacticDust,p.xz*2.1+vec2(.61,.27)).g;',
          '  vGalaxyColor*=galacticTransmission(p)*mix(.52,1.16,smoothstep(.24,.78,starCloud));',
          '#endif',
          '  float coreBoost=1.0+2.1*max(0.0,.18-radial)/.18;',
          '  float magnitude=.72+pow(h(389.0),9.0)*2.45;',
          '#ifdef MILKY_WAY',
          '  magnitude=.50+pow(h(389.0),7.0)*1.85;',
          '  populationAlpha*=mix(.45,1.4,pow(h(181.0),2.0));',
          '#endif',
          '  float size=clamp(radius*pointScale*650.0/max(1.0,-mvPosition.z)*coreBoost*magnitude,.38,3.85);',
          '#ifdef MILKY_WAY',
          '  placeStar(.45+size*.14);',
          '#else',
          '  gl_PointSize=size;',
          '#endif',
          // Low optical intensity keeps dense populations from becoming an
          // opaque flat silhouette while preserving their temperature colour.
          '  vGalaxyAlpha=visibility*(.08+.22*h(71.0))*edgeFade*populationAlpha*densityCompensation;',
          '#ifdef MILKY_WAY',
          '  float luminosity=pow(h(389.0),8.0);',
          '  vGalaxyAlpha*=mix(1.15,3.4,luminosity);',
          '  vGalaxyColor*=mix(1.25,2.8,luminosity);',
          '#endif',
          '}'
        ].join('\n'),
        fragmentShader:[
          '#include <common>','#include <logdepthbuf_pars_fragment>','uniform float brightness,saturation;varying vec3 vGalaxyColor;varying float vGalaxyAlpha;',
          independentSeeds?pointCoverageFragment:'',
          'void main(){','#include <logdepthbuf_fragment>',
          '#ifdef MILKY_WAY',
          'float a=starCoverage()*vGalaxyAlpha;',
          '#else',
          'vec2 q=gl_PointCoord-.5;float d=dot(q,q);if(d>.25)discard;',
          'float a=smoothstep(.25,.015,d)*vGalaxyAlpha;',
          '#endif',
          'float l=dot(vGalaxyColor,vec3(.2126,.7152,.0722));',
          'vec3 c=max(vec3(0.0),mix(vec3(l),vGalaxyColor,saturation));gl_FragColor=vec4(c*brightness,a);',
          '#include <tonemapping_fragment>','#include <encodings_fragment>','}'
        ].join('\n'),
        // Resolved Milky Way stars add light to the background. Even a
        // heavily extinguished star cannot paint a dark dot over the disk.
        transparent:true,depthWrite:false,depthTest:true,
        blending:independentSeeds?THREE.AdditiveBlending:THREE.NormalBlending
      });
      const points=new THREE.Points(geometry,material);
      points.rotation.set(spec.rotationX||0,spec.rotationY||0,spec.rotationZ||0);
      if(spec.quaternion)points.quaternion.copy(spec.quaternion);
      const observer=independentSeeds?new THREE.Vector3():null;
      let volume=null;
      if(observer){
        material.uniforms.galacticDust={value:makeGalacticDustMap(THREE)};
        material.uniforms.galaxyObserver={value:observer};
        const volumeMaterial=new THREE.ShaderMaterial({
          uniforms:{
            inverseProjection:{value:new THREE.Matrix4()},
            galacticCameraBasis:{value:new THREE.Matrix3()},
            galaxyObserver:{value:observer},
            diskMap:{value:makeGalacticDiskMap(THREE)},
            galacticDust:material.uniforms.galacticDust,
            galacticPanorama:{value:null},
            panoramaMix:{value:0},
            visibility:{value:0}
          },
          vertexShader:'varying vec2 screenRay;void main(){screenRay=position.xy;gl_Position=vec4(position.xy,1.,1.);}',
          fragmentShader:milkyVolumeFragment,
          extensions:{derivatives:true,shaderTextureLOD:true},
          transparent:true,depthTest:true,depthWrite:false,blending:THREE.AdditiveBlending
        });
        volume=new THREE.Mesh(new THREE.PlaneGeometry(2,2),volumeMaterial);
        volume.frustumCulled=false;
        volume.renderOrder=-45;
        volume.visible=false;
        points.add(volume);
      }
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
        capacityLimit:capacityLimit,volume,panoramaUrl:spec.panoramaUrl,panoramaRequested:false,panoramaStart:null,
        observer,inverseRotation:observer?points.quaternion.clone().invert():null,
        expanding:false,lastDrawCount:0,lastLodTime:-Infinity});
      if(spec.homeGalaxy){
        this.homeGalaxyBody=body;
        this.homeGalaxy=this.galaxies[this.galaxies.length-1];
      }
      return body;
    }

    requestPanorama(entry) {
      if(!entry?.panoramaUrl||entry.panoramaRequested)return;
      entry.panoramaRequested=true;
      new this.THREE.TextureLoader().load(entry.panoramaUrl,texture=>{
        texture.wrapS=this.THREE.RepeatWrapping;
        const useTexture=()=>{
          entry.volume.material.uniforms.galacticPanorama.value=texture;
        };
        if(this.preparePanoramaTexture)this.preparePanoramaTexture(texture,useTexture);
        else useTexture();
      },undefined,()=>{}); // Keep the procedural sky if the photo is unavailable.
    }

    preloadHomePanorama() {
      this.requestPanorama(this.homeGalaxy);
    }

    update(time, observer, camera, visibility, viewport) {
      const cameraOffset=camera.position;
      this.cameraWorld.copy(observer).add(cameraOffset);
      this.starViewport.copy(viewport);
      let panoramaVisible=false;
      this.densityScale+=(this.targetDensityScale-this.densityScale)*.055;
      // Overview mode can move the camera many galactic radii away while the
      // player remains on Earth. Sky-shell visibility must therefore follow
      // the camera's physical world position, not the player's position. Using
      // the player here left the close-up Milky Way band wrapped around the
      // maximum C-view and exposed its finite particle regions as huge blocks.
      const homeRatio=this.homeGalaxyBody?this.cameraWorld.distanceTo(this.homeGalaxyBody.center)/this.homeGalaxyBody.r:0;
      const homeSkyTarget=this.homeGalaxyBody?1-Math.max(0,Math.min(1,(homeRatio-.82)/.22)):1;
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
        if(entry.homeSky){
          const response=homeSkyTarget<entry.homeVisibility?.2:.045;
          entry.homeVisibility+=(homeSkyTarget-entry.homeVisibility)*response;
        }
        const layerVisibility=visibility*.74*(entry.homeSky?entry.homeVisibility:1);
        entry.material.uniforms.visibility.value=layerVisibility;
        entry.points.visible=layerVisibility>.002;
        if(entry.scalable&&!entry.stableDensity&&time-entry.lastLodTime>.18){
          // Do not rasterize hundreds of thousands of almost invisible points
          // below a bright atmosphere. In space the complete population returns.
          const visibilityBudget=.12+.88*Math.max(0,Math.min(1,(visibility-.015)/.42));
          const drawCount=Math.max(24000,Math.floor(entry.maxCount*this.densityScale*visibilityBudget));
          if(Math.abs(drawCount-entry.lastDrawCount)>2048){entry.points.geometry.setDrawRange(0,drawCount);entry.lastDrawCount=drawCount;}
          entry.lastLodTime=time;
        }
      }
      for(const entry of this.veils){
        entry.mesh.position.copy(cameraOffset);
        entry.material.uniforms.time.value=time;
        if(entry.homeSky){
          const response=homeSkyTarget<entry.homeVisibility?.2:.045;
          entry.homeVisibility+=(homeSkyTarget-entry.homeVisibility)*response;
        }
        const layerVisibility=visibility*(entry.homeSky?entry.homeVisibility:1);
        entry.material.uniforms.visibility.value=layerVisibility;
        entry.mesh.visible=layerVisibility>.002;
      }
      for (const entry of this.galaxies) {
        entry.mesh.visible=visibility>.025;
        if(!entry.mesh.visible){
          // A prepared photo can settle behind an opaque atmosphere. The
          // sky fade already controls its reveal, so there is no reason to
          // ray-march the fallback volume on the first bright orbital frames.
          if(entry.panoramaStart===null&&entry.volume?.material.uniforms.galacticPanorama.value){
            entry.panoramaStart=time-.55;
          }
          continue;
        }
        const cameraDistance=this.cameraWorld.distanceTo(entry.body.center);
        if(entry.volume){
          entry.observer.copy(this.cameraWorld).sub(entry.body.center)
            .divideScalar(entry.body.r).applyQuaternion(entry.inverseRotation);
          const volumeUniforms=entry.volume.material.uniforms;
          const homeRadius=cameraDistance/entry.body.r;
          const volumeFade=1-this.THREE.MathUtils.smoothstep(homeRadius,18,35);
          const fromSolar=entry.observer.distanceTo(this.solarPosition);
          if(fromSolar<.085)this.requestPanorama(entry);
          if(volumeUniforms.galacticPanorama.value&&entry.panoramaStart===null)entry.panoramaStart=time;
          const photoMix=entry.panoramaStart===null?0:
            (1-this.THREE.MathUtils.smoothstep(fromSolar,.018,.085))*
            this.THREE.MathUtils.smoothstep(time-entry.panoramaStart,0,.55);
          volumeUniforms.panoramaMix.value=photoMix;
          entry.volume.visible=volumeFade*visibility>.005;
          volumeUniforms.visibility.value=visibility*volumeFade;
          panoramaVisible=panoramaVisible||entry.volume.visible&&photoMix>.002;
          if(entry.volume.visible){
            volumeUniforms.inverseProjection.value.copy(camera.projectionMatrixInverse);
            this.skyRotation.copy(entry.inverseRotation).multiply(camera.quaternion);
            volumeUniforms.galacticCameraBasis.value.setFromMatrix4(this.skyMatrix.makeRotationFromQuaternion(this.skyRotation));
          }
          // Keep one stable set of resolved stars. Unresolved stellar light
          // belongs to the continuous volume and cannot flicker with GPU load.
          const resolvedFade=1-.68*this.THREE.MathUtils.smoothstep(homeRadius,2.8,15);
          entry.material.uniforms.visibility.value=visibility*.86*resolvedFade*(1-.82*photoMix);
          continue;
        }
        const distance=Math.max(entry.body.r*.02,cameraDistance);
        const angular=entry.body.r/distance;
        // The deterministic population is streamed to the GPU on approach,
        // while real angular size controls how many samples are rasterized. A
        // galaxy only reveals all of its stars after the player reaches it.
        const lod=angular>.18?1:angular>.07?.62:angular>.02?.24:angular>.006?.08:.018;
        const baseDesired=Math.min(entry.capacityLimit,Math.max(384,Math.floor(entry.capacityLimit*lod)));
        const desiredCount=Math.max(384,Math.floor(baseDesired*this.densityScale));
        // Far galaxies start with a compact sample. Crossing their approach
        // threshold streams the complete deterministic population during an
        // idle slice, so millions of points never block ordinary planet play.
        const targetCapacity=entry.capacityLimit;
        const shouldExpand=angular>.07&&entry.capacity<targetCapacity;
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
        // A galaxy's integrated luminosity is physical and must not increase
        // merely because a closer LOD streams more representative particles.
        // Compensate external views by their current sample count; inside the
        // disk, isolated nearby stellar points retain full visibility.
        const activeSamples=Math.max(384,entry.lastDrawCount>0?entry.lastDrawCount:desiredCount);
        entry.material.uniforms.densityCompensation.value=Math.max(.08,Math.min(1,Math.sqrt(90000/activeSamples)));
        entry.material.uniforms.visibility.value=visibility*.92;
      }
      return panoramaVisible;
    }
  }

  window.GodmanDeepSkyRenderer = DeepSkyRenderer;
})();
