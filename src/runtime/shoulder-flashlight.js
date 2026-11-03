(function(g){
  'use strict';
  class ShoulderFlashlight{
    constructor(T,scene){
      this.T=T;this.scene=scene;this.shadowEnabled=false;
      this.mount=new T.Group();this.mount.name='Shoulder flashlight mount';
      this.head=new T.Group();this.mount.add(this.head);
      const housing=new T.MeshStandardMaterial({color:0x28313a,metalness:.55,roughness:.48});
      const body=new T.Mesh(new T.CylinderGeometry(.105,.115,.19,16),housing);body.rotation.x=Math.PI/2;this.head.add(body);
      const bracket=new T.Mesh(new T.BoxGeometry(.23,.07,.14),housing);bracket.position.y=-.10;this.mount.add(bracket);
      this.lens=new T.Mesh(new T.CircleGeometry(.083,20),new T.MeshBasicMaterial({color:0xdcefff}));
      this.lens.position.z=.099;this.head.add(this.lens);
      this.light=new T.SpotLight(0xe5f1ff,0,42,Math.PI/7,.5,2);
      this.light.name='Shoulder flashlight';this.target=new T.Object3D();this.light.target=this.target;
      this.light.shadow.mapSize.set(512,512);this.light.shadow.camera.near=.08;
      this.light.shadow.bias=-.00015;this.light.shadow.normalBias=.025;
      scene.add(this.light,this.target);
      this.direction=new T.Vector3(0,0,-1);this.q=new T.Quaternion();this.inverse=new T.Quaternion();this.axis=new T.Vector3(0,0,1);
    }
    attach(frame,bones){
      if(this.mount.parent)this.mount.parent.remove(this.mount);
      frame.add(this.mount);this.mount.scale.set(1,1,1);this.mount.quaternion.identity();
      const shoulder=bones&&Object.values(bones).find(b=>b&&/^R_Arm(?:[._]|\d)/.test(b.name));
      if(shoulder){
        frame.worldToLocal(shoulder.getWorldPosition(this.mount.position));
        this.mount.position.y+=.15;this.mount.position.z+=.26;
        frame.updateWorldMatrix(true,true);
        // Preserve fitted suit units while following the clavicle rather than
        // the swinging upper arm. No assumptions about imported bone axes.
        shoulder.parent.attach(this.mount);
      }else{
        this.mount.position.set(.35,1.45,-.18);this.mount.rotation.y=Math.PI;
      }
    }
    setQuality(quality){
      this.shadowEnabled=quality>=1.5;
      const size=quality>=2.2?1024:512;
      if(this.light.shadow.mapSize.x!==size){
        this.light.shadow.mapSize.set(size,size);
        if(this.light.shadow.map){this.light.shadow.map.dispose();this.light.shadow.map=null;}
      }
    }
    update(aim){
      if(!this.mount.parent){this.light.intensity=0;return;}
      if(aim.lengthSq()>1e-8)this.direction.copy(aim).normalize();
      this.mount.updateWorldMatrix(true,true);
      this.mount.getWorldQuaternion(this.inverse).invert();
      this.q.setFromUnitVectors(this.axis,this.direction);this.head.quaternion.copy(this.inverse).multiply(this.q);
      this.head.updateWorldMatrix(false,true);this.lens.getWorldPosition(this.light.position);
      this.target.position.copy(this.light.position).addScaledVector(this.direction,30);
      this.light.castShadow=this.shadowEnabled&&this.light.intensity>.02;
      this.lens.visible=this.light.intensity>.02;
    }
    dispose(){
      if(this.mount.parent)this.mount.parent.remove(this.mount);this.scene.remove(this.light,this.target);
      const materials=new Set();this.mount.traverse(o=>{if(o.geometry)o.geometry.dispose();if(o.material)materials.add(o.material);});
      for(const material of materials)material.dispose();
      if(this.light.shadow.map)this.light.shadow.map.dispose();
    }
  }
  g.GodmanShoulderFlashlight=ShoulderFlashlight;
})(typeof window==='undefined'?globalThis:window);
