import { ExpressionType } from "../../core/expression-data.mjs";

const EMOTION_MAP = Object.freeze({
  neutral:     ExpressionType.None,
  happy:       ExpressionType.Joy,
  laughing:    ExpressionType.Joy,
  funny:       ExpressionType.Joy,
  silly:       ExpressionType.Joy,
  delicious:   ExpressionType.Joy,
  cool:        ExpressionType.Joy,
  sad:         ExpressionType.Sadness,
  crying:      ExpressionType.Sadness,
  sleepy:      ExpressionType.Sadness,
  angry:       ExpressionType.Anger,
  surprised:   ExpressionType.Surprise,
  shocked:     ExpressionType.Surprise,
  embarrassed: ExpressionType.Embarrassment,
  loving:      ExpressionType.Love,
  kissy:       ExpressionType.Love,
  confused:    ExpressionType.Confusion,
  thinking:    ExpressionType.Confusion,
  winking:     ExpressionType.Skeptical,
  confident:   ExpressionType.Pride,
  relaxed:     ExpressionType.Relief
});

export function mapEmotionToExpression(emotion) {
  if (!emotion) return ExpressionType.None;
  const key = String(emotion).toLowerCase().trim();
  return EMOTION_MAP[key] ?? ExpressionType.None;
}

export function listKnownEmotions() {
  return Object.keys(EMOTION_MAP);
}
