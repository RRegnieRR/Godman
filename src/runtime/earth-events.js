(function(root){
  'use strict';

  const radians=Math.PI/180;
  const events=[
    {id:'total-solar',title:'Total solar eclipse',group:'Solar eclipses',detail:'The Moon covers the Sun completely, revealing the corona.',sunElevation:14,range:356400e3,solarOffset:0},
    {id:'annular',title:'Annular solar eclipse',group:'Solar eclipses',detail:'A farther Moon leaves a bright ring around its silhouette.',sunElevation:14,range:406400e3,solarOffset:0},
    {id:'partial-solar',title:'Partial solar eclipse',group:'Solar eclipses',detail:'The Moon covers one side of the Sun.',sunElevation:14,range:384400e3,solarOffset:.29},
    {id:'blood-moon',title:'Total lunar eclipse · Blood Moon',group:'Lunar eclipses',detail:'Earth’s shadow covers the Moon and gives it a copper-red glow.',sunElevation:-15,range:384400e3,lunarOffset:0},
    {id:'partial-lunar',title:'Partial lunar eclipse',group:'Lunar eclipses',detail:'Earth’s darkest shadow crosses part of the lunar disk.',sunElevation:-15,range:384400e3,lunarOffset:.69},
    {id:'penumbral',title:'Penumbral lunar eclipse',group:'Lunar eclipses',detail:'Earth’s outer shadow softly dims one side of the Moon.',sunElevation:-15,range:384400e3,lunarOffset:1.12},
    {id:'full-moon',title:'Full Moon',group:'Moon phases',detail:'The Moon’s near side is almost fully lit, clear of Earth’s shadow.',sunElevation:-15,range:384400e3,lunarOffset:3.4},
    {id:'supermoon',title:'Supermoon',group:'Moon phases',detail:'A full Moon near its closest point to Earth appears larger.',sunElevation:-15,range:356400e3,lunarOffset:3.4},
    {id:'crescent',title:'Evening crescent',group:'Moon phases',detail:'A thin crescent hangs above the horizon after sunset.',sunElevation:-7,range:384400e3,crescentOffset:24},
    {id:'sunset',title:'Sunset',group:'Sun and sky',detail:'Low sunlight warms the sky and casts long shadows.',sunElevation:1}
  ];
  const clamp=(v,min,max)=>Math.max(min,Math.min(max,v));

  function diskCoverage(source,occluder,separation){
    if(separation>=source+occluder)return 0;
    if(separation<=Math.abs(source-occluder))return Math.min(1,(occluder/source)**2);
    const d2=separation*separation,a2=source*source,b2=occluder*occluder;
    const a=Math.acos(clamp((d2+a2-b2)/(2*separation*source),-1,1));
    const b=Math.acos(clamp((d2+b2-a2)/(2*separation*occluder),-1,1));
    const triangle=.5*Math.sqrt(Math.max(0,(-separation+source+occluder)*(separation+source-occluder)*
      (separation-source+occluder)*(separation+source+occluder)));
    return clamp((a2*a+b2*b-triangle)/(Math.PI*a2),0,1);
  }

  function viewingNormal(T,earth,sun,event,canStand){
    const sunward=sun.center.clone().sub(earth.center).normalize();
    const reference=Math.abs(sunward.y)<.9?new T.Vector3(0,1,0):new T.Vector3(1,0,0);
    const east=reference.cross(sunward).normalize();
    const north=sunward.clone().cross(east).normalize();
    const elevation=event.sunElevation*radians;
    const normal=new T.Vector3(),fallback=new T.Vector3();
    for(let i=0;i<96;i++){
      const angle=i*Math.PI*2/96;
      normal.copy(sunward).multiplyScalar(Math.sin(elevation))
        .addScaledVector(east,Math.cos(elevation)*Math.cos(angle))
        .addScaledVector(north,Math.cos(elevation)*Math.sin(angle));
      if(i===0)fallback.copy(normal);
      if(canStand(normal))return normal;
    }
    return fallback;
  }

  function moonPosition(T,event,observer,earth,sun,metersPerUnit,out){
    const radius=event.range/metersPerUnit;
    const sunlight=sun.center.clone().sub(earth.center).normalize();
    const zenith=observer.clone().sub(earth.center).normalize();
    const tangent=zenith.clone().addScaledVector(sunlight,-zenith.dot(sunlight)).normalize();
    if(event.lunarOffset!==undefined){
      const offset=event.lunarOffset*radians;
      return out.copy(earth.center).addScaledVector(sunlight,-radius*Math.cos(offset))
        .addScaledVector(tangent,radius*Math.sin(offset));
    }
    const direction=sun.center.clone().sub(observer).normalize();
    const vertical=tangent.addScaledVector(direction,-tangent.dot(direction)).normalize();
    const offset=(event.solarOffset??event.crescentOffset)*radians;
    direction.multiplyScalar(Math.cos(offset)).addScaledVector(vertical,Math.sin(offset));
    const relative=observer.clone().sub(earth.center),along=relative.dot(direction);
    const distance=-along+Math.sqrt(radius*radius-relative.lengthSq()+along*along);
    return out.copy(observer).addScaledVector(direction,distance);
  }

  function observationOrbit(T,nominal,offset){
    const radial=offset.clone().normalize();
    const normal=new T.Vector3(0,-Math.cos(nominal.inc),Math.sin(nominal.inc));
    normal.addScaledVector(radial,-normal.dot(radial));
    if(normal.lengthSq()<1e-8){
      normal.set(Math.abs(radial.x)<.9?1:0,0,Math.abs(radial.x)<.9?0:1);
      normal.addScaledVector(radial,-normal.dot(radial));
    }
    const rate=nominal.w*Math.pow(nominal.R/offset.length(),1.5);
    return {axis:normal.normalize(),offset:offset.clone(),rate};
  }

  root.GodmanEarthEvents={events,diskCoverage,viewingNormal,moonPosition,observationOrbit};
})(typeof window==='undefined'?globalThis:window);
