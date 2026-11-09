/* A single clock drives the planted charge, arm strike, ignition and lift. */
(function(g){
  'use strict';
  const T=g.THREE,smooth=(a,b,t)=>T.MathUtils.smoothstep(t,a,b);
  const ignition=.16;
  g.GodmanLaunchSequence={
    ignition,
    sample(charge,age,out){
      const releasing=age>=0&&age<1.1,c=age>=1.1?0:T.MathUtils.clamp(charge,0,1);
      const level=smooth(0,1,c),drop=releasing?smooth(0,ignition,age):0;
      const fade=releasing?1-smooth(.45,1.05,age):1;
      out.weight=releasing?fade:smooth(0,.04,c);
      out.gather=level*(1-drop)*fade;
      out.tension=level*(1-drop)*fade;
      out.stance=smooth(0,.60,c)*(releasing?1-smooth(ignition+.08,.65,age):1);
      out.strike=releasing?drop*fade:0;
      out.headBack=releasing?Math.sin(Math.PI*T.MathUtils.clamp(age/.42,0,1))*fade*(.35+.65*level):0;
      out.flash=releasing&&age>=ignition?(1+c)*Math.exp(-(age-ignition)*15):0;
      out.burst=releasing;out.age=age;return out;
    }
  };
  g.GodmanLaunchPressure=function(){
    const count=52,position=new Float32Array(count*3),seed=new Float32Array(count);
    for(let i=0;i<count;i++){const a=i*2.399963;seed[i]=((i*37)%count)/count;const radius=.35+.65*Math.sqrt(seed[i]);position[i*3]=Math.cos(a)*radius;position[i*3+2]=Math.sin(a)*radius;}
    const geometry=new T.BufferGeometry();geometry.setAttribute('position',new T.BufferAttribute(position,3));geometry.setAttribute('seed',new T.BufferAttribute(seed,1));
    const material=new T.ShaderMaterial({transparent:true,depthWrite:false,
      uniforms:{age:{value:-1},power:{value:0}},
      vertexShader:`attribute float seed;uniform float age,power;varying float opacity;
        #include <common>
        #include <logdepthbuf_pars_vertex>
        void main(){float t=max(age,0.);vec3 p=position*(.28+t*(2.2+seed*2.4));
        p.y=.025+sin(clamp(t,0.,1.)*3.14159)*(.12+seed*.28);
        vec4 mv=modelViewMatrix*vec4(p,1.);gl_Position=projectionMatrix*mv;
        gl_PointSize=clamp((.45+seed*.55)*(1.+t*2.)*300./max(1.,-mv.z),1.,110.);
        opacity=(1.-smoothstep(.12,.95,t))*(.06+power*.12)*smoothstep(0.,.05,t);
        #include <logdepthbuf_vertex>
        }`,
      fragmentShader:`varying float opacity;
        #include <common>
        #include <logdepthbuf_pars_fragment>
        void main(){
        #include <logdepthbuf_fragment>
        float r=length(gl_PointCoord-.5)*2.;float a=exp(-r*r*2.5)*(1.-smoothstep(.6,1.,r))*opacity;
        gl_FragColor=vec4(.52,.46,.38,a);
        #include <tonemapping_fragment>
        #include <encodings_fragment>
        }`});
    const group=new T.Group(),dust=new T.Points(geometry,material);dust.frustumCulled=false;group.add(dust);
    const ring=new T.Mesh(new T.RingGeometry(.92,1,64),new T.MeshBasicMaterial({color:0xd2e9ff,transparent:true,opacity:0,side:T.DoubleSide,depthWrite:false}));
    ring.rotation.x=-Math.PI/2;ring.position.y=.035;group.add(ring);
    group.updateBurst=function(age,power){
      group.visible=age>=0&&age<.95;material.uniforms.age.value=age;material.uniforms.power.value=power;
      ring.scale.setScalar(.25+Math.max(0,age)*7);ring.material.opacity=Math.max(0,1-age/.22)*.12*power;
    };
    group.visible=false;return group;
  };
})(typeof window==='undefined'?globalThis:window);
