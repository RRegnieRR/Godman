(function () {
  'use strict';

  window.GODMAN_CONFIG = Object.freeze({
    renderer: Object.freeze({
      maxPixelRatio: 2.25,
      minPixelRatio: 0.75,
      targetFrameMs: 1000 / 60,
      lowerFrameMs: 17.8,
      recoveryFrameMs: 16.95
    }),
    atmosphere: Object.freeze({
      surfaceFogDensity: 0.00016,
      mountainFogDensity: 0.00029,
      fadeAltitudeRatio: 0.018
    }),
    terrain: Object.freeze({
      defaultRadius: 5,
      minRadius: 3,
      maxRadius: 7
    }),
    lighting: Object.freeze({
      baseExposure: 0.82,
      minExposure: 0.38,
      maxExposure: 1.32,
      maxRelativeIrradiance: 18
    })
  });
})();
