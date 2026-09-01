(function () {
  'use strict';

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  // Converts a stellar effective temperature to an approximate visible RGB.
  // The scene still uses artistic exposure adaptation, but illumination ratios
  // follow inverse-square irradiance and each star's estimated luminosity.
  function blackbodyRgb(THREE, kelvin, out) {
    const t = clamp(kelvin || 5772, 1000, 40000) / 100;
    let r, g, b;
    if (t <= 66) {
      r = 255;
      g = 99.4708025861 * Math.log(t) - 161.1195681661;
      b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
    } else {
      r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
      g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
      b = 255;
    }
    out.setRGB(clamp(r, 0, 255) / 255, clamp(g, 0, 255) / 255, clamp(b, 0, 255) / 255);
    return out;
  }

  class PhysicalLighting {
    constructor(THREE, renderer, config, lights) {
      this.THREE = THREE;
      this.renderer = renderer;
      this.config = config;
      this.lights = lights;
      this.starColor = new THREE.Color(1, 0.95, 0.86);
      this.horizonColor = new THREE.Color(1, 0.42, 0.16);
    }

    update(state) {
      const star = state.star || {};
      const auDistance = Math.max(0.015, state.distance / state.au);
      const luminosity = Math.max(0.0001, star.luminosity || 1);
      const irradiance = clamp(luminosity / (auDistance * auDistance), 0.00005, this.config.maxRelativeIrradiance);
      const perceivedDirect = clamp(Math.pow(irradiance, 0.36), 0.035, 3.0);
      const eyeAdaptation = 1 / Math.pow(Math.max(0.06, irradiance), 0.18);
      const targetExposure = clamp(
        this.config.baseExposure * eyeAdaptation * (0.94 + state.skyFactor * 0.08),
        this.config.minExposure,
        this.config.maxExposure
      );
      const blend = 1 - Math.exp(-state.dt * 2.4);
      this.renderer.toneMappingExposure += (targetExposure - this.renderer.toneMappingExposure) * blend;

      blackbodyRgb(this.THREE, star.temperature || 5772, this.starColor);
      const horizonWarmth = state.nearAtmosphere * clamp(1 - Math.abs(state.sunHeight) * 3.5, 0, 1);
      this.starColor.lerp(this.horizonColor, horizonWarmth * 0.42);

      const eclipse = state.eclipse == null ? 1 : clamp(state.eclipse, 0, 1);
      const directVisibility = (state.nearAtmosphere ? 0.045 + 0.955 * state.directDay : 1) * eclipse;
      this.lights.key.color.copy(this.starColor);
      this.lights.key.intensity = perceivedDirect * directVisibility * 1.18;
      this.lights.ambient.intensity = 0.018 + 0.12 * state.skyFactor;
      this.lights.sky.intensity = 0.008 + 0.34 * state.skyFactor;
      this.lights.rim.color.copy(this.starColor).lerp(this.lights.sky.color, 0.78);
      this.lights.rim.intensity = state.nearAtmosphere ? 0.025 + 0.16 * state.skyFactor : 0.035;
      this.lights.headlamp.intensity = state.nearAtmosphere ? 0.06 + 0.52 * (1 - state.directDay) : 0.24;
      return irradiance;
    }
  }

  window.GodmanPhysicalLighting = PhysicalLighting;
  window.GodmanBlackbodyRgb = function (THREE, kelvin, out) {
    return blackbodyRgb(THREE, kelvin, out || new THREE.Color());
  };
})();
