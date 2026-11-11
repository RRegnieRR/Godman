(function(root){
  'use strict';
  const metresPerDegree=111195, radians=Math.PI/180, lakeBank=4200, riverBank=3600;
  const columns=720, rows=360, cellSize=.5, riverPathStride=65536;
  const longitudeNear=(longitude,reference)=>longitude+360*Math.round((reference-longitude)/360);
  const xCell=lon=>Math.floor((lon+180)/cellSize);
  const yCell=lat=>Math.max(0,Math.min(rows-1,Math.floor((lat+90)/cellSize)));
  const key=(x,y)=>y*columns+((x%columns+columns)%columns);
  const longitudeScale=latitude=>Math.max(.03,Math.cos(latitude*radians));
  const clamp01=value=>Math.max(0,Math.min(1,value));
  function smoothstep(value){
    const t=clamp01(value);
    return t*t*(3-2*t);
  }

  function addToCells(cells,west,east,south,north,value){
    for(let y=yCell(south);y<=yCell(north);y++){
      for(let x=xCell(west);x<=xCell(east);x++){
        const id=key(x,y);
        let list=cells.get(id);
        if(!list)cells.set(id,list=[]);
        list.push(value);
      }
    }
  }

  class EarthHydrography{
    constructor(){
      this.lakes=new Map();
      this.rivers=new Map();
      this.paths=[];
      this.coastMask=null;
    }

    *read(buffer){
      const bytes=new Uint8Array(buffer);
      if(bytes[0]!==72||bytes[1]!==89||bytes[2]!==68||bytes[3]!==50)throw new Error('Invalid Earth hydrography header');
      let cursor=4;
      function integer(){
        let value=0,shift=0,byte;
        do{
          if(cursor===bytes.length||shift>28)throw new Error('Invalid Earth hydrography value');
          byte=bytes[cursor++];
          value+=(byte&127)*2**shift;
          shift+=7;
        }while(byte&128);
        return value%2?-(value+1)/2:value/2;
      }
      function path(stride){
        const result=new Float64Array(integer()*stride),position=new Int32Array(stride);
        for(let i=0;i<result.length;i++){
          const axis=i%stride;
          position[axis]+=integer();
          result[i]=position[axis]/(axis===2?10:100000);
          if(axis===0&&i>0)result[i]=longitudeNear(result[i],result[i-stride]);
        }
        return result;
      }
      const lakes=integer(),rivers=integer();
      for(let i=0;i<lakes;i++){
        const level=integer()/10, count=integer(), rings=[];
        for(let j=0;j<count;j++)rings.push(path(2));
        this.addLake(level,rings);
        yield;
      }
      for(let i=0;i<rivers;i++){
        const width=integer();
        this.addRiver(width,path(3));
        yield;
      }
      const width=integer(),height=integer(),pixels=new Uint32Array(integer());
      let index=0;
      for(let i=0;i<pixels.length;i++){
        index+=integer();
        pixels[i]=index;
      }
      this.coastMask={width,height,pixels};
    }

    removeMappedLakes(rgba,width,height){
      const mask=this.coastMask;
      if(!mask||mask.width!==width||mask.height!==height)return;
      for(const index of mask.pixels)rgba.fill(0,index*4,index*4+3);
    }

    addLake(level,rings){
      const reference=rings[0][0], edges=new Map();
      const lake={level,reference,edges};
      let west=Infinity,east=-Infinity,south=Infinity,north=-Infinity;
      const latPad=lakeBank/metresPerDegree;
      for(const ring of rings){
        const offset=longitudeNear(ring[0],reference)-ring[0];
        for(let i=2;i<ring.length;i+=2){
          const x=ring[i-2]+offset,y=ring[i-1],nextX=ring[i]+offset,nextY=ring[i+1];
          west=Math.min(west,x,nextX);east=Math.max(east,x,nextX);
          south=Math.min(south,y,nextY);north=Math.max(north,y,nextY);
          for(let row=yCell(Math.min(y,nextY)-latPad);row<=yCell(Math.max(y,nextY)+latPad);row++){
            let segments=edges.get(row);
            if(!segments)edges.set(row,segments=[]);
            segments.push(x,y,nextX,nextY);
          }
        }
      }
      const lonPad=latPad/longitudeScale(Math.max(Math.abs(south),Math.abs(north)));
      addToCells(this.lakes,west-lonPad,east+lonPad,south-latPad,north+latPad,lake);
    }

    addRiver(width,points){
      const id=this.paths.length;
      this.paths.push({width,points});
      const latPad=(width+riverBank)/metresPerDegree;
      for(let i=3;i<points.length;i+=3){
        const x=points[i-3],y=points[i-2],nextX=points[i],nextY=points[i+1];
        const lonPad=latPad/longitudeScale(Math.max(Math.abs(y),Math.abs(nextY)));
        addToCells(this.rivers,Math.min(x,nextX)-lonPad,Math.max(x,nextX)+lonPad,
          Math.min(y,nextY)-latPad,Math.max(y,nextY)+latPad,id+i*riverPathStride);
      }
    }

    sample(longitude,latitude,out){
      out.kind=0;
      out.lakeDistance=out.riverDistance=Infinity;
      const row=yCell(latitude),id=key(xCell(longitude),row);
      const lakes=this.lakes.get(id),rivers=this.rivers.get(id);
      if(!lakes&&!rivers)return out;
      const scale=longitudeScale(latitude);
      let bestBank=Infinity;
      if(lakes)for(const lake of lakes){
        const edges=lake.edges.get(row);
        if(!edges)continue;
        const lon=longitudeNear(longitude,lake.reference);
        let inside=false,closest=Infinity;
        for(let i=0;i<edges.length;i+=4){
          const x=edges[i]-lon,y=edges[i+1]-latitude;
          const endX=edges[i+2]-lon,endY=edges[i+3]-latitude;
          if((y>0)!==(endY>0)&&x-y*(endX-x)/(endY-y)>0)inside=!inside;
          const dx=(endX-x)*scale,dy=endY-y,px=x*scale;
          const length=dx*dx+dy*dy;
          const t=length?clamp01(-(px*dx+y*dy)/length):0;
          const distance=(px+dx*t)**2+(y+dy*t)**2;
          if(distance<closest)closest=distance;
        }
        const bank=Math.sqrt(closest)*metresPerDegree*(inside?-1:1);
        if(bank>=lakeBank||bank>=bestBank)continue;
        bestBank=bank;
        out.kind=1;out.level=lake.level;out.bank=bank;out.transition=lakeBank;
      }
      // Below this shelf the lake bed is already deeper than any river.
      if(bestBank<-420)return out;
      const lakeDistance=bestBank,lakeLevel=out.level;
      let riverDistance=Infinity,riverLevel=0;
      if(rivers)for(const segment of rivers){
        const {width,points}=this.paths[segment%riverPathStride];
        const i=Math.floor(segment/riverPathStride);
        const lon=longitudeNear(longitude,points[i-3]);
        const x=(points[i-3]-lon)*scale,y=points[i-2]-latitude;
        const dx=(points[i]-points[i-3])*scale,dy=points[i+1]-points[i-2];
        const length=dx*dx+dy*dy;
        const t=length?clamp01(-(x*dx+y*dy)/length):0;
        const bank=Math.hypot(x+dx*t,y+dy*t)*metresPerDegree-width;
        if(bank>=riverBank||bank>=riverDistance)continue;
        riverDistance=bank;
        riverLevel=points[i-1]+(points[i+2]-points[i-1])*t;
      }
      if(riverDistance<riverBank){
        // Join the lake at its surface even when the coarse DEM recorded the
        // river on a nearby hillside. Match levels before changing features.
        if(lakeDistance<lakeBank)riverLevel=lakeLevel+(riverLevel-lakeLevel)*smoothstep(lakeDistance/lakeBank);
        if(lakeDistance>0&&riverDistance<lakeDistance){
          out.kind=2;out.bank=riverDistance;out.transition=riverBank;out.level=riverLevel;
        }
        out.riverDistance=riverDistance;
        out.riverLevel=riverLevel;
      }
      out.lakeDistance=lakeDistance;
      out.lakeLevel=lakeLevel;
      return out;
    }

    static bankElevation(inland,dryElevation,waterLevel,metresPerUnit,riverLevel=waterLevel){
      const {kind,bank,transition,lakeDistance,riverDistance,lakeLevel}=inland;
      if(bank<=0){
        const lakeBankDistance=kind===1?bank:Math.min(0,lakeDistance??0);
        const riverBankDistance=kind===2?bank:Math.min(0,riverDistance??0);
        const lakeDepth=65*-Math.expm1(lakeBankDistance*.045/65);
        const riverDepth=12*-Math.expm1(riverBankDistance*.075/12);
        return waterLevel-Math.max(lakeDepth,riverDepth)/metresPerUnit;
      }
      // Keep a gently sloped shelf near the shore, then rejoin the terrain.
      // Blend overlapping shelves so a change of nearest feature adds no wall.
      const shelf=(distance,limit,grade,level)=>level+limit*-Math.expm1(-distance*grade/limit)/metresPerUnit;
      if(lakeDistance<lakeBank&&riverDistance<riverBank){
        const lakeBlend=smoothstep(lakeDistance/lakeBank),riverBlend=smoothstep(riverDistance/riverBank);
        const lakeShelf=shelf(lakeDistance,13,.022,lakeLevel/metresPerUnit);
        const riverShelf=shelf(riverDistance,19,.05,riverLevel);
        const lakeWeight=(1-lakeBlend)*riverBlend,riverWeight=(1-riverBlend)*lakeBlend;
        const mixed=(lakeShelf*lakeWeight+riverShelf*riverWeight)/(lakeWeight+riverWeight);
        return mixed+(dryElevation-mixed)*Math.min(lakeBlend,riverBlend);
      }
      const elevation=kind===1?shelf(bank,13,.022,waterLevel):shelf(bank,19,.05,waterLevel);
      return elevation+(dryElevation-elevation)*smoothstep(bank/transition);
    }

    static async load(url){
      const response=await fetch(url);
      if(!response.ok)throw new Error('Earth hydrography could not be loaded');
      const hydrography=new EarthHydrography();
      const records=hydrography.read(await response.arrayBuffer());
      let record,deadline=performance.now()+4;
      do{
        record=records.next();
        if(performance.now()>deadline){
          await new Promise(resolve=>setTimeout(resolve,0));
          deadline=performance.now()+4;
        }
      }while(!record.done);
      return hydrography;
    }
  }
  root.GodmanEarthHydrography=EarthHydrography;
})(typeof window==='undefined'?globalThis:window);
