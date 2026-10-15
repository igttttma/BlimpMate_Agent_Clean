export const ExpressionType = Object.freeze({
  None: "None",
  Joy: "Joy",
  Sadness: "Sadness",
  Anger: "Anger",
  Surprise: "Surprise",
  Fear: "Fear",
  Disgust: "Disgust",
  Love: "Love",
  Confusion: "Confusion",
  Skeptical: "Skeptical",
  Embarrassment: "Embarrassment",
  Pride: "Pride",
  Desire: "Desire",
  Relief: "Relief",
  Remorse: "Remorse",
  Optimism: "Optimism",
  IntenseFocus: "IntenseFocus"
});

export const ParameterId = Object.freeze({
  FaceXAngle: 0,
  FaceYAngle: 1,
  LeftEyeOpen: 2,
  LeftEyeSmile: 3,
  RightEyeOpen: 4,
  RightEyeSmile: 5,
  EyeX: 6,
  EyeY: 7,
  BrowLY: 8,
  BrowLX: 9,
  BrowRY: 10,
  BrowRX: 11,
  BrowLAngle: 12,
  BrowRAngle: 13,
  MouthForm: 14,
  MouthOpenY: 15,
  Love: 16,
  HardWork: 17,
  Question: 18,
  Anger: 19,
  Sweat: 20,
  Sad: 21,
  Happy: 22
});

export function createExpressionData(type) {
  const data = {
    faceXAngle: 0,
    faceYAngle: 0,
    leftEye: 1,
    leftEyeSmile: 1,
    rightEye: 1,
    rightEyeSmile: 1,
    eyeX: 0,
    eyeY: 0,
    leftBrowX: 0,
    leftBrowY: 0,
    rightBrowX: 0,
    rightBrowY: 0,
    leftBrowAngle: 0,
    rightBrowAngle: 0,
    mouthShape: 0,
    mouthOpen: 0,
    loveIcon: 0,
    hardWorkIcon: 0,
    questionIcon: 0,
    angerIcon: 0,
    sweatIcon: 0,
    sadIcon: 0,
    happyIcon: 0
  };

  switch (type) {
    case ExpressionType.Joy:
      data.mouthShape = 0.4;
      data.mouthOpen = 0.8;
      data.leftBrowY = 0.6;
      data.rightBrowY = 0.6;
      data.eyeY = 0.2;
      data.faceYAngle = 5;
      data.happyIcon = 1;
      break;
    case ExpressionType.Sadness:
      data.mouthShape = -0.9;
      data.leftBrowX = 0.4;
      data.rightBrowX = -0.4;
      data.leftBrowY = -0.5;
      data.rightBrowY = -0.5;
      data.eyeY = -0.5;
      data.faceYAngle = -6;
      data.leftEye = 0.75;
      data.rightEye = 0.75;
      data.faceXAngle = -3;
      break;
    case ExpressionType.Anger:
      data.leftBrowX = -0.8;
      data.rightBrowX = 0.8;
      data.leftBrowY = -0.8;
      data.rightBrowY = -0.8;
      data.leftBrowAngle = 0.8;
      data.rightBrowAngle = -0.8;
      data.mouthShape = 0.2;
      data.mouthOpen = 0.6;
      data.leftEye = 0.5;
      data.rightEye = 0.5;
      data.faceXAngle = 10;
      data.angerIcon = 1;
      break;
    case ExpressionType.Surprise:
      data.leftEye = 1;
      data.rightEye = 1;
      data.leftBrowY = 1;
      data.rightBrowY = 1;
      data.mouthOpen = 0.6;
      data.eyeX = 0.2;
      data.eyeY = 0.4;
      data.faceYAngle = 8;
      data.hardWorkIcon = 1;
      break;
    case ExpressionType.Fear:
      data.leftEye = 0.8;
      data.rightEye = 0.8;
      data.leftBrowX = 0.5;
      data.rightBrowX = -0.5;
      data.leftBrowY = 0.6;
      data.rightBrowY = 0.6;
      data.mouthShape = -0.4;
      data.eyeX = 0.8;
      data.eyeY = -1;
      data.faceXAngle = 15;
      break;
    case ExpressionType.Disgust:
      data.eyeX = 1;
      data.eyeY = 1;
      data.leftBrowY = -0.5;
      data.rightBrowY = -0.5;
      data.leftBrowAngle = 0.6;
      data.rightBrowAngle = 0.6;
      data.mouthShape = -0.9;
      data.mouthOpen = 0.5;
      data.leftEye = 0.6;
      data.rightEye = 0.6;
      data.faceXAngle = -6;
      data.sweatIcon = 1;
      break;
    case ExpressionType.Love:
      data.leftEye = 0.9;
      data.rightEye = 0.9;
      data.leftEyeSmile = 0;
      data.rightEyeSmile = 0;
      data.mouthShape = 0.6;
      data.leftBrowAngle = -0.2;
      data.rightBrowAngle = -0.2;
      data.faceXAngle = -8;
      data.faceYAngle = -5;
      data.happyIcon = 1;
      break;
    case ExpressionType.Confusion:
      data.rightEye = 0.8;
      data.leftBrowY = 0.7;
      data.rightBrowY = -0.7;
      data.leftBrowAngle = 0.3;
      data.rightBrowAngle = -0.3;
      data.mouthShape = -0.2;
      data.eyeX = 0.5;
      data.eyeY = -0.1;
      data.faceXAngle = -9;
      data.mouthOpen = 0.3;
      data.questionIcon = 1;
      break;
    case ExpressionType.Skeptical:
      data.faceXAngle = 16;
      data.leftBrowY = 0.3;
      data.rightBrowY = -0.6;
      data.mouthShape = -0.3;
      data.eyeX = -0.3;
      data.leftEye = 0.75;
      data.rightEye = 0.8;
      break;
    case ExpressionType.Embarrassment:
      data.leftEye = 0.65;
      data.rightEye = 0.65;
      data.eyeY = -0.5;
      data.mouthShape = 0.4;
      data.leftBrowY = 0.3;
      data.rightBrowY = 0.3;
      data.faceXAngle = -20;
      data.faceYAngle = -10;
      data.sweatIcon = 1;
      break;
    case ExpressionType.Pride:
      data.leftBrowY = 0.4;
      data.rightBrowY = 0.4;
      data.mouthShape = 0.8;
      data.leftEye = 0.9;
      data.rightEye = 0.9;
      data.eyeX = 0.8;
      data.faceYAngle = 12;
      data.faceXAngle = -5;
      data.happyIcon = 1;
      break;
    case ExpressionType.Desire:
      data.leftEye = 0.8;
      data.rightEye = 0.8;
      data.leftEyeSmile = 0.8;
      data.rightEyeSmile = 0.8;
      data.eyeY = 0.8;
      data.eyeX = 0.8;
      data.faceXAngle = 16;
      data.faceYAngle = -10;
      data.mouthShape = 0.7;
      data.leftBrowX = -0.6;
      data.rightBrowX = 0.6;
      data.loveIcon = 1;
      break;
    case ExpressionType.Relief:
      data.mouthShape = 0.5;
      data.leftEye = 0.8;
      data.rightEye = 0.8;
      data.eyeX = 0.3;
      data.leftBrowY = 0.2;
      data.rightBrowY = 0.2;
      data.faceYAngle = -5;
      data.hardWorkIcon = 1;
      break;
    case ExpressionType.Remorse:
      data.mouthShape = -0.4;
      data.mouthOpen = 0.3;
      data.leftBrowX = 0.3;
      data.rightBrowX = 0.3;
      data.leftBrowY = -0.2;
      data.rightBrowY = 0.4;
      data.leftEye = 0.9;
      data.rightEye = 1;
      data.eyeX = -0.2;
      data.eyeY = -0.6;
      data.faceXAngle = -12;
      data.faceYAngle = -8;
      data.sadIcon = 0.8;
      break;
    case ExpressionType.Optimism:
      data.mouthShape = 0.9;
      data.leftBrowY = 0.4;
      data.rightBrowY = 0.4;
      data.leftEye = 1;
      data.rightEye = 1;
      data.eyeX = 0.3;
      data.leftEyeSmile = 0.7;
      data.rightEyeSmile = 0.7;
      data.faceYAngle = 12;
      data.happyIcon = 1;
      break;
    case ExpressionType.IntenseFocus:
      data.eyeX = 0.2;
      data.eyeY = 0.2;
      data.leftBrowX = -0.7;
      data.rightBrowX = 0.7;
      data.leftBrowY = -0.8;
      data.rightBrowY = -0.8;
      data.leftBrowAngle = -0.6;
      data.rightBrowAngle = -0.6;
      data.mouthShape = -0.4;
      data.faceYAngle = -8;
      data.hardWorkIcon = 1;
      break;
  }

  return data;
}
