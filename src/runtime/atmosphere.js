(function () {
  'use strict';

  class SurfaceAtmosphere {
    constructor(THREE, scene, options) {
      this.THREE = THREE;
      this.scene = scene;
      this.options = options;
      this.fog = new THREE.FogExp2(0x080d16, 0);
      this.color = new THREE.Color();
      this.base = new THREE.Color();
    }

    update(state) {
      if (!state.enabled) {
        if (this.scene.fog === this.fog) this.scene.fog = null;
        return;
      }

      const altitudeFade = Math.max(0, Math.min(1,
        1 - state.altitude / Math.max(1, state.fadeHeight || state.bodyRadius * this.options.fadeAltitudeRatio)));
      const haze = altitudeFade * (0.32 + state.skyFactor * 0.68);
      const density = this.options.surfaceFogDensity +
        (this.options.mountainFogDensity - this.options.surfaceFogDensity) * state.skyFactor;

      this.base.setHex(state.atmosphereColor || 0x6dafff);
      this.color.setRGB(0.012, 0.018, 0.03)
        .lerp(this.base.multiplyScalar(0.74 + state.daylight * 0.2), state.daylight);
      this.fog.color.copy(this.color);
      this.fog.density = density * haze;
      this.scene.fog = this.fog;
    }
  }

  window.GodmanSurfaceAtmosphere = SurfaceAtmosphere;
})();
