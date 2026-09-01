(function () {
  'use strict';

  class SurfaceTraces {
    constructor(THREE, parent) {
      this.THREE = THREE;
      this.group = new THREE.Group();
      this.group.name = 'Earth surface traces';
      parent.add(this.group);
      this.traces = [];
      this.footGeometry = new THREE.PlaneGeometry(0.24, 0.58, 1, 1);
      this.landingGeometry = new THREE.RingGeometry(0.28, 0.38, 28);
      this.rotation = new THREE.Matrix4();
      this.right = new THREE.Vector3();
      this.forward = new THREE.Vector3();
    }

    orient(mesh, direction, forward) {
      this.forward.copy(forward).addScaledVector(direction, -forward.dot(direction));
      if (this.forward.lengthSq() < 1e-8) this.forward.set(0, 1, 0).cross(direction);
      this.forward.normalize();
      this.right.crossVectors(this.forward, direction).normalize();
      this.rotation.makeBasis(this.right, this.forward, direction);
      mesh.quaternion.setFromRotationMatrix(this.rotation);
    }

    addFootprint(direction, forward, radius, time, side) {
      const material = new this.THREE.MeshBasicMaterial({
        color: 0x181b1c, transparent: true, opacity: 0.22,
        depthWrite: false, side: this.THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2
      });
      const mesh = new this.THREE.Mesh(this.footGeometry, material);
      this.orient(mesh, direction, forward);
      mesh.position.copy(direction).multiplyScalar(radius + 0.055);
      mesh.rotateZ(side * 0.045);
      mesh.renderOrder = 6;
      this.group.add(mesh);
      this.traces.push({mesh:mesh,born:time,life:32,type:'foot'});
      this.trim();
    }

    addLanding(direction, forward, radius, time, strength) {
      const material = new this.THREE.MeshBasicMaterial({
        color: 0x6d6253, transparent: true, opacity: 0.26 * Math.min(1, strength),
        depthWrite: false, side: this.THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3
      });
      const mesh = new this.THREE.Mesh(this.landingGeometry, material);
      this.orient(mesh, direction, forward);
      mesh.position.copy(direction).multiplyScalar(radius + 0.07);
      mesh.renderOrder = 6;
      this.group.add(mesh);
      this.traces.push({mesh:mesh,born:time,life:4.5,type:'landing',strength:Math.min(1,strength)});
      this.trim();
    }

    trim() {
      while (this.traces.length > 48) this.remove(this.traces.shift());
    }

    remove(trace) {
      this.group.remove(trace.mesh);
      trace.mesh.material.dispose();
    }

    update(time, visible) {
      this.group.visible = visible;
      for (let i = this.traces.length - 1; i >= 0; i--) {
        const trace = this.traces[i], age = time - trace.born, t = age / trace.life;
        if (t >= 1) {
          this.remove(trace);
          this.traces.splice(i, 1);
          continue;
        }
        if (trace.type === 'landing') {
          const scale = 1 + Math.min(1, age * 2.2) * (2.1 + trace.strength * 1.6);
          trace.mesh.scale.setScalar(scale);
          trace.mesh.material.opacity = (1 - t) * 0.22 * trace.strength;
        } else {
          trace.mesh.material.opacity = 0.22 * Math.min(1, age * 8) * Math.pow(1 - t, 1.6);
        }
      }
    }
  }

  window.GodmanSurfaceTraces = SurfaceTraces;
})();
