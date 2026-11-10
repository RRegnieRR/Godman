/* Continuous height-field lighting and exact edges between terrain LODs. */
(function(g){
  'use strict';
  function coveredCapCos(latitude, longitudeSpan, south, north, margin){
    // The meridian edge is closer than its longitude offset, especially
    // near the poles. Limit the cap to the complete streamed rectangle.
    const eastWest=Math.asin(Math.cos(latitude)*Math.sin(Math.min(Math.PI*.5,longitudeSpan)));
    const southEdge=south<=-Math.PI*.5?Infinity:latitude-south;
    const northEdge=north>=Math.PI*.5?Infinity:north-latitude;
    const radius=Math.min(eastWest,southEdge,northEdge)-margin;
    return radius>0?Math.cos(radius):2;
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
      sections.push({geometry,center,angularRadius:Math.acos(Math.max(-1,minDot))});
    }
    return sections;
  }
  class TerrainSurface{
    constructor(T,radius,sampleRadius){
      this.T=T;this.radius=radius;this.sampleRadius=sampleRadius;
      this.east=new T.Vector3();this.north=new T.Vector3();
      this.a=new T.Vector3();this.b=new T.Vector3();this.center=new T.Vector3();
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
      if(steps.every(step=>step===1)&&!tile.surfaceBase){this.refreshSkirt(tile);return;}
      const names=['position','normal','color','earthGround','earthMeltStrength','earthMeltBirth'];
      const base=tile.surfaceBase||(tile.surfaceBase={});
      for(const name of names){
        const attr=geo.attributes[name];
        if(!base[name]||(force&&name!=='color'))base[name]=attr.array.slice();
        attr.array.set(base[name]);
      }
      // Ease the fine surface into the neighbouring coarse shape over two
      // coarse cells. An edge-only fix closes a crack but leaves a visible
      // change in detail immediately inside the boundary.
      for(let j=0;j<N;j++)for(let i=0;i<N;i++){
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
      geo.computeBoundingSphere();this.refreshSkirt(tile);
    }
    refreshSkirt(tile){
      const surface=tile.mesh.geometry.attributes,skirt=tile.skirtMesh.geometry.attributes;
      for(let e=0;e<tile.perimeter.length;e++){
        const i=tile.perimeter[e];
        const dst=e*2,p=surface.position,n=surface.normal,c=surface.color;
        // The cover follows the stitched edge too; unused fine vertices must
        // not leave a fence sticking up through a coarser neighbour.
        const radial=tile.skirtRadials,i3=i*3;
        const x=tile.localDirs[i3],y=tile.localDirs[i3+1],z=tile.localDirs[i3+2];
        this.a.set(x,y,z).applyQuaternion(tile.qi).normalize();
        radial[e*3]=this.a.x;radial[e*3+1]=this.a.y;radial[e*3+2]=this.a.z;
        skirt.position.setXYZ(dst,p.getX(i),p.getY(i),p.getZ(i));
        skirt.position.setXYZ(dst+1,p.getX(i)-this.a.x*tile.skirtDepth,p.getY(i)-this.a.y*tile.skirtDepth,p.getZ(i)-this.a.z*tile.skirtDepth);
        for(const k of [dst,dst+1]){
          skirt.normal.setXYZ(k,n.getX(i),n.getY(i),n.getZ(i));
          skirt.color.setXYZ(k,c.getX(i),c.getY(i),c.getZ(i));
          const ground=surface.earthGround;
          skirt.earthGround.setXYZW(k,ground.getX(i),ground.getY(i),ground.getZ(i),ground.getW(i));
          skirt.earthMeltStrength.setX(k,surface.earthMeltStrength.getX(i));
          skirt.earthMeltBirth.setX(k,surface.earthMeltBirth.getX(i));
        }
      }
      for(const attr of Object.values(skirt))attr.needsUpdate=true;
      tile.skirtMesh.geometry.computeBoundingSphere();
    }
  }
  TerrainSurface.coveredCapCos=coveredCapCos;
  TerrainSurface.sampleHeight=sampleHeight;
  TerrainSurface.globeSections=globeSections;
  g.GodmanTerrainSurface=TerrainSurface;
})(typeof window==='undefined'?globalThis:window);
