using Live2D.Cubism.Framework;
using Live2D.Cubism.Core;
using Live2D.Cubism.Framework.MotionFade;
using UnityEngine;
using System.Collections;
using System;

public class Live2DIdleController_v2 : MonoBehaviour, ICubismUpdatable
{
    [Header("Basics")]
    public CubismModel cubismModel; // Live2D model component reference.
    public float updateInterval = 0.05f;
    
    [Header("Mouth Control Priority")]
    public MouthSyncController mouthSyncController; // Mouth-sync controller reference.
    public bool allowMouthSyncOverride = true; // Allow the mouth-sync controller to override.
    
    [Header("Blink")]
    public float minBlinkInterval = 5f;
    public float maxBlinkInterval = 10f;
    public float blinkDuration = 0.1f;
    
    [Header("Random Eye Movement")]
    public bool enableRandomEyeMovement = true;  // Enable random eye movement.
    public float eyeMovementInterval = 2f;       // Time between eye movements.
    public float eyeMovementSpeed = 1f;          // Eye movement speed.
    public float eyeMovementRange = 0.8f;        // Eye movement range (0-1).
    public float eyeReturnDelay = 1f;            // Delay before the eyes return to center.
    
    [Header("Wave Brow Movement")]
    public bool enableRandomBrowMovement = true; // Enable the brow wave.
    public float browMovementSpeed = 0.8f;       // Brow wave speed.
    public float browMovementRange = 0.3f;       // Brow wave amplitude (0-1).
    
    [Header("Wave Mouth Movement")]
    public bool enableRandomMouthMovement = true; // Enable the mouth wave.
    public float mouthMovementSpeed = 0.6f;       // Mouth wave speed.
    public float mouthMovementRange = 0.4f;       // Mouth wave amplitude (0-1).
    


    private CubismParameter[] parameters;
    private float timer;
    private float blinkTimer;
    private float nextBlinkTime;
    private bool isBlinking = false;
    
    // Random eye-movement state.
    private float eyeMovementTimer = 0f;
    private float nextEyeMovementTime = 0f;
    private float currentEyeX = 0f;
    private float currentEyeY = 0f;
    private float targetEyeX = 0f;
    private float targetEyeY = 0f;
    private bool isEyeMoving = false;
    private float eyeReturnTimer = 0f;
    private bool isEyeReturning = false;
    private bool hasExpressionTarget = false; // True when an expression has set the target pose.
    
    // Wave brow-motion state.
    private float browMovementTimer = 0f;
    private float currentLeftBrowY = 0f;
    private float currentRightBrowY = 0f;
    private bool isBrowTransitioning = false; // True while blending toward the expression brows.
    private float browTransitionTimer = 0f;   // Brow transition timer.
    private float browTransitionDuration = 0.5f; // Brow transition duration.
    private float targetExpressionLeftBrowY = 0f;  // Expression target for the left brow.
    private float targetExpressionRightBrowY = 0f; // Expression target for the right brow.
    private bool isBrowReturning = false;     // True while returning from an expression pose to the wave.
    private float browReturnTimer = 0f;       // Brow return timer.
    private float browReturnDuration = 0.3f;  // Brow return duration.
    private float startReturnLeftBrowY = 0f;  // Left brow position when the return starts.
    private float startReturnRightBrowY = 0f; // Right brow position when the return starts.
    
    // Wave mouth-motion state.
    private float mouthMovementTimer = 0f;
    private float currentMouthShape = 0f;
    private bool isMouthTransitioning = false; // True while blending toward the expression mouth.
    private float mouthTransitionTimer = 0f;   // Mouth transition timer.
    private float mouthTransitionDuration = 0.5f; // Mouth transition duration.
    private float targetExpressionMouthShape = 0f;  // Expression target for mouth shape.
    private bool isMouthReturning = false;     // True while returning from an expression pose to the wave.
    private float mouthReturnTimer = 0f;       // Mouth return timer.
    private float mouthReturnDuration = 0.3f;  // Mouth return duration.
    private float startReturnMouthShape = 0f;  // Mouth shape when the return starts.

    private bool isExpressionTransitionCompleted = false; // True when the expression blend has finished.
    private bool directorDisableExpressionMouthControl = false;
    
    /// <summary>
    /// Model has update controller component.
    /// </summary>
    [HideInInspector]
    public bool HasUpdateController { get; set; }
    

    
    // Note: smooth-transition fields were removed because HandleSmoothTransition no longer uses them.
    
    // Expression system toggles, extended for 27 analyzer outputs.
    [Header("Expression System")]
    public bool enableJoy = false;           // Joy (joy, amusement, excitement)
    public bool enableSadness = false;       // Sadness (sadness, grief, disappointment)
    public bool enableAnger = false;         // Anger (anger, annoyance, fury)
    public bool enableSurprise = false;      // Surprise (surprise, astonishment)
    public bool enableFear = false;          // Fear (fear, nervousness)
    public bool enableDisgust = false;       // Disgust (disgust, disapproval)
    public bool enableLove = false;          // Love (love, caring, admiration)
    public bool enableConfusion = false;     // Confusion (confusion, curiosity)
    public bool enableSkeptical = false;     // Skeptical (skeptical, realization)
    public bool enableEmbarrassment = false; // Embarrassment (embarrassment)
    public bool enablePride = false;         // Pride (pride, approval)
    public bool enableDesire = false;        // Desire (desire, seductive)
    public bool enableRelief = false;        // Relief (relief, gratitude)
    public bool enableRemorse = false;       // Remorse (remorse)
    public bool enableOptimism = false;      // Optimism (optimism)
    public bool enableIntenseFocus = false;  // Intense focus (focus)
    
    [Header("Expression Auto Recover")]
    public bool autoRecoverExpression = false;  // Auto-recover when the duration ends.
    public float expressionDuration = 3f;       // Expression duration in seconds.
    
    public float expressionTransitionDuration = 1f; // Expression blend duration.

    // Expression system state.
    private ExpressionType currentExpression = ExpressionType.None;
    private ExpressionType targetExpression = ExpressionType.None;
    private bool isExpressionTransitioning = false;
    private float expressionTransitionTimer = 0f;
    private float expressionIntensity = 0f; // Current expression intensity (0-1).
    
    // Auto-recover state.
    private float expressionAutoRecoverTimer = 0f; // Auto-recover timer.
    private bool isWaitingForAutoRecover = false;  // True while waiting for auto-recover.
    
    // Expression data layout.
    [System.Serializable]
    public struct ExpressionData
    {
        public float faceXAngle;        // Face angle X.
        public float faceYAngle;        // Face angle Y.
        public float leftEye;           // Left eye open amount.
        public float leftEyeSmile;      // Left eye smile.
        public float rightEye;          // Right eye open amount.
        public float rightEyeSmile;     // Right eye smile.
        public float eyeX;              // Eyeball X.
        public float eyeY;              // Eyeball Y.
        public float leftBrowX;         // Left brow left/right.
        public float leftBrowY;         // Left brow up/down.
        public float rightBrowX;        // Right brow left/right.
        public float rightBrowY;        // Right brow up/down.
        public float leftBrowShape;     // Left brow deformation.
        public float rightBrowShape;    // Right brow deformation.
        public float mouthShape;        // Mouth form.
        public float mouthOpen;         // Mouth open. -1 means leave it unset.
        public float blushEffect;       // Blush effect.
        public float electricWaveIcon;  // Electric-wave effect.
        public float questionIcon;      // Question-mark effect.
        public float angerIcon;         // Anger effect.
        public float speechlessIcon;    // Speechless effect.
        public float tearIcon;          // Tear effect.
        public float starIcon;          // Star effect.
    }
    

    
    // Expression enum, extended for 27 analyzer outputs.
    public enum ExpressionType
    {
        None,          // No expression.
        Joy,           // Joy (joy, amusement, excitement)
        Sadness,       // Sadness (sadness, grief, disappointment)
        Anger,         // Anger (anger, annoyance, fury)
        Surprise,      // Surprise (surprise, astonishment)
        Fear,          // Fear (fear, nervousness)
        Disgust,       // Disgust (disgust, disapproval)
        Love,          // Love (love, caring, admiration)
        Confusion,     // Confusion (confusion, curiosity)
        Skeptical,     // Skeptical (skeptical, realization)
        Embarrassment, // Embarrassment (embarrassment)
        Pride,         // Pride (pride, approval)
        Desire,        // Desire (desire, seductive)
        Relief,        // Relief (relief, gratitude)
        Remorse,       // Remorse (remorse)
        Optimism,      // Optimism (optimism)
        IntenseFocus   // Intense focus (focus)
    }

    // Parameter indexes.
    private const int FACE_X_ANGLE = 0;     // Face angle X.
    private const int FACE_Y_ANGLE = 1;     // Face angle Y.
    private const int LEFT_EYE = 2;
    private const int LEFT_EYE_SMILE = 3;   // Left eye smile.
    private const int RIGHT_EYE = 4;
    private const int RIGHT_EYE_SMILE = 5;  // Right eye smile.
    private const int EYE_X = 6;
    private const int EYE_Y = 7;
    private const int LEFT_BROW_X = 9;
    private const int LEFT_BROW_Y = 8;
    private const int RIGHT_BROW_X = 11;
    private const int RIGHT_BROW_Y = 10;
    private const int LEFT_BROW_SHAPE = 12;
    private const int RIGHT_BROW_SHAPE = 13;
    private const int MOUTH_SHAPE = 14;
    private const int MOUTH_OPEN = 15;      // Mouth open/close.
    private const int BLUSH_EFFECT = 16;    // Blush effect.
    private const int ELECTRIC_WAVE_ICON = 17;  // Electric-wave effect.
    private const int QUESTION_ICON = 18;   // Question-mark effect.
    private const int ANGER_ICON = 19;      // Anger effect.
    private const int SPEECHLESS_ICON = 20; // Speechless effect.
    private const int TEAR_ICON = 21;       // Tear effect.
    private const int STAR_ICON = 22;       // Star effect.

    /// <summary>
    /// Called by cubism update controller. Order to invoke OnLateUpdate.
    /// </summary>
    public int ExecutionOrder
    {
        get { return CubismUpdateExecutionOrder.CubismLookController; }
    }

    /// <summary>
    /// Called by cubism update controller. Needs to invoke OnLateUpdate on Editing.
    /// </summary>
    public bool NeedsUpdateOnEditing
    {
        get { return false; }
    }

    /// <summary>
    /// Called by cubism update controller. Updates controller.
    /// </summary>
    public void OnLateUpdate()
    {
        // Return if it is not valid or there's nothing to update.
        if (!enabled || parameters == null)
        {
            return;
        }

        timer += Time.deltaTime;
        blinkTimer += Time.deltaTime;
        eyeMovementTimer += Time.deltaTime;
        browMovementTimer += Time.deltaTime;
        mouthMovementTimer += Time.deltaTime;

        if (timer >= updateInterval)
        {
            UpdateIdleAnimations();
            timer = 0f;
        }

        // Random eye movement (highest priority).
        HandleRandomEyeMovement();
        
        // Update random brow motion.
        HandleRandomBrowMovement();
        
        // Update random mouth motion.
        HandleRandomMouthMovement();
        
        // Update the expression system.
        HandleExpressionSystem();
        
        // Update blinking.
        HandleBlinking();
        
        // Note: smooth transition has been removed.
    }

    void Start()
    {
        // Resolve the CubismModel component.
        if (cubismModel == null)
        {
            cubismModel = GetComponent<CubismModel>();
            if (cubismModel == null)
            {
                cubismModel = this.FindCubismModel();
            }
        }
        
        if (cubismModel == null)
        {
            Debug.LogError("CubismModel component was not found. Assign the CubismModel reference in the Inspector, or attach this script to a GameObject that has a CubismModel component.");
            enabled = false;
            return;
        }
        
        // Read the parameter array.
        parameters = cubismModel.Parameters;
        
        // Find MouthSyncController automatically when it was not assigned.
        if (mouthSyncController == null)
        {
            mouthSyncController = FindObjectOfType<MouthSyncController>();
            if (mouthSyncController != null)
            {
                Debug.Log($"Found MouthSyncController automatically: {mouthSyncController.gameObject.name}");
            }
        }

        // Get cubism update controller.
        HasUpdateController = (GetComponent<CubismUpdateController>() != null);

        // Schedule the next blink.
        nextBlinkTime = UnityEngine.Random.Range(minBlinkInterval, maxBlinkInterval);
        
        // Initialize random eye movement.
        nextEyeMovementTime = UnityEngine.Random.Range(1f, eyeMovementInterval);
        
        // Reset the wave-brow timer.
        browMovementTimer = 0f;
        
        // Reset the wave-mouth timer.
        mouthMovementTimer = 0f;

        #if UNITY_EDITOR || DEVELOPMENT_BUILD
        Debug.Log("Live2D idle controller initialized");
        #endif
        
        // Log the mouth-control priority.
        if (allowMouthSyncOverride && mouthSyncController != null)
        {
            #if UNITY_EDITOR || DEVELOPMENT_BUILD
            Debug.Log("Mouth control priority: MouthSyncController");
            #endif
        }
        else
        {
            #if UNITY_EDITOR || DEVELOPMENT_BUILD
            Debug.Log("Mouth control priority: Live2DIdleController");
            #endif
        }
    }

    /// <summary>
    /// Called by Unity. Updates controller.
    /// </summary>
    private void LateUpdate()
    {
        if (!HasUpdateController)
        {
            OnLateUpdate();
        }
    }

    /// <summary>
    /// Update every idle animation.
    /// </summary>
    private void UpdateIdleAnimations()
    {
        if (parameters == null) return;

        // Keep random blinking only. Other random motion was removed.
    }
    
    /// <summary>
    /// Set the next eye-movement target for the expression system.
    /// </summary>
    private void SetNextEyeMovementTarget(float eyeX, float eyeY)
    {
        if (!enableRandomEyeMovement)
            return;
            
        // Use the expression eye parameters as the next movement target.
        targetEyeX = Mathf.Clamp(eyeX, -eyeMovementRange, eyeMovementRange);
        targetEyeY = Mathf.Clamp(eyeY, -eyeMovementRange, eyeMovementRange);
        hasExpressionTarget = true; // An expression has set the target.
        
        // If the eyes are idle, start moving to the expression target immediately.
        if (!isEyeMoving && !isEyeReturning)
        {
            isEyeMoving = true;
            eyeMovementTimer = 0f;
        }
    }
    
    /// <summary>
    /// Random eye movement. Always enabled when the toggle is on.
    /// </summary>
    private void HandleRandomEyeMovement()
    {
        if (!enableRandomEyeMovement || parameters == null)
            return;
        
        // Check whether it is time for the next eye movement.
        if (!isEyeMoving && !isEyeReturning && eyeMovementTimer >= nextEyeMovementTime)
        {
            // Pick a new random target only when no expression target is set.
            if (!hasExpressionTarget)
            {
                targetEyeX = UnityEngine.Random.Range(-eyeMovementRange, eyeMovementRange);
                targetEyeY = UnityEngine.Random.Range(-eyeMovementRange, eyeMovementRange);
            }
            isEyeMoving = true;
            eyeMovementTimer = 0f;
        }
        
        // Update the eye move.
        if (isEyeMoving)
        {
            float moveProgress = eyeMovementTimer * eyeMovementSpeed;
            if (moveProgress >= 1f)
            {
                // Move finished. Wait before returning.
                currentEyeX = targetEyeX;
                currentEyeY = targetEyeY;
                isEyeMoving = false;
                isEyeReturning = true;
                eyeReturnTimer = 0f;
                hasExpressionTarget = false; // Clear the expression-target flag so later motion can be random.
            }
            else
            {
                // Move smoothly toward the target.
                float smoothProgress = EaseInOutQuad(moveProgress);
                currentEyeX = Mathf.Lerp(currentEyeX, targetEyeX, smoothProgress);
                currentEyeY = Mathf.Lerp(currentEyeY, targetEyeY, smoothProgress);
            }
        }
        
        // Update the eye return.
        if (isEyeReturning)
        {
            eyeReturnTimer += Time.deltaTime;
            if (eyeReturnTimer >= eyeReturnDelay)
            {
                // Start returning to center.
                float returnProgress = (eyeReturnTimer - eyeReturnDelay) * eyeMovementSpeed;
                if (returnProgress >= 1f)
                {
                    // Return finished.
                    currentEyeX = 0f;
                    currentEyeY = 0f;
                    isEyeReturning = false;
                    // Schedule the next movement.
                    nextEyeMovementTime = UnityEngine.Random.Range(eyeMovementInterval * 0.5f, eyeMovementInterval * 1.5f);
                    eyeMovementTimer = 0f;
                }
                else
                {
                    // Return smoothly to center.
                    float smoothProgress = EaseInOutQuad(returnProgress);
                    currentEyeX = Mathf.Lerp(currentEyeX, 0f, smoothProgress);
                    currentEyeY = Mathf.Lerp(currentEyeY, 0f, smoothProgress);
                }
            }
        }
        
        // Always write the eye parameters.
        SetEyeParametersDirect(EYE_X, currentEyeX);
        SetEyeParametersDirect(EYE_Y, currentEyeY);
    }
    
    /// <summary>
    /// Wave brow motion, enabled only while no expression is playing.
    /// </summary>
    private void HandleRandomBrowMovement()
    {
        if (!enableRandomBrowMovement || parameters == null)
            return;
            
        // While an expression is playing.
        if (IsAnyExpressionActive())
        {
            // If the brow transition has not started, blend toward the expression brows.
            if (!isBrowTransitioning)
            {
                isBrowTransitioning = true;
                browTransitionTimer = 0f;
                // Read the expression brow target. This uses the center until expression data provides it.
                targetExpressionLeftBrowY = 0f;
                targetExpressionRightBrowY = 0f;
            }
            
            // Run the smooth blend.
            browTransitionTimer += Time.deltaTime;
            float transitionProgress = Mathf.Clamp01(browTransitionTimer / browTransitionDuration);
            float smoothProgress = EaseInOutQuad(transitionProgress);
            
            // Blend from the current wave pose to the expression target.
            currentLeftBrowY = Mathf.Lerp(currentLeftBrowY, targetExpressionLeftBrowY, smoothProgress);
            currentRightBrowY = Mathf.Lerp(currentRightBrowY, targetExpressionRightBrowY, smoothProgress);
            
            // Write brow parameters.
            SetParameterValue(LEFT_BROW_Y, currentLeftBrowY);
            SetParameterValue(RIGHT_BROW_Y, currentRightBrowY);
            return;
        }
        else
        {
            // Expression ended. Blend back to the wave motion.
            if (isBrowTransitioning)
            {
                isBrowTransitioning = false;
                browTransitionTimer = 0f;
                
                // Start the return blend.
                isBrowReturning = true;
                browReturnTimer = 0f;
                startReturnLeftBrowY = currentLeftBrowY;
                startReturnRightBrowY = currentRightBrowY;
            }
        }
        
        // While blending from the expression pose back to the wave.
        if (isBrowReturning)
        {
            browReturnTimer += Time.deltaTime;
            float returnProgress = Mathf.Clamp01(browReturnTimer / browReturnDuration);
            float smoothReturnProgress = EaseInOutQuad(returnProgress);
            
            // Compute the wave pose for this frame.
            float waveTime = browMovementTimer * browMovementSpeed;
            float targetLeftWave = Mathf.Sin(waveTime) * browMovementRange;
            float targetRightWave = Mathf.Sin(waveTime + 0.5f) * browMovementRange;
            
            // Blend from the expression pose back to the wave pose.
            currentLeftBrowY = Mathf.Lerp(startReturnLeftBrowY, targetLeftWave, smoothReturnProgress);
            currentRightBrowY = Mathf.Lerp(startReturnRightBrowY, targetRightWave, smoothReturnProgress);
            
            // Blend finished. Resume the normal wave.
            if (returnProgress >= 1f)
            {
                isBrowReturning = false;
                browReturnTimer = 0f;
            }
        }
        else
        {
            // Drive a continuous brow wave from a sine wave.
            float waveTime = browMovementTimer * browMovementSpeed;
            
            // Offset the left and right brow waves so the motion looks more natural.
            float leftWave = Mathf.Sin(waveTime) * browMovementRange;
            float rightWave = Mathf.Sin(waveTime + 0.5f) * browMovementRange; // Right brow phase offset.
            
            currentLeftBrowY = leftWave;
            currentRightBrowY = rightWave;
        }
        
        // Write brow parameters.
        SetParameterValue(LEFT_BROW_Y, currentLeftBrowY);
        SetParameterValue(RIGHT_BROW_Y, currentRightBrowY);
    }
    
    /// <summary>
    /// Wave mouth motion, enabled only while no expression is playing.
    /// </summary>
    private void HandleRandomMouthMovement()
    {
        if (!enableRandomMouthMovement || parameters == null)
            return;
            
        // While an expression is playing.
        if (IsAnyExpressionActive())
        {
            // If the mouth transition has not started, blend toward the expression mouth.
            if (!isMouthTransitioning)
            {
                isMouthTransitioning = true;
                mouthTransitionTimer = 0f;
                // Read the expression mouth target. This uses the center until expression data provides it.
                 targetExpressionMouthShape = 0f;
            }
            
            // Run the smooth blend.
            mouthTransitionTimer += Time.deltaTime;
            float transitionProgress = Mathf.Clamp01(mouthTransitionTimer / mouthTransitionDuration);
            float smoothProgress = EaseInOutQuad(transitionProgress);
            
            // Blend from the current wave pose to the expression target.
             currentMouthShape = Mathf.Lerp(currentMouthShape, targetExpressionMouthShape, smoothProgress);
             
             // Write mouth parameters.
             SetParameterValue(MOUTH_SHAPE, currentMouthShape);
            return;
        }
        else
        {
            // Expression ended. Blend back to the wave motion.
            if (isMouthTransitioning)
            {
                isMouthTransitioning = false;
                mouthTransitionTimer = 0f;
                
                // Start the return blend.
                 isMouthReturning = true;
                 mouthReturnTimer = 0f;
                 startReturnMouthShape = currentMouthShape;
            }
        }
        
        // While blending from the expression pose back to the wave.
        if (isMouthReturning)
        {
            mouthReturnTimer += Time.deltaTime;
            float returnProgress = Mathf.Clamp01(mouthReturnTimer / mouthReturnDuration);
            float smoothReturnProgress = EaseInOutQuad(returnProgress);
            
            // Compute the wave pose for this frame.
             float waveTime = mouthMovementTimer * mouthMovementSpeed;
             float targetMouthWave = (Mathf.Sin(waveTime) + 1f) * 0.5f * mouthMovementRange;
            
            // Blend from the expression pose back to the wave pose.
             currentMouthShape = Mathf.Lerp(startReturnMouthShape, targetMouthWave, smoothReturnProgress);
            
            // Blend finished. Resume the normal wave.
            if (returnProgress >= 1f)
            {
                isMouthReturning = false;
                mouthReturnTimer = 0f;
            }
        }
        else
        {
            // Drive a continuous mouth wave from a sine wave.
            float waveTime = mouthMovementTimer * mouthMovementSpeed;
            
            // Build a 0-1 wave, which is the useful range for MOUTH_SHAPE.
              float mouthWave = (Mathf.Sin(waveTime) + 1f) * 0.5f * mouthMovementRange;
             
             currentMouthShape = mouthWave;
         }
         
         // Write mouth parameters.
         SetParameterValue(MOUTH_SHAPE, currentMouthShape);
    }

    /// <summary>
    /// Check whether any expression is playing or blending.
    /// </summary>
    private bool IsAnyExpressionActive()
    {
        // Check whether any expression toggle is true.
        bool hasActiveExpression = enableJoy || enableSadness || enableAnger || enableSurprise || 
                                  enableFear || enableDisgust || enableLove || enableConfusion || 
                                  enableSkeptical || enableEmbarrassment || enablePride || enableDesire || 
                                  enableRelief || enableRemorse || enableOptimism || enableIntenseFocus;
        
        // Check whether a transition is running or expression intensity is not 0.
        bool isInTransitionOrActive = isExpressionTransitioning || expressionIntensity > 0f;
        
        return hasActiveExpression || isInTransitionOrActive;
    }
    
    /// <summary>
    /// Easing: EaseInOutQuad, for smooth acceleration and deceleration.
    /// </summary>
    private float EaseInOutQuad(float t)
    {
        return t < 0.5f ? 2f * t * t : 1f - Mathf.Pow(-2f * t + 2f, 2f) / 2f;
    }

    /// <summary>
    /// Blink logic.
    /// </summary>
    private void HandleBlinking()
    {
        // While an expression is playing, disable random blinking.
        if (IsAnyExpressionActive())
        {
            // If a blink is in progress, stop it and reopen the eyes.
            if (isBlinking)
            {
                SetEyeOpenness(1f);
                isBlinking = false;
                blinkTimer = 0f;
            }
            return;
        }

        if (isBlinking)
        {
            if (blinkTimer >= blinkDuration)
            {
                // Blink finished. Eyes are open.
                SetEyeOpenness(1f);
                isBlinking = false;
                blinkTimer = 0f;
                nextBlinkTime = UnityEngine.Random.Range(minBlinkInterval, maxBlinkInterval);
            }
            else if (blinkTimer >= blinkDuration * 0.5f)
            {
                // Second half of the blink: open the eyes.
                float progress = (blinkTimer - blinkDuration * 0.5f) / (blinkDuration * 0.5f);
                SetEyeOpenness(Mathf.Clamp01(progress));
            }
            else
            {
                // First half of the blink: close the eyes.
                float progress = blinkTimer / (blinkDuration * 0.5f);
                SetEyeOpenness(Mathf.Clamp01(1f - progress));
            }
        }
        else if (blinkTimer >= nextBlinkTime)
        {
            // Start the blink.
            isBlinking = true;
            blinkTimer = 0f;
        }
    }

    /// <summary>
    /// Set eye open amount.
    /// </summary>
    private void SetEyeOpenness(float openness)
    {
        SetParameterValue(LEFT_EYE, openness);
        SetParameterValue(RIGHT_EYE, openness);
    }


    /// <summary>
    /// Write the parameter value.
    /// </summary>
    private void SetParameterValue(int index, float value)
    {
        if (parameters != null && 
            index >= 0 && 
            index < parameters.Length)
        {
            if (directorDisableExpressionMouthControl && IsExpressionMouthParameter(index))
            {
                return;
            }

            // If this is a mouth parameter and MouthSyncController is driving it, skip the write.
            if (IsMouthParameter(index) && ShouldSkipMouthControl())
            {
                return;
            }
            
            // Eye parameters are applied directly in ApplyExpression, so no special case is needed here.
            
            // Use BlendToValue instead of a direct write for better WebGL compatibility.
            parameters[index].BlendToValue(CubismParameterBlendMode.Override, value);
        }
    }
    
    /// <summary>
    /// Write eye parameters directly, bypassing other control, for random eye movement.
    /// </summary>
    private void SetEyeParametersDirect(int index, float value)
    {
        if (parameters != null && 
            index >= 0 && 
            index < parameters.Length)
        {
            // Clamp eye parameters to the -1..1 range.
            value = Mathf.Clamp(value, -1f, 1f);
            parameters[index].BlendToValue(CubismParameterBlendMode.Override, value);
        }
    }
    
    /// <summary>
    /// Read the current parameter value.
    /// </summary>
    private float GetCurrentParameterValue(int index)
    {
        if (parameters != null && 
            index >= 0 && 
            index < parameters.Length)
        {
            return parameters[index].Value;
        }
        return 0f;
    }
    
    /// <summary>
    /// True when the parameter drives the mouth.
    /// </summary>
    private bool IsMouthParameter(int index)
    {
        // Only MOUTH_OPEN is owned by MouthSyncController. MOUTH_SHAPE may still move at random.
        return index == MOUTH_OPEN;
    }

    private bool IsExpressionMouthParameter(int index)
    {
        return index == MOUTH_OPEN || index == MOUTH_SHAPE;
    }
    
    /// <summary>
    /// True when the parameter drives the eyes.
    /// </summary>
    private bool IsEyeParameter(int index)
    {
        return index == EYE_X || index == EYE_Y;
    }
    
    /// <summary>
    /// Decide whether mouth control should be skipped so MouthSyncController wins.
    /// </summary>
    private bool ShouldSkipMouthControl()
    {
        if (!allowMouthSyncOverride || mouthSyncController == null)
            return false;
            
        // Check that MouthSyncController is enabled and the WebSocket is connected.
        return mouthSyncController.enabled && mouthSyncController.IsMouthInputActive();
    }
    


    /// <summary>
    /// Force a single blink.
    /// </summary>
    public void TriggerBlink()
    {
        if (!isBlinking)
        {
            isBlinking = true;
            blinkTimer = 0f;
        }
    }
    
    // Note: SetTransitionDuration was removed because smooth transitions are no longer used.

    /// <summary>
    /// Set blink parameters.
    /// </summary>
    public void SetBlinkSettings(float minInterval, float maxInterval, float duration)
    {
        minBlinkInterval = Mathf.Max(0.5f, minInterval);
        maxBlinkInterval = Mathf.Max(minBlinkInterval + 0.5f, maxInterval);
        blinkDuration = Mathf.Clamp(duration, 0.05f, 0.3f);
    }

    /// <summary>
    /// Reset every parameter to its default.
    /// </summary>
    public void ResetToDefault()
    {
        if (parameters == null) return;

        // Reset every parameter this controller owns.
        int[] controlledParams = { LEFT_EYE, RIGHT_EYE, EYE_X, EYE_Y, 
                                 LEFT_BROW_X, LEFT_BROW_Y, RIGHT_BROW_X, RIGHT_BROW_Y,
                                 LEFT_BROW_SHAPE, RIGHT_BROW_SHAPE, MOUTH_SHAPE };

        foreach (int index in controlledParams)
        {
            if (index < parameters.Length)
            {
                parameters[index].BlendToValue(CubismParameterBlendMode.Override, parameters[index].DefaultValue);
            }
        }
    }

    /// <summary>
    /// Validate parameters in the Inspector.
    /// </summary>
    void OnValidate()
    {
        minBlinkInterval = Mathf.Max(0.5f, minBlinkInterval);
        maxBlinkInterval = Mathf.Max(minBlinkInterval + 0.5f, maxBlinkInterval);
        blinkDuration = Mathf.Clamp(blinkDuration, 0.05f, 0.3f);
        updateInterval = Mathf.Max(0.01f, updateInterval);
        
        // Validate random eye-movement parameters.
        eyeMovementInterval = Mathf.Max(0.5f, eyeMovementInterval);
        eyeMovementSpeed = Mathf.Clamp(eyeMovementSpeed, 0.1f, 5f);
        eyeMovementRange = Mathf.Clamp01(eyeMovementRange);
        eyeReturnDelay = Mathf.Max(0.1f, eyeReturnDelay);
        
        // Validate expression-system parameters.
        expressionTransitionDuration = Mathf.Clamp(expressionTransitionDuration, 0.1f, 3f);
    }
    
    /// <summary>
    /// Update the expression system.
    /// </summary>
    private void HandleExpressionSystem()
    {
        // Auto-recover logic.
        HandleAutoRecovery();
        
        // Watch expression toggles for changes.
        ExpressionType newTargetExpression = GetTargetExpression();
        
        if (newTargetExpression != targetExpression)
        {
            targetExpression = newTargetExpression;
            
            // Set the eye-movement target immediately when an expression flag becomes true.
            if (targetExpression != ExpressionType.None)
            {
                ExpressionData data = GetExpressionData(targetExpression);
                if (data.eyeX != 0f || data.eyeY != 0f)
                {
                    SetNextEyeMovementTarget(data.eyeX, data.eyeY);
                }
                else
                {
                    // If the expression has no eye parameters, use the center.
                    SetNextEyeMovementTarget(0f, 0f);
                }
            }
            
            // Start blending to the new expression.
            if (targetExpression != currentExpression)
            {
                isExpressionTransitioning = true;
                expressionTransitionTimer = 0f;
            }
            
            // If auto-recover is on and an expression is active, start the timer.
            if (autoRecoverExpression && newTargetExpression != ExpressionType.None)
            {
                isWaitingForAutoRecover = true;
                expressionAutoRecoverTimer = 0f;
            }
            else if (newTargetExpression == ExpressionType.None)
            {
                // If the expression was cleared manually, stop the auto-recover timer.
                isWaitingForAutoRecover = false;
                hasExpressionTarget = false; // Clear the expression-target flag.
            }
        }
        
        // Update the expression blend.
        if (isExpressionTransitioning)
        {
            expressionTransitionTimer += Time.deltaTime;
            float progress = expressionTransitionTimer / expressionTransitionDuration;
            
            if (progress >= 1f)
            {
                // Transition finished. Write the final state exactly.
                progress = 1f;
                isExpressionTransitioning = false;
                currentExpression = targetExpression;

                
                // Write the final intensity exactly so the value does not jump.
                if (targetExpression == ExpressionType.None)
                {
                    expressionIntensity = 0f; // Make sure the exit blend finishes.
                    isExpressionTransitionCompleted = false; // Expression exit finished. Clear the flag.
                }
                else
                {
                    expressionIntensity = 1f; // Make sure the enter blend finishes.
                    isExpressionTransitionCompleted = true; // Expression enter finished. Set the flag.
                }
            }
            else
            {
                // Compute expression intensity with smooth interpolation.
                if (targetExpression == ExpressionType.None)
                {
                    // Leaving the expression. Ease the blend so the transition is smoother.
                    float smoothProgress = EaseInOutQuad(progress);
                    expressionIntensity = Mathf.Lerp(1f, 0f, smoothProgress);
                }
                else if (currentExpression == ExpressionType.None)
                {
                    // Entering the expression. Ease the blend so the transition is smoother.
                    float smoothProgress = EaseInOutQuad(progress);
                    expressionIntensity = Mathf.Lerp(0f, 1f, smoothProgress);
                }
                else
                {
                    // Expression change: leave the current one, then enter the next.
                    if (progress < 0.5f)
                    {
                        float smoothProgress = EaseInOutQuad(progress * 2f);
                        expressionIntensity = Mathf.Lerp(1f, 0f, smoothProgress);
                    }
                    else
                    {
                        float smoothProgress = EaseInOutQuad((progress - 0.5f) * 2f);
                        expressionIntensity = Mathf.Lerp(0f, 1f, smoothProgress);
                        currentExpression = targetExpression;
                    }
                }
            }
        }
        
        // Apply expression parameters. Live2D needs a write every frame to hold the values.
        if (expressionIntensity <= 0f)
        {
            // Reset parameters only while an expression is active.
            if (currentExpression != ExpressionType.None || targetExpression != ExpressionType.None)
            {
                ResetExpressionParameters();
            }
        }
        else
        {
            ExpressionType expressionToApply = targetExpression;
            if (currentExpression != ExpressionType.None && targetExpression == ExpressionType.None)
            {
                // While leaving an expression, keep applying the current one.
                expressionToApply = currentExpression;
            }
            
            if (expressionToApply != ExpressionType.None)
            {
                ApplyExpression(expressionToApply, expressionIntensity);
            }
        }
    }
    
    /// <summary>
    /// Expression auto-recover logic.
    /// </summary>
    private void HandleAutoRecovery()
    {
        if (!autoRecoverExpression || !isWaitingForAutoRecover)
            return;
            
        // Advance the auto-recover timer.
        expressionAutoRecoverTimer += Time.deltaTime;
        
        // Check whether auto-recover is due.
        if (expressionAutoRecoverTimer >= expressionDuration)
        {
            // Auto-recover: clear every expression toggle.
            enableJoy = false;
            enableSadness = false;
            enableAnger = false;
            enableSurprise = false;
            enableFear = false;
            enableDisgust = false;
            enableLove = false;
            enableConfusion = false;
            enableSkeptical = false;
            enableEmbarrassment = false;
            enablePride = false;
            enableDesire = false;
            enableRelief = false;
            enableRemorse = false;
            enableOptimism = false;
            enableIntenseFocus = false;
            
            // Stop the auto-recover timer.
            isWaitingForAutoRecover = false;
            expressionAutoRecoverTimer = 0f;
        }
    }
    
    /// <summary>
    /// Resolve the target expression type.
    /// </summary>
    private ExpressionType GetTargetExpression()
    {
        // Check expression toggles in priority order. Only one expression may be active.
        if (enableJoy) return ExpressionType.Joy;
        if (enableSadness) return ExpressionType.Sadness;
        if (enableAnger) return ExpressionType.Anger;
        if (enableSurprise) return ExpressionType.Surprise;
        if (enableFear) return ExpressionType.Fear;
        if (enableDisgust) return ExpressionType.Disgust;
        if (enableLove) return ExpressionType.Love;
        if (enableConfusion) return ExpressionType.Confusion;
        if (enableSkeptical) return ExpressionType.Skeptical;
        if (enableEmbarrassment) return ExpressionType.Embarrassment;
        if (enablePride) return ExpressionType.Pride;
        if (enableDesire) return ExpressionType.Desire;
        if (enableRelief) return ExpressionType.Relief;
        if (enableRemorse) return ExpressionType.Remorse;
        if (enableOptimism) return ExpressionType.Optimism;
        if (enableIntenseFocus) return ExpressionType.IntenseFocus;
        
        return ExpressionType.None;
    }
    
    /// <summary>
    /// Read expression data.
    /// </summary>
    private ExpressionData GetExpressionData(ExpressionType expressionType)
    {
        ExpressionData data = new ExpressionData();
        // Defaults keep the original field meaning.
        data.leftEye = 1f;
        data.rightEye = 1f;
        data.leftEyeSmile = 1f;
        data.rightEyeSmile = 1f;
        data.mouthOpen = 0f;
        
        switch (expressionType)
        {
            case ExpressionType.Joy: // Joy (joy, amusement, excitement)
                data.mouthShape = 0.4f;      // Happy smile.
                data.mouthOpen = 0.8f;       // Open-mouth smile.
                data.leftEye = 1.0f;         // Eyes half closed.
                data.rightEye = 1.0f;
                data.leftBrowY = 0.6f;       // Brows raised slightly.
                data.rightBrowY = 0.6f;
                data.eyeY = 0.2f;            // Eyes look up.
                data.faceYAngle = 5f;        // Head up.
                data.faceXAngle = 0f;        // Look forward.
                data.starIcon = 1.0f;        // Star effect.
                break;
                
            case ExpressionType.Sadness: // Sadness (sadness, grief, disappointment)
                data.mouthShape = -0.9f;     // Mouth curved down.
                data.leftBrowX = 0.4f;       // Brows pulled in.
                data.rightBrowX = -0.4f;
                data.leftBrowY = -0.5f;       // Brows curved down.
                data.rightBrowY = -0.5f;
                data.eyeY = -0.5f;           // Eyes look down.
                data.faceYAngle = -6f;      // Head down.
                data.leftEye = 0.75f;         // Eyes half closed.
                data.rightEye = 0.75f;
                data.faceXAngle = -3f;       // Head tilted slightly.
                break;
                
            case ExpressionType.Anger: // Anger (anger, annoyance, fury)
                data.leftBrowX = -0.8f;      // Brows pull toward the center.
                data.rightBrowX = 0.8f;
                data.leftBrowY = -0.8f;      // Brows pressed down.
                data.rightBrowY = -0.8f;
                data.leftBrowShape = 0.8f;   // Brow deformation.
                data.rightBrowShape = -0.8f;
                data.mouthShape = 0.2f;     // Mouth curved down.
                data.mouthOpen = 0.6f;       // Open mouth.
                data.leftEye = 0.5f;         // Narrowed eyes.
                data.rightEye = 0.5f;
                data.faceXAngle = 10f;       // Head tilt.
                data.angerIcon = 1f;         // Anger effect.
                break;
                
            case ExpressionType.Surprise: // Surprise (surprise, astonishment)
                data.leftEye = 1.0f;         // Eyes wide.
                data.rightEye = 1.0f;
                data.leftBrowY = 1.0f;       // Brows raised high.
                data.rightBrowY = 1.0f;
                data.mouthShape = 0f;        // Keep the mouth neutral.
                data.mouthOpen = 0.6f;       // Mouth open.
                data.eyeX = 0.2f; 
                data.eyeY = 0.4f;            // Eyes look clearly up.
                data.faceYAngle = 8f;        // Head up.
                data.faceXAngle = 0f;        // Look forward.
                data.electricWaveIcon = 1.0f;
                break;
                
            case ExpressionType.Fear: // Fear (fear, nervousness)
                data.leftEye = 8.0f;
                data.rightEye = 8.0f;
                data.leftBrowX = 0.5f;       // Brows pulled in.
                data.rightBrowX = -0.5f;
                data.leftBrowY = 0.6f;       // Brows raised.
                data.rightBrowY = 0.6f;
                data.mouthShape = -0.4f;     // Slight downward curve.
                data.eyeX = 0.8f;           // Eyes look right (avoidance).
                data.eyeY = -1.0f;
                data.faceXAngle = 15f;      // Tilt the head away.
                break;
                
            case ExpressionType.Disgust: // Disgust (disgust, disapproval)
                data.eyeX = 1.0f; 
                data.eyeY = 1.0f;  
                data.leftBrowY = -0.5f;      // Brows pressed down.
                data.rightBrowY = -0.5f;
                data.leftBrowShape = 0.6f;   // Brow deformation.
                data.rightBrowShape = 0.6f;
                data.mouthShape = -0.9f;     // Clearly curved down.
                data.mouthOpen = 0.5f;
                data.leftEye = 0.6f;         // Eyes half-lidded.
                data.rightEye = 0.6f;
                data.faceXAngle = -6.0f;       // Head tilt.
                data.speechlessIcon = 1.0f;  // Speechless effect.
                break;
                
            case ExpressionType.Love: // Love (love, caring, admiration)
                data.leftEye = 0.9f;         // Eyes half closed.
                data.rightEye = 0.9f;
                data.leftEyeSmile = 0f;
                data.rightEyeSmile = 0f;
                data.mouthShape = 0.6f;      // Smile.
                data.mouthOpen = 0f;         // Mouth closed.
                data.leftBrowShape = -0.2f;  // Brows lowered.
                data.rightBrowShape = -0.2f;
                data.faceXAngle = -8f;       // Head tilted slightly left.
                data.faceYAngle = -5f;       // Head lowered slightly.
                data.blushEffect = 1.0f;        // Blush effect.
                break;
                
            case ExpressionType.Confusion: // Confusion (confusion, curiosity)
                data.rightEye = 0.8f;         // Eyes slightly narrowed.
                data.leftBrowY = 0.7f;       // One brow raised.
                data.rightBrowY = -0.7f;     // One brow pressed down.
                data.leftBrowShape = 0.3f;   // Left brow deformation.
                data.rightBrowShape = -0.3f; // Right brow deformation.
                data.mouthShape = -0.2f;     // Slight downward curve.
                data.eyeX = 0.5f;            // Eyes look right.
                data.eyeY = -0.1f;           // Eyes look slightly down.
                data.faceXAngle = -9f;       // Head tilt.
                data.mouthOpen = 0.3f;       // Mouth slightly open.
                data.questionIcon = 1.0f;        // Confusion effect.
                break;
                
            case ExpressionType.Skeptical: // Skeptical (skeptical, realization)
                data.faceXAngle = 16f;      // Head tilted clearly.
                data.leftBrowY = 0.3f;       // One brow raised high.
                data.rightBrowY = -0.6f;     // One brow pressed down.
                data.mouthShape = -0.3f;     // Slight downward curve.
                data.eyeX = -0.3f;           // Eyes look left.
                data.leftEye = 0.75f;         // Eyes slightly narrowed.
                data.rightEye = 0.80f;
                break;
                
            case ExpressionType.Embarrassment: // Embarrassment (embarrassment)
                data.leftEye = 0.65f;         // Eyes clearly narrowed.
                data.rightEye = 0.65f;
                data.eyeY = -0.5f;           // Eyes look down.
                data.mouthShape = 0.4f;      // Embarrassed smile.
                data.leftBrowY = 0.3f;       // Brows raised slightly.
                data.rightBrowY = 0.3f;
                data.faceXAngle = -20f;      // Tilt the head away.
                data.faceYAngle = -10f;      // Head lowered slightly.
                data.speechlessIcon = 1.0f;  // Speechless effect.
                break;
                
            case ExpressionType.Pride: // Pride (pride, approval)
                data.leftBrowY = 0.4f;       // Brows raised.
                data.rightBrowY = 0.4f;
                data.mouthShape = 0.8f;      // Confident smile.
                data.leftEye = 0.9f;         // Eyes slightly narrowed.
                data.rightEye = 0.9f;
                data.eyeX = 0.8f;           // Eyes look right.
                data.faceYAngle = 12f;       // Head up.
                data.faceXAngle = -5f;       // Head tilted slightly.
                data.blushEffect = 1.0f;        // Blush effect.
                break;
                
            case ExpressionType.Desire: // Desire (desire, seductive)
                data.leftEye = 0.8f;         // Narrowed eyes.
                data.rightEye = 0.8f;
                data.leftEyeSmile = 0.8f;
                data.rightEyeSmile = 0.8f;
                data.eyeY = 0.8f;           // Eyes look up.
                data.eyeX = 0.8f;           // Eyes look right.
                data.faceXAngle = 16f;       // Head tilt.
                data.faceYAngle = -10f;      // Head lowered slightly.
                data.mouthShape = 0.7f;      // Charming smile.
                data.leftBrowX = -0.6f;      // Brow adjustment.
                data.rightBrowX = 0.6f;
                data.starIcon = 1.0f;
                break;
                
            case ExpressionType.Relief: // Relief (relief, gratitude)
                data.mouthShape = 0.5f;      // Relaxed smile.
                data.leftEye = 0.8f;         // Relaxed, half-lidded eyes.
                data.rightEye = 0.8f;
                data.eyeX = 0.3f;           // Eyes look right.
                data.leftBrowY = 0.2f;       // Brows raised slightly.
                data.rightBrowY = 0.2f;
                data.faceYAngle = -5f;       // Head lowered slightly.
                data.electricWaveIcon = 1.0f;        // Electric-wave effect.
                break;
                
            case ExpressionType.Remorse: // Remorse (remorse)
                data.mouthShape = -0.4f;     // Slight downward curve.
                data.mouthOpen = 0.3f;       // Mouth slightly open.
                data.leftBrowX = 0.3f;       // Brows pull in slightly.
                data.rightBrowX = 0.3f;
                data.leftBrowY = -0.2f;      // Left brow pressed down slightly.
                data.rightBrowY = 0.4f;      // Right brow raised.
                data.leftEye = 0.9f;         // Left eye slightly closed.
                data.rightEye = 0.9f;
                data.rightEye = 1.0f;        // Right eye open.
                data.eyeX = -0.2f;           // Eyes look clearly to the left.
                data.eyeY = -0.6f;           // Eyes look slightly down.
                data.faceXAngle = -12f;      // Head tilted clearly left.
                data.faceYAngle = -8f;       // Head lowered slightly.
                data.speechlessIcon = 0.8f;  // Speechless effect.
                break;
                
            case ExpressionType.Optimism: // Optimism (optimism)
                data.mouthShape = 0.9f;      // Clear smile.
                data.leftBrowY = 0.4f;       // Brows raised high.
                data.rightBrowY = 0.4f;
                data.leftEye = 1.0f;         // Eyes wide.
                data.rightEye = 1.0f;
                data.eyeX = 0.3f;
                data.leftEyeSmile = 0.7f;
                data.rightEyeSmile = 0.7f;
                data.faceYAngle = 12f;       // Head up.
                data.blushEffect = 1f;
                break;
                
            case ExpressionType.IntenseFocus: // Intense focus (focus)
                data.eyeX = 0.2f;
                data.eyeY = 0.2f;
                data.leftBrowX = -0.7f;      // Brows pull toward the center.
                data.rightBrowX = 0.7f;
                data.leftBrowY = -0.8f;      // Brows pressed down.
                data.rightBrowY = -0.8f;
                data.leftBrowShape = -0.6f;   // Brow deformation.
                data.rightBrowShape = -0.6f;
                data.mouthShape = -0.4f;     // Slight downward curve.
                data.faceYAngle = -8f;       // Head lowered slightly.
                break;
        }
        
        return data;
    }
    
    /// <summary>
    /// Reset every expression parameter to its default.
    /// </summary>
    private void ResetExpressionParameters()
    {
        if (parameters == null) return;
        
        // Reset face angles to defaults.
        SetParameterValue(FACE_X_ANGLE, 0f);
        SetParameterValue(FACE_Y_ANGLE, 0f);
        
        // Reset eye position to the default.
        // SetParameterValue(EYE_X, 0f);
        // SetParameterValue(EYE_Y, 0f);
        
        // Reset eye open amount to the default when not blinking.
        if (!isBlinking)
        {
            SetParameterValue(LEFT_EYE, 1f);
            SetParameterValue(RIGHT_EYE, 1f);
        }
        
        // Reset eye-smile parameters to defaults.
        SetParameterValue(LEFT_EYE_SMILE, 1f);
        SetParameterValue(RIGHT_EYE_SMILE, 1f);
        
        // Reset brow parameters to defaults.
        SetParameterValue(LEFT_BROW_X, 0f);
        SetParameterValue(LEFT_BROW_Y, 0f);
        SetParameterValue(RIGHT_BROW_X, 0f);
        SetParameterValue(RIGHT_BROW_Y, 0f);
        SetParameterValue(LEFT_BROW_SHAPE, 0f);
        SetParameterValue(RIGHT_BROW_SHAPE, 0f);
        
        // Reset mouth parameters to defaults.
        SetParameterValue(MOUTH_SHAPE, 0f);
        SetParameterValue(MOUTH_OPEN, 0f);
        
        // Reset every effect to its default.
        SetParameterValue(BLUSH_EFFECT, 0f);
        SetParameterValue(ELECTRIC_WAVE_ICON, 0f);
        SetParameterValue(QUESTION_ICON, 0f);
        SetParameterValue(ANGER_ICON, 0f);
        SetParameterValue(SPEECHLESS_ICON, 0f);
        SetParameterValue(TEAR_ICON, 0f);
        SetParameterValue(STAR_ICON, 0f);
    }
    
    /// <summary>
    /// Apply expression parameters.
    /// </summary>
    private void ApplyExpression(ExpressionType expressionType, float intensity)
    {
        if (parameters == null) return;
        
        ExpressionData data = GetExpressionData(expressionType);
        
        // Apply face angles.
        SetParameterValue(FACE_X_ANGLE, data.faceXAngle * intensity);
        SetParameterValue(FACE_Y_ANGLE, data.faceYAngle * intensity);
        
        // Eye parameters are fully owned by the random-movement system.
        // Expression eye parameters affect the next movement target through SetNextEyeMovementTarget.
        
        // Apply eye open amount, blended with idle motion.
        if (!isBlinking)
        {
            SetParameterValue(LEFT_EYE, Mathf.Lerp(1f, data.leftEye, intensity));
            SetParameterValue(RIGHT_EYE, Mathf.Lerp(1f, data.rightEye, intensity));
        }
        
        // Apply eye-smile parameters.
        SetParameterValue(LEFT_EYE_SMILE, Mathf.Lerp(1f, data.leftEyeSmile, intensity));
        SetParameterValue(RIGHT_EYE_SMILE, Mathf.Lerp(1f, data.rightEyeSmile, intensity));
        
        // Apply brow parameters.
        float baseLeftBrowX, baseLeftBrowY, baseLeftBrowShape;
        float baseRightBrowX, baseRightBrowY, baseRightBrowShape;
        baseLeftBrowX = 0f; baseLeftBrowY = 0f; baseLeftBrowShape = 0f;
        baseRightBrowX = 0f; baseRightBrowY = 0f; baseRightBrowShape = 0f;
        
        SetParameterValue(LEFT_BROW_X, Mathf.Lerp(baseLeftBrowX, data.leftBrowX, intensity));
        SetParameterValue(LEFT_BROW_Y, Mathf.Lerp(baseLeftBrowY, data.leftBrowY, intensity));
        SetParameterValue(RIGHT_BROW_X, Mathf.Lerp(baseRightBrowX, data.rightBrowX, intensity));
        SetParameterValue(RIGHT_BROW_Y, Mathf.Lerp(baseRightBrowY, data.rightBrowY, intensity));
        
        // Apply brow shape.
        SetParameterValue(LEFT_BROW_SHAPE, data.leftBrowShape * intensity);
        SetParameterValue(RIGHT_BROW_SHAPE, data.rightBrowShape * intensity);
        
        // Apply mouth parameters.
        float baseMouth = 0f;
        float finalMouthShape = Mathf.Lerp(baseMouth, data.mouthShape, intensity);
        
        // Allow negative mouth-form values on every expression for a wider range of shapes.
        SetParameterValue(MOUTH_SHAPE, finalMouthShape);
        
        // Apply the mouth-open parameter.
        if (data.mouthOpen >= 0f) // Apply mouth open only when mouthOpen is not -1.
        {
            SetParameterValue(MOUTH_OPEN, data.mouthOpen * intensity);
        }
        
        // Apply the blush effect.
        SetParameterValue(BLUSH_EFFECT, data.blushEffect * intensity);
        
        // Apply effect icons.
        SetParameterValue(ELECTRIC_WAVE_ICON, data.electricWaveIcon * intensity);
        SetParameterValue(QUESTION_ICON, data.questionIcon * intensity);
        SetParameterValue(ANGER_ICON, data.angerIcon * intensity);
        SetParameterValue(SPEECHLESS_ICON, data.speechlessIcon * intensity);
        SetParameterValue(TEAR_ICON, data.tearIcon * intensity);
        SetParameterValue(STAR_ICON, data.starIcon * intensity);
    }
    
    /// <summary>
    /// Public method: set the expression transition duration.
    /// </summary>
    public void SetExpressionTransitionDuration(float duration)
    {
        expressionTransitionDuration = Mathf.Clamp(duration, 0.1f, 3f);
    }
    
    /// <summary>
    /// Public method: switch to an expression immediately.
    /// </summary>
    public void SetExpression(ExpressionType expression, bool immediate = false)
    {
        // Clear every expression toggle.
        enableJoy = false;
        enableSadness = false;
        enableAnger = false;
        enableSurprise = false;
        enableFear = false;
        enableDisgust = false;
        enableLove = false;
        enableConfusion = false;
        enableSkeptical = false;
        enableEmbarrassment = false;
        enablePride = false;
        enableDesire = false;
        enableRelief = false;
        enableRemorse = false;
        enableOptimism = false;
        enableIntenseFocus = false;
        
        // Set the target expression.
        switch (expression)
        {
            case ExpressionType.Joy: enableJoy = true; break;
            case ExpressionType.Sadness: enableSadness = true; break;
            case ExpressionType.Anger: enableAnger = true; break;
            case ExpressionType.Surprise: enableSurprise = true; break;
            case ExpressionType.Fear: enableFear = true; break;
            case ExpressionType.Disgust: enableDisgust = true; break;
            case ExpressionType.Love: enableLove = true; break;
            case ExpressionType.Confusion: enableConfusion = true; break;
            case ExpressionType.Skeptical: enableSkeptical = true; break;
            case ExpressionType.Embarrassment: enableEmbarrassment = true; break;
            case ExpressionType.Pride: enablePride = true; break;
            case ExpressionType.Desire: enableDesire = true; break;
            case ExpressionType.Relief: enableRelief = true; break;
            case ExpressionType.Remorse: enableRemorse = true; break;
            case ExpressionType.Optimism: enableOptimism = true; break;
            case ExpressionType.IntenseFocus: enableIntenseFocus = true; break;
        }
        
        // Update auto-recover state.
        if (autoRecoverExpression && expression != ExpressionType.None)
        {
            isWaitingForAutoRecover = true;
            expressionAutoRecoverTimer = 0f;
        }
        else
        {
            isWaitingForAutoRecover = false;
        }
        
        if (immediate)
        {
            currentExpression = expression;
            targetExpression = expression;
            expressionIntensity = expression == ExpressionType.None ? 0f : 1f;
            isExpressionTransitioning = false;
        }
    }
    
    /// <summary>
    /// Public method: clear every expression.
    /// </summary>
    public void ClearExpression(bool immediate = false)
    {
        enableJoy = false;
        enableSadness = false;
        enableAnger = false;
        enableSurprise = false;
        enableFear = false;
        enableDisgust = false;
        enableLove = false;
        enableConfusion = false;
        enableSkeptical = false;
        enableEmbarrassment = false;
        enablePride = false;
        enableDesire = false;
        enableRelief = false;
        enableRemorse = false;
        enableOptimism = false;
        enableIntenseFocus = false;
        
        // Stop the auto-recover timer.
        isWaitingForAutoRecover = false;
        expressionAutoRecoverTimer = 0f;
        
        if (immediate)
        {
            currentExpression = ExpressionType.None;
            targetExpression = ExpressionType.None;
            expressionIntensity = 0f;
            isExpressionTransitioning = false;
        }
    }
    
    /// <summary>
    /// Public method: set mouth-control priority.
    /// </summary>
    public void SetMouthSyncOverride(bool enable)
    {
        allowMouthSyncOverride = enable;
        Debug.Log($"Mouth control priority set to: {(enable ? "MouthSyncController" : "Live2DIdleController")}");
    }
    
    /// <summary>
    /// Public method: assign the MouthSyncController reference.
    /// </summary>
    public void SetMouthSyncController(MouthSyncController controller)
    {
        mouthSyncController = controller;
        Debug.Log($"MouthSyncController reference set: {(controller != null ? controller.gameObject.name : "null")}");
    }
    
    /// <summary>
    /// Public method: read the current mouth-control state.
    /// </summary>
    public bool IsMouthControlledBySync()
    {
        return ShouldSkipMouthControl();
    }

    public void SetDirectorDisableExpressionMouthControl(bool disable)
    {
        directorDisableExpressionMouthControl = disable;
    }
    
    /// <summary>
    /// Public method: toggle random eye movement.
    /// </summary>
    public void SetRandomEyeMovement(bool enable)
    {
        enableRandomEyeMovement = enable;
        if (!enable)
        {
            // When disabled, snap the eyes back to center.
            currentEyeX = 0f;
            currentEyeY = 0f;
            isEyeMoving = false;
            isEyeReturning = false;
            isExpressionTransitionCompleted = false;

            SetEyeParametersDirect(EYE_X, 0f);
            SetEyeParametersDirect(EYE_Y, 0f);
        }
        Debug.Log($"Random eye movement set to: {(enable ? "enabled" : "disabled")}");
    }
    
    /// <summary>
    /// Public method: set eye-movement parameters.
    /// </summary>
    public void SetEyeMovementSettings(float interval, float speed, float range, float returnDelay)
    {
        eyeMovementInterval = Mathf.Max(0.5f, interval);
        eyeMovementSpeed = Mathf.Clamp(speed, 0.1f, 5f);
        eyeMovementRange = Mathf.Clamp01(range);
        eyeReturnDelay = Mathf.Max(0.1f, returnDelay);
    }
    
    /// <summary>
    /// Public method: trigger one eye movement immediately.
    /// </summary>
    public void TriggerEyeMovement()
    {
        if (enableRandomEyeMovement && !isEyeMoving && !isEyeReturning)
        {
            eyeMovementTimer = nextEyeMovementTime;
        }
    }
    
    /// <summary>
    /// Public method: snap the eyes back to center.
    /// </summary>
    public void ResetEyePosition()
    {
        currentEyeX = 0f;
        currentEyeY = 0f;
        targetEyeX = 0f;
        targetEyeY = 0f;
        isEyeMoving = false;
        isEyeReturning = false;
        isExpressionTransitionCompleted = false;

        eyeMovementTimer = 0f;
        nextEyeMovementTime = UnityEngine.Random.Range(1f, eyeMovementInterval);
        
        if (enableRandomEyeMovement)
        {
            SetEyeParametersDirect(EYE_X, 0f);
            SetEyeParametersDirect(EYE_Y, 0f);
        }
    }
 }
