/* Continuous height-field lighting and exact edges between terrain LODs. */
(function(g){
  'use strict';
  function coastField(rgba,width,height,radius){
    const count=width*height,water=new Uint8Array(count),distance=new Float32Array(count);
    const step=Math.PI*radius/height;
    const horizontal=Array.from({length:height},(_,y)=>
      2*Math.PI*radius/width*Math.max(.04,Math.sin(Math.PI*(y+.5)/height)));
    for(let i=0;i<count;i++)water[i]=rgba[i*4]+rgba[i*4+1]+rgba[i*4+2]>258?1:0;
    for(let y=0;y<height;y++)for(let x=0;x<width;x++){
      const i=y*width+x,left=y*width+(x+width-1)%width,right=y*width+(x+1)%width;
      const side=water[i]!==water[left]||water[i]!==water[right];
      const vertical=(y>0&&water[i]!==water[i-width])||(y+1<height&&water[i]!==water[i+width]);
      distance[i]=Math.min(side?horizontal[y]*.5:Infinity,vertical?step*.5:Infinity,step*12);
    }
    // Propagate distance from both sides of the shoreline, including across
    // the date line. Every sample then uses the same continuous contour.
    for(const direction of [1,-1,1,-1])for(let row=0;row<height;row++){
      const y=direction===1?row:height-1-row,prior=y-direction,dx=horizontal[y],diagonal=Math.hypot(step,dx);
      for(let col=0;col<width;col++){
        const x=direction===1?col:width-1-col,i=y*width+x;
        const left=(x+width-1)%width,right=(x+1)%width;
        let best=Math.min(distance[i],distance[y*width+(direction===1?left:right)]+dx);
        if(prior>=0&&prior<height)best=Math.min(best,distance[prior*width+x]+step,
          distance[prior*width+left]+diagonal,distance[prior*width+right]+diagonal);
        distance[i]=best;
      }
    }
    for(let i=0;i<count;i++)if(water[i])distance[i]=-distance[i];
    return {width,height,distance};
  }
  function coastDistance(field,u,v){
    const {width,height,distance}=field,x=u*width-.5,y=Math.max(0,Math.min(height-1,v*height-.5));
    const ix=Math.floor(x),x0=(ix+width)%width,x1=(x0+1)%width,y0=Math.floor(y),y1=Math.min(height-1,y0+1);
    const tx=x-ix,ty=y-y0;
    return (distance[y0*width+x0]*(1-tx)+distance[y0*width+x1]*tx)*(1-ty)+
      (distance[y1*width+x0]*(1-tx)+distance[y1*width+x1]*tx)*ty;
  }
  function coastElevation(distance,base,relief,sea,scale){
    const d=distance/scale,steep=Math.max(0,Math.min(1,(base/scale-18)/105));
    const smooth=(x,a,b)=>{const t=Math.max(0,Math.min(1,(x-a)/(b-a)));return t*t*(3-2*t);};
    if(d<=0){
      const depth=2.6*(1-Math.exp(d/95))+6*smooth(-d,35,430)+12*smooth(-d,310,1700);
      return sea-depth*scale;
    }
    const beach=sea+Math.min(d,180)*(.026+.055*steep)*scale;
    const inland=smooth(d,25-18*steep,360-190*steep);
    return beach+(base+relief-beach)*inland;
  }
  function coveredCapChordSq(latitude, longitudeSpan, south, north, margin){
    // The meridian edge is closer than its longitude offset, especially
    // near the poles. Limit the cap to the complete streamed rectangle.
    const eastWest=Math.asin(Math.cos(latitude)*Math.sin(Math.min(Math.PI*.5,longitudeSpan)));
    const southEdge=south<=-Math.PI*.5?Infinity:latitude-south;
    const northEdge=north>=Math.PI*.5?Infinity:north-latitude;
    const radius=Math.min(eastWest,southEdge,northEdge)-margin;
    // Squared chord distance keeps a small cap distinct from zero on the GPU.
    return radius>0?4*Math.sin(radius*.5)**2:-1;
  }
  function ruggednessField(data,width,height,columns,rows,maxElevation){
    const minRows=new Uint8Array(height*columns),maxRows=new Uint8Array(height*columns);
    const taps=new Int32Array(columns*9);
    for(let x=0;x<columns;x++){
      const source=Math.floor(x/columns*width);
      for(let i=0;i<9;i++)taps[x*9+i]=((source+i-4)%width+width)%width;
    }
    for(let y=0;y<height;y++)for(let x=0;x<columns;x++){
      let low=255,high=0;
      for(let i=0;i<9;i++){
        const value=data[y*width+taps[x*9+i]];
        low=Math.min(low,value);high=Math.max(high,value);
      }
      minRows[y*columns+x]=low;maxRows[y*columns+x]=high;
    }
    const field=new Float32Array(columns*rows);
    for(let y=0;y<rows;y++){
      const source=Math.floor(y/(rows-1)*(height-1));
      const first=Math.max(0,source-4),last=Math.min(height-1,source+4);
      for(let x=0;x<columns;x++){
        let low=255,high=0;
        for(let j=first;j<=last;j++){
          low=Math.min(low,minRows[j*columns+x]);
          high=Math.max(high,maxRows[j*columns+x]);
        }
        field[y*columns+x]=(high-low)/255*maxElevation;
      }
    }
    return field;
  }
  function smoothHeight(before,a,b,after,t){
    // A shared, monotone tangent at every sample preserves the source
    // heights and removes the lighting crease at the raster cell boundary.
    const delta=b-a;
    if(delta===0)return a;
    const left=a-before,right=after-b;
    const start=left*delta>0?2*left*delta/(left+delta):0;
    const end=delta*right>0?2*delta*right/(delta+right):0;
    return a+t*(start+t*(3*delta-2*start-end+t*(start+end-2*delta)));
  }
  function sampleHeight(data,width,height,x,y,wrapLongitude){
    const column=Math.floor(x),row=Math.floor(y),u=x-column,v=y-row;
    const limit=width-1;
    let a,b,c,d;
    if(wrapLongitude){
      b=column%width;a=(b+limit)%width;c=(b+1)%width;d=(b+2)%width;
    }else{
      b=column;a=Math.max(0,b-1);c=Math.min(limit,b+1);d=Math.min(limit,b+2);
    }
    const r0=Math.max(0,row-1)*width,r1=row*width;
    const r2=Math.min(height-1,row+1)*width,r3=Math.min(height-1,row+2)*width;
    return smoothHeight(
      smoothHeight(data[r0+a],data[r0+b],data[r0+c],data[r0+d],u),
      smoothHeight(data[r1+a],data[r1+b],data[r1+c],data[r1+d],u),
      smoothHeight(data[r2+a],data[r2+b],data[r2+c],data[r2+d],u),
      smoothHeight(data[r3+a],data[r3+b],data[r3+c],data[r3+d],u),v
    );
  }
  function globeSections(T,globe,cellSize){
    const {widthSegments:width,heightSegments:height}=globe.parameters;
    const stride=width+1,position=globe.attributes.position,indices=globe.index.array;
    const sections=[],point=new T.Vector3(),direction=new T.Vector3(),bounds=new T.Box3();
    let end=0;
    for(let y=0;y<height;y+=cellSize)for(let x=0;x<width;x+=cellSize){
      const right=Math.min(width,x+cellSize),bottom=Math.min(height,y+cellSize),start=end;
      const center=new T.Vector3().fromBufferAttribute(position,((y+bottom)>>1)*stride+((x+right)>>1)).normalize();
      let minDot=1;
      bounds.makeEmpty();
      for(let j=y;j<=bottom;j++)for(let i=x;i<=right;i++){
        point.fromBufferAttribute(position,j*stride+i);
        bounds.expandByPoint(point);
        minDot=Math.min(minDot,center.dot(direction.copy(point).normalize()));
      }
      for(let j=y;j<bottom;j++)for(let i=x;i<right;i++){
        const b=j*stride+i,a=b+1,c=b+stride,d=c+1;
        if(j>0){indices[end++]=a;indices[end++]=b;indices[end++]=d;}
        if(j<height-1){indices[end++]=b;indices[end++]=c;indices[end++]=d;}
      }
      const geometry=new T.BufferGeometry();
      for(const [name,attribute] of Object.entries(globe.attributes))geometry.setAttribute(name,attribute);
      geometry.setIndex(new T.BufferAttribute(indices.subarray(start,end),1));
      geometry.boundingSphere=bounds.getBoundingSphere(new T.Sphere());
      const cosRadius=Math.max(-1,minDot);
      const sinRadius=Math.sqrt(Math.max(0,1-cosRadius*cosRadius));
      sections.push({geometry,center,angularRadius:Math.acos(cosRadius),cosRadius,sinRadius});
    }
    return sections;
  }
  // A refinement of whole globe cells. The outer vertices are on the
  // original triangles, so the globe can omit those cells without a gap.
  function* buildRegionalPatch(T,globe,bounds,subdivisions,radius,sampleHeight){
    const {widthSegments:width,heightSegments:height}=globe.parameters;
    const source=globe.attributes.position,sourceNormals=globe.attributes.normal,stride=width+1;
    const {x,y,columns,rows}=bounds,cols=columns*subdivisions,rowCount=rows*subdivisions,step=cols+1;
    const count=step*(rowCount+1),positions=new Float32Array(count*3),normals=new Float32Array(count*3);
    const weights=new Float32Array(count),uvs=new Float32Array(count*2),indices=new Uint16Array(cols*rowCount*6);
    const center=new T.Vector3(),a=new T.Vector3(),b=new T.Vector3(),c=new T.Vector3(),point=new T.Vector3(),direction=new T.Vector3();
    const midRow=Math.round(y+rows*.5),midCol=((Math.round(x+columns*.5)%width)+width)%width;
    center.fromBufferAttribute(source,midRow*stride+midCol);
    const interpolate=(attribute,i,j,k,u,v,out)=>{
      a.fromBufferAttribute(attribute,i);b.fromBufferAttribute(attribute,j);c.fromBufferAttribute(attribute,k);
      return out.copy(a).multiplyScalar(1-u-v).addScaledVector(b,u).addScaledVector(c,v);
    };
    for(let row=0;row<=rowCount;row++){
      const iy=Math.min(rows-1,Math.floor(row/subdivisions)),v=row/subdivisions-iy;
      for(let col=0;col<=cols;col++){
        const ix=Math.min(columns-1,Math.floor(col/subdivisions)),u=col/subdivisions-ix;
        const gridCol=((x+ix)%width+width)%width,i=(y+iy)*stride+gridCol,d=i+stride+1;
        const other=u>=v?i+1:i+stride;
        const edgeWeight=Math.min(1,Math.min(row,col,rowCount-row,cols-col)/subdivisions);
        const weight=edgeWeight*edgeWeight*(3-2*edgeWeight),index=row*step+col;
        interpolate(source,i,other,d,Math.abs(u-v),Math.min(u,v),point);
        if(weight>0){
          direction.copy(point).normalize();
          point.lerp(direction.multiplyScalar(radius+sampleHeight(direction)),weight);
        }
        point.sub(center).toArray(positions,index*3);
        interpolate(sourceNormals,i,other,d,Math.abs(u-v),Math.min(u,v),point).normalize().toArray(normals,index*3);
        weights[index]=weight;
        uvs[index*2]=(x+col/subdivisions)/width;
        uvs[index*2+1]=1-(y+row/subdivisions)/height;
        if(row<rowCount&&col<cols){
          const k=(row*cols+col)*6,n=index+step;
          indices[k]=index+1;indices[k+1]=index;indices[k+2]=n+1;
          indices[k+3]=index;indices[k+4]=n;indices[k+5]=n+1;
        }
      }
      yield;
    }
    for(let row=1;row<rowCount;row++){
      for(let col=1;col<cols;col++){
        const i=row*step+col;
        a.fromArray(positions,(i+1)*3).sub(b.fromArray(positions,(i-1)*3));
        b.fromArray(positions,(i+step)*3).sub(c.fromArray(positions,(i-step)*3));
        point.crossVectors(b,a).normalize();
        direction.fromArray(normals,i*3).lerp(point,weights[i]).normalize().toArray(normals,i*3);
      }
      yield;
    }
    const geometry=new T.BufferGeometry();
    geometry.setAttribute('position',new T.BufferAttribute(positions,3));
    geometry.setAttribute('uv',new T.BufferAttribute(uvs,2));
    geometry.setAttribute('normal',new T.BufferAttribute(normals,3));
    geometry.setIndex(new T.BufferAttribute(indices,1));
    geometry.computeBoundingSphere();
    return {geometry,center};
  }
  class RegionalTerrainBudget{
    constructor(){this.tier=0;this.stress=0;this.headroom=0;}
    update(dt,frameMs,limit){
      this.tier=Math.min(this.tier,limit);
      // The smallest patch adds one draw and very few triangles, so keep
      // it as the fallback while the renderer adjusts resolution.
      this.stress=this.tier>0&&frameMs>18.4?this.stress+dt:0;
      this.headroom=frameMs<17.3?this.headroom+dt:0;
      if(this.stress>=.85){
        this.tier--;this.stress=0;
      }else if(this.headroom>=3&&this.tier<limit){
        this.tier++;this.headroom=0;
      }
      return this.tier;
    }
  }
  class TerrainSurface{
    constructor(T,radius,sampleRadius){
      this.T=T;this.radius=radius;this.sampleRadius=sampleRadius;
      this.east=new T.Vector3();this.north=new T.Vector3();
      this.a=new T.Vector3();this.b=new T.Vector3();this.center=new T.Vector3();
      this.contactRay=new T.Ray();this.contactHit=new T.Vector3();
    }
    tileRadius(tile,u,v,direction){
      const N=tile.N,S=N-1,position=tile.mesh.geometry.attributes.position;
      const i=Math.max(0,Math.min(S-1,Math.floor(u*S)));
      const j=Math.max(0,Math.min(S-1,Math.floor(v*S))),a=j*N+i;
      const ray=this.contactRay;
      ray.origin.copy(tile.center).multiplyScalar(-tile.anchor).applyQuaternion(tile.qi);
      ray.direction.copy(direction).applyQuaternion(tile.qi);
      if(this.intersectTileCell(position,a,N))return this.contactHit.distanceTo(ray.origin);
      // At a shared edge the geographic cell and the triangle hit can
      // differ by one vertex because the rendered surface is planar.
      for(let y=Math.max(0,j-1);y<=Math.min(S-1,j+1);y++)for(let x=Math.max(0,i-1);x<=Math.min(S-1,i+1);x++){
        if((x!==i||y!==j)&&this.intersectTileCell(position,y*N+x,N))return this.contactHit.distanceTo(ray.origin);
      }
      return null;
    }
    intersectTileCell(position,a,N){
      const ray=this.contactRay;
      this.a.fromBufferAttribute(position,a);
      this.b.fromBufferAttribute(position,a+1);
      this.center.fromBufferAttribute(position,a+N);
      if(ray.intersectTriangle(this.a,this.b,this.center,false,this.contactHit))return true;
      this.a.fromBufferAttribute(position,a+N+1);
      return ray.intersectTriangle(this.b,this.a,this.center,false,this.contactHit)!==null;
    }
    normal(direction,radius,out){
      // The same physical sampling distance on every tile and LOD. Never
      // flatten a border or derive its slope from a one-sided triangle fan.
      const step=1.5/this.radius;
      this.east.set(direction.z,0,-direction.x);
      if(this.east.lengthSq()<1e-12)this.east.set(0,0,1);
      this.east.normalize();this.north.crossVectors(direction,this.east).normalize();
      this.center.copy(direction).multiplyScalar(radius);
      this.a.copy(direction).addScaledVector(this.east,step).normalize();
      this.a.multiplyScalar(this.sampleRadius(this.a)).sub(this.center);
      this.b.copy(direction).addScaledVector(this.north,step).normalize();
      this.b.multiplyScalar(this.sampleRadius(this.b)).sub(this.center);
      return out.crossVectors(this.a,this.b).normalize();
    }
    stitch(tile,steps,force=false){
      const key=steps.join(':'),geo=tile.mesh.geometry,S=tile.N-1,N=tile.N;
      if(tile.stitchKey===key&&!force)return;
      tile.stitchKey=key;tile.stitchSteps=steps.slice();
      if(steps.every(step=>step===1)&&!tile.surfaceBase){
        if(force)this.refreshSkirt(tile);
        return;
      }
      const names=['position','normal','color','earthGround','earthDirection','earthCoast','earthMeltStrength','earthMeltBirth'];
      const base=tile.surfaceBase||(tile.surfaceBase={});
      for(const name of names){
        const attr=geo.attributes[name];
        if(!base[name]||(force&&!['color','earthDirection','earthCoast'].includes(name)))base[name]=attr.array.slice();
        else attr.array.set(base[name]);
      }
      // Ease the fine surface into the neighbouring coarse shape over two
      // coarse cells. An edge-only fix closes a crack but leaves a visible
      // change in detail immediately inside the boundary.
      const bands=steps.map(step=>step>1?step*2:0);
      for(let j=0;j<N;j++)for(let i=0;i<N;i++){
        if(i>=bands[0]&&S-i>=bands[1]&&j>=bands[2]&&S-j>=bands[3])continue;
        const distances=[i,S-i,j,S-j];let step=1,weight=0;
        for(let e=0;e<4;e++)if(steps[e]>1&&distances[e]<steps[e]*2){
          const t=distances[e]/(steps[e]*2),w=1-t*t*(3-2*t);
          if(w>weight){step=steps[e];weight=w;}
        }
        // Each border must retain its own neighbour's exact sampling, even
        // where a different LOD transition approaches from the other side.
        for(let e=0;e<4;e++)if(distances[e]===0){step=steps[e];weight=step>1?1:0;break;}
        if(weight===0)continue;
        const x=Math.min(S-step,Math.floor(i/step)*step),y=Math.min(S-step,Math.floor(j/step)*step);
        const u=(i-x)/step,v=(j-y)/step,a=y*N+x,b=a+step,c=a+step*N,d=c+step;
        const first=u+v<=1,index=j*N+i;
        for(const name of names){
          const attr=geo.attributes[name],size=attr.itemSize,values=base[name];
          for(let k=0;k<size;k++){
            const coarse=first?values[a*size+k]*(1-u-v)+values[b*size+k]*u+values[c*size+k]*v:
              values[b*size+k]*(1-v)+values[c*size+k]*(1-u)+values[d*size+k]*(u+v-1);
            attr.array[index*size+k]=values[index*size+k]*(1-weight)+coarse*weight;
          }
        }
        const n=geo.attributes.normal;this.a.fromBufferAttribute(n,index).normalize();n.setXYZ(index,this.a.x,this.a.y,this.a.z);
      }
      for(const name of names)geo.attributes[name].needsUpdate=true;
      if(tile.waterMesh){
        const depth=tile.waterMesh.geometry.attributes.earthWaterDepth,ground=geo.attributes.earthGround;
        for(let i=0;i<depth.count;i++)depth.setX(i,tile.waterLevels[i]-ground.getW(i));
        depth.needsUpdate=true;
      }
      geo.computeBoundingSphere();this.refreshSkirt(tile);
    }
    refreshSkirt(tile){
      const surface=tile.mesh.geometry.attributes,skirt=tile.skirtMesh.geometry.attributes;
      for(let e=0;e<tile.perimeter.length;e++){
        const i=tile.perimeter[e];
        const dst=e*2,p=surface.position,n=surface.normal,c=surface.color;
        // The cover follows the stitched edge too; unused fine vertices must
        // not leave a fence sticking up through a coarser neighbour.
        const i3=i*3;
        const x=tile.localDirs[i3],y=tile.localDirs[i3+1],z=tile.localDirs[i3+2];
        this.a.set(x,y,z).applyQuaternion(tile.qi).normalize();
        skirt.position.setXYZ(dst,p.getX(i),p.getY(i),p.getZ(i));
        skirt.position.setXYZ(dst+1,p.getX(i)-this.a.x*tile.skirtDepth,p.getY(i)-this.a.y*tile.skirtDepth,p.getZ(i)-this.a.z*tile.skirtDepth);
        for(let k=dst;k<=dst+1;k++){
          skirt.normal.setXYZ(k,n.getX(i),n.getY(i),n.getZ(i));
          skirt.color.setXYZ(k,c.getX(i),c.getY(i),c.getZ(i));
          const ground=surface.earthGround;
          skirt.earthGround.setXYZW(k,ground.getX(i),ground.getY(i),ground.getZ(i),ground.getW(i));
          const direction=surface.earthDirection;
          skirt.earthDirection.setXYZ(k,direction.getX(i),direction.getY(i),direction.getZ(i));
          const coast=surface.earthCoast;
          skirt.earthCoast.setXYZW(k,coast.getX(i),coast.getY(i),coast.getZ(i),coast.getW(i));
          skirt.earthMeltStrength.setX(k,surface.earthMeltStrength.getX(i));
          skirt.earthMeltBirth.setX(k,surface.earthMeltBirth.getX(i));
        }
      }
      for(const attr of Object.values(skirt))attr.needsUpdate=true;
      tile.skirtMesh.geometry.computeBoundingSphere();
    }
  }
  TerrainSurface.coveredCapChordSq=coveredCapChordSq;
  TerrainSurface.coastField=coastField;
  TerrainSurface.coastDistance=coastDistance;
  TerrainSurface.coastElevation=coastElevation;
  TerrainSurface.sampleHeight=sampleHeight;
  TerrainSurface.ruggednessField=ruggednessField;
  TerrainSurface.globeSections=globeSections;
  TerrainSurface.buildRegionalPatch=buildRegionalPatch;
  TerrainSurface.RegionalTerrainBudget=RegionalTerrainBudget;
  g.GodmanTerrainSurface=TerrainSurface;
})(typeof window==='undefined'?globalThis:window);
