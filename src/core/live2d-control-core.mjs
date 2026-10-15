import { ExpressionType, ParameterId, createExpressionData } from "./expression-data.mjs";

export { ExpressionType, ParameterId } from "./expression-data.mjs";

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function lerp(from, to, t) {
  return from + (to - from) * t;
}

function easeInOutQuad(t) {
  return t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2;
}

function randomRange(random, min, max) {
  return min + random() * (max - min);
}

export class Live2DControlCore {
  constructor(settings = {}, rng = Math.random) {
    this.settings = {
      updateInterval: 0.05,
      blinkMinInterval: 5,
      blinkMaxInterval: 10,
      blinkDuration: 0.1,
      enableRandomEyeMovement: true,
      eyeMovementInterval: 2,
      eyeMovementSpeed: 1,
      eyeMovementRange: 0.8,
      eyeReturnDelay: 1,
      enableRandomBrowMovement: true,
      browMovementSpeed: 0.8,
      browMovementRange: 0.3,
      enableRandomMouthMovement: true,
      mouthMovementSpeed: 0.6,
      mouthMovementRange: 0.4,
      autoRecoverExpression: true,
      expressionDuration: 6,
      expressionTransitionDuration: 1,
      allowMouthSyncOverride: true,
      ...settings
    };

    this.rng = rng;
    this.parameters = new Float32Array(23);
    this.externalMouthInputActive = false;
    this.externalMouthOpenValue = 0;

    this.currentExpression = ExpressionType.None;
    this.targetExpression = ExpressionType.None;
    this.expressionIntensity = 0;

    this._currentEyeX = 0;
    this._currentEyeY = 0;
    this._targetEyeX = 0;
    this._targetEyeY = 0;
    this._hasExpressionEyeTarget = false;

    this._currentLeftBrowY = 0;
    this._currentRightBrowY = 0;
    this._targetExpressionLeftBrowY = 0;
    this._targetExpressionRightBrowY = 0;
    this._startReturnLeftBrowY = 0;
    this._startReturnRightBrowY = 0;

    this._currentMouthShape = 0;
    this._targetExpressionMouthShape = 0;
    this._startReturnMouthShape = 0;

    this._resetRuntime();
    this.resetToDefault();
  }

  update(deltaTime) {
    if (deltaTime <= 0) return;

    this._blinkTimer += deltaTime;
    this._eyeMovementTimer += deltaTime;
    this._browMovementTimer += deltaTime;
    this._mouthMovementTimer += deltaTime;

    this._handleExpression(deltaTime);
    this._handleEye(deltaTime);
    this._handleBrow(deltaTime);
    this._handleMouth(deltaTime);
    this._handleBlink(deltaTime);
  }

  triggerBlink() {
    if (!this._isBlinking) {
      this._isBlinking = true;
      this._blinkTimer = 0;
    }
  }

  setExternalMouthOpen(value) {
    if (value === null || value === undefined || Number.isNaN(value)) {
      this.externalMouthInputActive = false;
      this.externalMouthOpenValue = 0;
      return;
    }
    this.externalMouthInputActive = true;
    this.externalMouthOpenValue = clamp(value, 0, 1);
    this._write(ParameterId.MouthOpenY, this.externalMouthOpenValue);
  }

  clearExternalMouthOpen() {
    this.externalMouthInputActive = false;
    this.externalMouthOpenValue = 0;
    this._write(ParameterId.MouthOpenY, 0);
  }

  setExpression(expression, immediate = false) {
    this.targetExpression = expression;
    this._isWaitingForAutoRecover = this.settings.autoRecoverExpression && expression !== ExpressionType.None;
    this._expressionAutoRecoverTimer = 0;

    if (immediate) {
      this.currentExpression = expression;
      this.expressionIntensity = expression === ExpressionType.None ? 0 : 1;
      this._isExpressionTransitioning = false;
      return;
    }

    if (this.currentExpression !== this.targetExpression) {
      this._isExpressionTransitioning = true;
      this._expressionTransitionTimer = 0;
    }
  }

  clearExpression(immediate = false) {
    this.targetExpression = ExpressionType.None;
    this._isWaitingForAutoRecover = false;
    this._expressionAutoRecoverTimer = 0;

    if (immediate) {
      this.currentExpression = ExpressionType.None;
      this.expressionIntensity = 0;
      this._isExpressionTransitioning = false;
      this._resetExpressionParameters();
      return;
    }

    if (this.currentExpression !== ExpressionType.None) {
      this._isExpressionTransitioning = true;
      this._expressionTransitionTimer = 0;
    }
  }

  setRandomEyeMovement(enable) {
    this.settings.enableRandomEyeMovement = enable;
    if (!enable) {
      this._currentEyeX = 0;
      this._currentEyeY = 0;
      this._targetEyeX = 0;
      this._targetEyeY = 0;
      this._isEyeMoving = false;
      this._isEyeReturning = false;
      this._write(ParameterId.EyeX, 0);
      this._write(ParameterId.EyeY, 0);
    }
  }

  setBlinkSettings(minInterval, maxInterval, duration) {
    this.settings.blinkMinInterval = Math.max(0.5, minInterval);
    this.settings.blinkMaxInterval = Math.max(this.settings.blinkMinInterval + 0.5, maxInterval);
    this.settings.blinkDuration = clamp(duration, 0.05, 0.3);
  }

  resetToDefault() {
    this._resetExpressionParameters();
    this.currentExpression = ExpressionType.None;
    this.targetExpression = ExpressionType.None;
    this.expressionIntensity = 0;
    this._isExpressionTransitioning = false;
  }

  snapshot() {
    return {
      expression: this.currentExpression,
      targetExpression: this.targetExpression,
      eyeX: this.parameters[ParameterId.EyeX],
      eyeY: this.parameters[ParameterId.EyeY],
      mouthForm: this.parameters[ParameterId.MouthForm],
      mouthOpen: this.parameters[ParameterId.MouthOpenY]
    };
  }

  _resetRuntime() {
    this._blinkTimer = 0;
    this._nextBlinkTime = randomRange(this.rng, this.settings.blinkMinInterval, this.settings.blinkMaxInterval);
    this._eyeMovementTimer = 0;
    this._nextEyeMovementTime = randomRange(this.rng, 1, this.settings.eyeMovementInterval);
    this._browMovementTimer = 0;
    this._mouthMovementTimer = 0;
    this._expressionTransitionTimer = 0;
    this._expressionAutoRecoverTimer = 0;
    this._isBlinking = false;
    this._isEyeMoving = false;
    this._isEyeReturning = false;
    this._isBrowTransitioning = false;
    this._isBrowReturning = false;
    this._isMouthTransitioning = false;
    this._isMouthReturning = false;
  }

  _handleExpression(deltaTime) {
    this._handleAutoRecover(deltaTime);

    if (this._isExpressionTransitioning) {
      this._expressionTransitionTimer += deltaTime;
      const progress = this._expressionTransitionTimer / Math.max(0.001, this.settings.expressionTransitionDuration);
      if (progress >= 1) {
        this._isExpressionTransitioning = false;
        this.currentExpression = this.targetExpression;
        this.expressionIntensity = this.targetExpression === ExpressionType.None ? 0 : 1;
      } else {
        const smooth = easeInOutQuad(clamp(progress, 0, 1));
        this.expressionIntensity = this.targetExpression === ExpressionType.None
          ? lerp(1, 0, smooth)
          : lerp(0, 1, smooth);
      }
    }

    if (this.expressionIntensity <= 0) {
      if (this.currentExpression !== ExpressionType.None || this.targetExpression !== ExpressionType.None) {
        this._resetExpressionParameters();
      }
      return;
    }

    const expression = this.targetExpression !== ExpressionType.None ? this.targetExpression : this.currentExpression;
    this._applyExpression(expression, this.expressionIntensity);
  }

  _handleAutoRecover(deltaTime) {
    if (!this.settings.autoRecoverExpression || !this._isWaitingForAutoRecover) return;
    this._expressionAutoRecoverTimer += deltaTime;
    if (this._expressionAutoRecoverTimer >= this.settings.expressionDuration) {
      this.clearExpression();
      this._isWaitingForAutoRecover = false;
    }
  }

  _handleEye(deltaTime) {
    if (!this.settings.enableRandomEyeMovement) return;

    if (!this._isEyeMoving && !this._isEyeReturning && this._eyeMovementTimer >= this._nextEyeMovementTime) {
      if (!this._hasExpressionEyeTarget) {
        this._targetEyeX = randomRange(this.rng, -this.settings.eyeMovementRange, this.settings.eyeMovementRange);
        this._targetEyeY = randomRange(this.rng, -this.settings.eyeMovementRange, this.settings.eyeMovementRange);
      }
      this._isEyeMoving = true;
      this._eyeMovementTimer = 0;
    }

    if (this._isEyeMoving) {
      const progress = this._eyeMovementTimer * this.settings.eyeMovementSpeed;
      if (progress >= 1) {
        this._currentEyeX = this._targetEyeX;
        this._currentEyeY = this._targetEyeY;
        this._isEyeMoving = false;
        this._isEyeReturning = true;
        this._eyeReturnTimer = 0;
        this._hasExpressionEyeTarget = false;
      } else {
        const smooth = easeInOutQuad(progress);
        this._currentEyeX = lerp(this._currentEyeX, this._targetEyeX, smooth);
        this._currentEyeY = lerp(this._currentEyeY, this._targetEyeY, smooth);
      }
    }

    if (this._isEyeReturning) {
      this._eyeReturnTimer += deltaTime;
      if (this._eyeReturnTimer >= this.settings.eyeReturnDelay) {
        const progress = (this._eyeReturnTimer - this.settings.eyeReturnDelay) * this.settings.eyeMovementSpeed;
        if (progress >= 1) {
          this._currentEyeX = 0;
          this._currentEyeY = 0;
          this._isEyeReturning = false;
          this._nextEyeMovementTime = randomRange(this.rng, this.settings.eyeMovementInterval * 0.5, this.settings.eyeMovementInterval * 1.5);
          this._eyeMovementTimer = 0;
        } else {
          const smooth = easeInOutQuad(progress);
          this._currentEyeX = lerp(this._currentEyeX, 0, smooth);
          this._currentEyeY = lerp(this._currentEyeY, 0, smooth);
        }
      }
    }

    this._write(ParameterId.EyeX, this._currentEyeX);
    this._write(ParameterId.EyeY, this._currentEyeY);
  }

  _handleBrow(deltaTime) {
    if (!this.settings.enableRandomBrowMovement) return;

    if (this._isAnyExpressionActive()) {
      if (!this._isBrowTransitioning) {
        this._isBrowTransitioning = true;
        this._browTransitionTimer = 0;
        const data = createExpressionData(this.currentExpression !== ExpressionType.None ? this.currentExpression : this.targetExpression);
        this._targetExpressionLeftBrowY = data.leftBrowY;
        this._targetExpressionRightBrowY = data.rightBrowY;
      }

      this._browTransitionTimer += deltaTime;
      const progress = Math.min(1, this._browTransitionTimer / Math.max(0.001, this.settings.expressionTransitionDuration));
      const smooth = easeInOutQuad(progress);
      this._currentLeftBrowY = lerp(this._currentLeftBrowY, this._targetExpressionLeftBrowY, smooth);
      this._currentRightBrowY = lerp(this._currentRightBrowY, this._targetExpressionRightBrowY, smooth);
      this._write(ParameterId.BrowLY, this._currentLeftBrowY);
      this._write(ParameterId.BrowRY, this._currentRightBrowY);
      return;
    }

    if (this._isBrowTransitioning) {
      this._isBrowTransitioning = false;
      this._browReturnTimer = 0;
      this._isBrowReturning = true;
      this._startReturnLeftBrowY = this._currentLeftBrowY;
      this._startReturnRightBrowY = this._currentRightBrowY;
    }

    if (this._isBrowReturning) {
      this._browReturnTimer += deltaTime;
      const progress = Math.min(1, this._browReturnTimer / 0.3);
      const smooth = easeInOutQuad(progress);
      const waveTime = this._browMovementTimer * this.settings.browMovementSpeed;
      const leftWave = Math.sin(waveTime) * this.settings.browMovementRange;
      const rightWave = Math.sin(waveTime + 0.5) * this.settings.browMovementRange;
      this._currentLeftBrowY = lerp(this._startReturnLeftBrowY, leftWave, smooth);
      this._currentRightBrowY = lerp(this._startReturnRightBrowY, rightWave, smooth);
      if (progress >= 1) {
        this._isBrowReturning = false;
        this._browReturnTimer = 0;
      }
    } else {
      const waveTime = this._browMovementTimer * this.settings.browMovementSpeed;
      this._currentLeftBrowY = Math.sin(waveTime) * this.settings.browMovementRange;
      this._currentRightBrowY = Math.sin(waveTime + 0.5) * this.settings.browMovementRange;
    }

    this._write(ParameterId.BrowLY, this._currentLeftBrowY);
    this._write(ParameterId.BrowRY, this._currentRightBrowY);
  }

  _handleMouth(deltaTime) {
    if (!this.settings.enableRandomMouthMovement) return;

    if (this._isAnyExpressionActive()) {
      if (!this._isMouthTransitioning) {
        this._isMouthTransitioning = true;
        this._mouthTransitionTimer = 0;
        this._targetExpressionMouthShape = createExpressionData(this.currentExpression !== ExpressionType.None ? this.currentExpression : this.targetExpression).mouthShape;
      }

      this._mouthTransitionTimer += deltaTime;
      const progress = Math.min(1, this._mouthTransitionTimer / Math.max(0.001, this.settings.expressionTransitionDuration));
      const smooth = easeInOutQuad(progress);
      this._currentMouthShape = lerp(this._currentMouthShape, this._targetExpressionMouthShape, smooth);
      this._write(ParameterId.MouthForm, this._currentMouthShape);
      return;
    }

    if (this._isMouthTransitioning) {
      this._isMouthTransitioning = false;
      this._mouthReturnTimer = 0;
      this._isMouthReturning = true;
      this._startReturnMouthShape = this._currentMouthShape;
    }

    if (this._isMouthReturning) {
      this._mouthReturnTimer += deltaTime;
      const progress = Math.min(1, this._mouthReturnTimer / 0.3);
      const smooth = easeInOutQuad(progress);
      const waveTime = this._mouthMovementTimer * this.settings.mouthMovementSpeed;
      const targetWave = (Math.sin(waveTime) + 1) * 0.5 * this.settings.mouthMovementRange;
      this._currentMouthShape = lerp(this._startReturnMouthShape, targetWave, smooth);
      if (progress >= 1) {
        this._isMouthReturning = false;
        this._mouthReturnTimer = 0;
      }
    } else {
      const waveTime = this._mouthMovementTimer * this.settings.mouthMovementSpeed;
      this._currentMouthShape = (Math.sin(waveTime) + 1) * 0.5 * this.settings.mouthMovementRange;
    }

    this._write(ParameterId.MouthForm, this._currentMouthShape);
  }

  _handleBlink() {
    if (this._isAnyExpressionActive()) {
      if (this._isBlinking) {
        this._setEyeOpenness(1);
        this._isBlinking = false;
        this._blinkTimer = 0;
      }
      return;
    }

    if (this._isBlinking) {
      if (this._blinkTimer >= this.settings.blinkDuration) {
        this._setEyeOpenness(1);
        this._isBlinking = false;
        this._blinkTimer = 0;
        this._nextBlinkTime = randomRange(this.rng, this.settings.blinkMinInterval, this.settings.blinkMaxInterval);
      } else if (this._blinkTimer >= this.settings.blinkDuration * 0.5) {
        const progress = (this._blinkTimer - this.settings.blinkDuration * 0.5) / (this.settings.blinkDuration * 0.5);
        this._setEyeOpenness(clamp(progress, 0, 1));
      } else {
        const progress = this._blinkTimer / (this.settings.blinkDuration * 0.5);
        this._setEyeOpenness(clamp(1 - progress, 0, 1));
      }
    } else if (this._blinkTimer >= this._nextBlinkTime) {
      this._isBlinking = true;
      this._blinkTimer = 0;
    }
  }

  _setEyeOpenness(openness) {
    this._write(ParameterId.LeftEyeOpen, openness);
    this._write(ParameterId.RightEyeOpen, openness);
  }

  _applyExpression(type, intensity) {
    const data = createExpressionData(type);
    this._write(ParameterId.FaceXAngle, data.faceXAngle * intensity);
    this._write(ParameterId.FaceYAngle, data.faceYAngle * intensity);
    if (!this.externalMouthInputActive) {
      this._write(ParameterId.MouthOpenY, data.mouthOpen >= 0 ? data.mouthOpen * intensity : 0);
    }
    this._write(ParameterId.LeftEyeOpen, lerp(1, data.leftEye, intensity));
    this._write(ParameterId.RightEyeOpen, lerp(1, data.rightEye, intensity));
    this._write(ParameterId.LeftEyeSmile, lerp(1, data.leftEyeSmile, intensity));
    this._write(ParameterId.RightEyeSmile, lerp(1, data.rightEyeSmile, intensity));
    this._write(ParameterId.BrowLX, lerp(0, data.leftBrowX, intensity));
    this._write(ParameterId.BrowLY, lerp(0, data.leftBrowY, intensity));
    this._write(ParameterId.BrowRX, lerp(0, data.rightBrowX, intensity));
    this._write(ParameterId.BrowRY, lerp(0, data.rightBrowY, intensity));
    this._write(ParameterId.BrowLAngle, data.leftBrowAngle * intensity);
    this._write(ParameterId.BrowRAngle, data.rightBrowAngle * intensity);
    this._write(ParameterId.MouthForm, lerp(0, data.mouthShape, intensity));
    this._write(ParameterId.Love, data.loveIcon * intensity);
    this._write(ParameterId.HardWork, data.hardWorkIcon * intensity);
    this._write(ParameterId.Question, data.questionIcon * intensity);
    this._write(ParameterId.Anger, data.angerIcon * intensity);
    this._write(ParameterId.Sweat, data.sweatIcon * intensity);
    this._write(ParameterId.Sad, data.sadIcon * intensity);
    this._write(ParameterId.Happy, data.happyIcon * intensity);
  }

  _resetExpressionParameters() {
    this._write(ParameterId.FaceXAngle, 0);
    this._write(ParameterId.FaceYAngle, 0);
    if (!this.externalMouthInputActive) {
      this._write(ParameterId.LeftEyeOpen, 1);
      this._write(ParameterId.RightEyeOpen, 1);
    }
    this._write(ParameterId.LeftEyeSmile, 1);
    this._write(ParameterId.RightEyeSmile, 1);
    this._write(ParameterId.BrowLX, 0);
    this._write(ParameterId.BrowLY, 0);
    this._write(ParameterId.BrowRX, 0);
    this._write(ParameterId.BrowRY, 0);
    this._write(ParameterId.BrowLAngle, 0);
    this._write(ParameterId.BrowRAngle, 0);
    this._write(ParameterId.MouthForm, 0);
    this._write(ParameterId.MouthOpenY, 0);
    this._write(ParameterId.Love, 0);
    this._write(ParameterId.HardWork, 0);
    this._write(ParameterId.Question, 0);
    this._write(ParameterId.Anger, 0);
    this._write(ParameterId.Sweat, 0);
    this._write(ParameterId.Sad, 0);
    this._write(ParameterId.Happy, 0);
  }

  _isAnyExpressionActive() {
    return this.currentExpression !== ExpressionType.None ||
      this.targetExpression !== ExpressionType.None ||
      this._isExpressionTransitioning ||
      this.expressionIntensity > 0;
  }

  _write(id, value) {
    this.parameters[id] = value;
  }
}
