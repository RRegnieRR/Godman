(function () {
  'use strict';

  class AdaptiveQualityController {
    constructor(renderer, options, onResolutionChange) {
      this.renderer = renderer;
      this.options = options;
      this.onResolutionChange = onResolutionChange;
      this.pixelRatio = Math.min(devicePixelRatio || 1, options.maxPixelRatio);
      this.frameEma = options.targetFrameMs;
      this.sampleTime = 0;
      this.recoveryTime = 0;
      this.userMax = options.maxPixelRatio;
      renderer.setPixelRatio(this.pixelRatio);
    }

    setPreference(maxPixelRatio) {
      this.userMax = Math.max(this.options.minPixelRatio, maxPixelRatio);
      const next = Math.min(this.pixelRatio, this.userMax, this.options.maxPixelRatio);
      if (Math.abs(next - this.pixelRatio) < 0.01) return;
      this.pixelRatio = next;
      this.renderer.setPixelRatio(next);
      if (this.onResolutionChange) this.onResolutionChange(next);
    }

    sample(dt) {
      const frameMs = Math.min(50, dt * 1000);
      this.frameEma += (frameMs - this.frameEma) * 0.035;
      this.sampleTime += dt;

      if (this.frameEma < this.options.recoveryFrameMs) this.recoveryTime += dt;
      else this.recoveryTime = Math.max(0, this.recoveryTime - dt * 2);

      if (this.sampleTime < 1.4) return;
      this.sampleTime = 0;

      let next = this.pixelRatio;
      if (this.frameEma > this.options.lowerFrameMs) {
        next = Math.max(this.options.minPixelRatio, this.pixelRatio - 0.15);
        this.recoveryTime = 0;
      } else if (this.recoveryTime > 7) {
        next = Math.min(Math.min(devicePixelRatio || 1, this.options.maxPixelRatio, this.userMax), this.pixelRatio + 0.1);
        this.recoveryTime = 0;
      }

      if (Math.abs(next - this.pixelRatio) < 0.01) return;
      this.pixelRatio = next;
      this.renderer.setPixelRatio(next);
      if (this.onResolutionChange) this.onResolutionChange(next);
    }
  }

  window.GodmanAdaptiveQuality = AdaptiveQualityController;
})();
