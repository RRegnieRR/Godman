/* Continuous height-field lighting and exact edges between terrain LODs. */
(function(g){
  'use strict';
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
      const names=['position','normal','color','earthMeltStrength','earthMeltBirth'];
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
          skirt.earthMeltStrength.setX(k,surface.earthMeltStrength.getX(i));
          skirt.earthMeltBirth.setX(k,surface.earthMeltBirth.getX(i));
        }
      }
      for(const attr of Object.values(skirt))attr.needsUpdate=true;
      tile.skirtMesh.geometry.computeBoundingSphere();
    }
  }
  g.GodmanTerrainSurface=TerrainSurface;
})(typeof window==='undefined'?globalThis:window);
