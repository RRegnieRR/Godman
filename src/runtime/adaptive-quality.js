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
      const frameMs = Math.min(100, dt * 1000);
      const sampleSeconds = frameMs / 1000;
      this.frameEma += (frameMs - this.frameEma) * (1 - Math.exp(-sampleSeconds * 3));
      this.sampleTime += sampleSeconds;

      if (this.frameEma < this.options.recoveryFrameMs) this.recoveryTime += sampleSeconds;
      else this.recoveryTime = Math.max(0, this.recoveryTime - sampleSeconds * 2);

      if (this.sampleTime < 0.75) return;
      this.sampleTime = 0;

      let next = this.pixelRatio;
      if (this.frameEma > this.options.lowerFrameMs) {
        // Pixel work grows with the square of the resolution. Use the
        // measured frame budget to choose one bounded step out of overload.
        const scale=Math.max(.76,Math.sqrt(this.options.targetFrameMs/this.frameEma));
        next = Math.max(this.options.minPixelRatio, this.pixelRatio * scale);
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
