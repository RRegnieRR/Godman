(function () {
  'use strict';

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function smooth(min,max,value) {
    const x = clamp((value - min) / (max - min), 0, 1);
    return x * x * (3 - 2 * x);
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
    static earthAirColumn(sunHeight,altitude,planetRadius) {
      const height = clamp(sunHeight, 0, 1);
      const elevation = Math.asin(height) * 180 / Math.PI;
      // Kasten–Young optical air mass at the horizon, adjusted for the
      // remaining air above the observer or above a grazing ray.
      const airMass = 1 / (height + 0.50572 * Math.pow(elevation + 6.07995, -1.6364));
      const grazingDrop = sunHeight < 0
        ? (planetRadius + altitude) * sunHeight * sunHeight / (1 + Math.sqrt(1 - sunHeight * sunHeight))
        : 0;
      const column = Math.exp(-Math.max(0, altitude - grazingDrop) / 8000);
      return Math.max(0, airMass - 1) * column;
    }

    static horizonAngle(height,clearance,radius) {
      const depression = Math.acos(radius / (radius + Math.max(0,clearance)));
      return Math.asin(clamp(height,-1,1)) + depression;
    }

    static earthSunVisibility(height,clearance,radius,angularRadius) {
      const angle = PhysicalLighting.horizonAngle(height,clearance,radius);
      const upperAir = smooth(0,.015,clearance/radius);
      const lowerEdge = .014 + (angularRadius - .014) * upperAir;
      const upperEdge = .028 + (angularRadius - .028) * upperAir;
      return smooth(-lowerEdge,upperEdge,angle);
    }

    static lunarIrradiance(phaseCosine,horizonAngle,distanceRatio,daylight,eclipse) {
      const cosine = clamp(phaseCosine,-1,1);
      const angle = Math.acos(cosine);
      const phase = (Math.sin(angle) + (Math.PI - angle) * cosine) / Math.PI;
      const aboveHorizon = smooth(0,.10,horizonAngle);
      const twilight = 1 - smooth(.01,.15,daylight);
      return Math.max(0,phase) * aboveHorizon * twilight * eclipse /
        Math.max(.6,distanceRatio * distanceRatio);
    }

    static earthTwilight(sunHeight) {
      return smooth(-.16, -.06,sunHeight) * (1 - smooth(.01, .18,sunHeight));
    }

    constructor(THREE, renderer, config, lights) {
      this.THREE = THREE;
      this.renderer = renderer;
      this.config = config;
      this.lights = lights;
      this.starColor = new THREE.Color(1, 0.95, 0.86);
      this.horizonColor = new THREE.Color(1, 0.42, 0.16);
      this.twilightSkyColor = new THREE.Color(1, 0.78, 0.68);
      this.daySkyColor = new THREE.Color(0.81, 0.89, 1);
      this.defaultBounce = lights.sky.groundColor.clone();
      this.bounce = new THREE.Color();
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
      const twilight = state.twilight || 0;
      let transmission = 1;
      if (state.earth) {
        const column = PhysicalLighting.earthAirColumn(state.sunHeight, state.altitude, state.planetRadius);
        // Keep zenith light calibrated to the current daylight exposure.
        // The longer optical path preferentially removes shorter wavelengths.
        transmission = Math.exp(-column * 0.019);
        this.starColor.g *= Math.exp(-column * 0.025);
        this.starColor.b *= Math.exp(-column * 0.056);
      } else {
        const horizonWarmth = state.nearAtmosphere * clamp(1 - Math.abs(state.sunHeight) * 3.5, 0, 1);
        this.starColor.lerp(this.horizonColor, horizonWarmth * (0.42 + 0.22 * twilight));
      }

      const eclipse = state.eclipse == null ? 1 : clamp(state.eclipse, 0, 1);
      const directVisibility = (state.surface || state.nearAtmosphere ? state.directDay : 1) * eclipse;
      this.lights.key.color.copy(this.starColor);
      this.lights.key.intensity = perceivedDirect * directVisibility * transmission * 1.18;
      this.lights.ambient.intensity = 0.018 + 0.12 * state.skyFactor;
      if (state.skyTint != null) {
        this.lights.sky.color.setHex(state.skyTint);
        if (state.earth) this.lights.sky.color.lerp(this.daySkyColor, (1 - twilight) * 0.24);
        this.lights.sky.color.lerp(this.twilightSkyColor, twilight * 0.88);
      }
      this.bounce.copy(this.defaultBounce);
      if (state.earth && state.groundAlbedo) {
        // A small amount of nearby ground color reaches downward-facing
        // surfaces through the lower half of the existing hemisphere light.
        const bounceWeight = 0.34 * state.skyFactor;
        this.bounce.lerp(state.groundAlbedo, bounceWeight);
        this.bounce.lerp(this.starColor, 0.12 * twilight * directVisibility);
      }
      this.lights.sky.groundColor.copy(this.bounce);
      this.lights.sky.intensity = 0.008 + 0.34 * state.skyFactor;
      if(this.lights.rim)this.lights.rim.intensity=0;
      const directLight = perceivedDirect * directVisibility * transmission;
      const availableLight = state.earth ? Math.max(directLight, state.skyFactor * 0.88) : directLight;
      const darkness = 1 - clamp(availableLight, 0, 1);
      const lampTarget=4.5*darkness*darkness;
      this.lights.headlamp.intensity+=(lampTarget-this.lights.headlamp.intensity)*(1-Math.exp(-state.dt*5));
      return irradiance;
    }
  }

  window.GodmanPhysicalLighting = PhysicalLighting;
  window.GodmanBlackbodyRgb = function (THREE, kelvin, out) {
    return blackbodyRgb(THREE, kelvin, out || new THREE.Color());
  };
})();
