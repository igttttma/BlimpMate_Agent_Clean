package com.blimpmate.remote;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.graphics.Path;
import android.graphics.Point;
import android.hardware.display.DisplayManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Display;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

import java.util.ArrayList;
import java.util.List;

/**
 * Carries out the viewer's input: gestures (taps, long presses, swipes,
 * drags), global keys and text typed into the focused field. Turned on once
 * with adb (see README.md); Android keeps it on across reboots.
 */
public final class InputService extends AccessibilityService {
    /** Called on the main thread with null on success, or an error for the viewer. */
    public interface Done {
        void done(String error);
    }

    // A stroke is replayed in pieces of about this length, so holds and speed
    // changes keep their timing (one piece would move at a constant speed)
    private static final long SEGMENT_MS = 50;

    private static volatile InputService instance;
    private final Handler main = new Handler(Looper.getMainLooper());

    public static InputService get() {
        return instance;
    }

    @Override
    protected void onServiceConnected() {
        instance = this;
        RemoteService.refreshInfo(this);
    }

    @Override
    public boolean onUnbind(android.content.Intent intent) {
        instance = null;
        RemoteService.refreshInfo(this);
        return super.onUnbind(intent);
    }

    @Override
    public void onDestroy() {
        instance = null;
        super.onDestroy();
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {}

    @Override
    public void onInterrupt() {}

    /** The screen size in pixels, in its current orientation. */
    public Point screenSize() {
        Display display = getSystemService(DisplayManager.class).getDisplay(Display.DEFAULT_DISPLAY);
        Point size = new Point();
        display.getRealSize(size);
        return size;
    }

    /**
     * Replays a stroke. points are {x, y, ms}: x and y are fractions of the
     * screen, ms the time since the press.
     */
    public void gesture(float[][] points, Done done) {
        main.post(() -> {
            if (points.length == 0) {
                done.done("Empty gesture");
                return;
            }
            Point size = screenSize();
            float[][] px = new float[points.length][];
            for (int i = 0; i < points.length; i++) {
                float x = clamp(points[i][0], 0, 1) * (size.x - 1);
                float y = clamp(points[i][1], 0, 1) * (size.y - 1);
                px[i] = new float[] {x, y, Math.max(0, points[i][2])};
            }
            playSegments(splitSegments(px), done);
        });
    }

    private static List<float[][]> splitSegments(float[][] px) {
        List<float[][]> segments = new ArrayList<>();
        int start = 0;
        for (int i = 1; i < px.length; i++) {
            if (px[i][2] - px[start][2] >= SEGMENT_MS || i == px.length - 1) {
                float[][] seg = new float[i - start + 1][];
                System.arraycopy(px, start, seg, 0, seg.length);
                segments.add(seg);
                start = i;
            }
        }
        if (segments.isEmpty()) segments.add(new float[][] {px[0]});
        return segments;
    }

    private void playSegments(List<float[][]> segments, Done done) {
        long maxMs = GestureDescription.getMaxGestureDuration();
        GestureDescription.StrokeDescription[] stroke = new GestureDescription.StrokeDescription[1];
        Runnable[] next = new Runnable[1];
        int[] index = {0};
        boolean[] reported = {false};
        next[0] = () -> {
            int i = index[0]++;
            float[][] seg = segments.get(i);
            boolean more = i < segments.size() - 1;
            Path path = new Path();
            path.moveTo(seg[0][0], seg[0][1]);
            for (int k = 1; k < seg.length; k++) path.lineTo(seg[k][0], seg[k][1]);
            // A tap still needs a short press; each piece needs some duration
            long ms = (long) (seg[seg.length - 1][2] - seg[0][2]);
            ms = Math.min(maxMs, Math.max(segments.size() == 1 ? 40 : 1, ms));
            stroke[0] = stroke[0] == null
                    ? new GestureDescription.StrokeDescription(path, 0, ms, more)
                    : stroke[0].continueStroke(path, 0, ms, more);
            GestureDescription g = new GestureDescription.Builder().addStroke(stroke[0]).build();
            boolean accepted = dispatchGesture(g, new GestureResultCallback() {
                @Override
                public void onCompleted(GestureDescription d) {
                    if (more) next[0].run();
                }

                @Override
                public void onCancelled(GestureDescription d) {
                    // Another gesture (or a real touch) took over; the stroke is gone
                }
            }, main);
            if (!reported[0]) {
                reported[0] = true;
                done.done(accepted ? null : "The device refused the gesture");
            }
        };
        next[0].run();
    }

    /** back, home, recents, notifications, lock; enter and backspace act on the focused field. */
    public void key(String key, Done done) {
        main.post(() -> {
            int action;
            switch (key) {
                case "back": action = GLOBAL_ACTION_BACK; break;
                case "home": action = GLOBAL_ACTION_HOME; break;
                case "recents": action = GLOBAL_ACTION_RECENTS; break;
                case "notifications": action = GLOBAL_ACTION_NOTIFICATIONS; break;
                case "lock":
                    action = Build.VERSION.SDK_INT >= 28 ? GLOBAL_ACTION_LOCK_SCREEN : -1;
                    break;
                case "enter":
                    done.done(enter());
                    return;
                case "backspace":
                    done.done(backspace());
                    return;
                default:
                    done.done("Unknown key: " + key);
                    return;
            }
            done.done(action >= 0 && performGlobalAction(action) ? null : "The device refused the key");
        });
    }

    /** Types text at the cursor of the focused text field. */
    public void text(String text, Done done) {
        main.post(() -> {
            AccessibilityNodeInfo field = focusedField();
            if (field == null) {
                done.done("Tap a text field first");
                return;
            }
            String current = currentText(field);
            int[] sel = selection(field, current);
            String updated = current.substring(0, sel[0]) + text + current.substring(sel[1]);
            done.done(setText(field, updated, sel[0] + text.length()) ? null : "The text field didn't accept the text");
        });
    }

    private String backspace() {
        AccessibilityNodeInfo field = focusedField();
        if (field == null) return "Tap a text field first";
        String current = currentText(field);
        int[] sel = selection(field, current);
        int start = sel[0];
        if (sel[0] == sel[1]) {
            if (start == 0) return null;
            start = current.offsetByCodePoints(start, -1);
        }
        return setText(field, current.substring(0, start) + current.substring(sel[1]), start)
                ? null : "The text field didn't accept the change";
    }

    private String enter() {
        AccessibilityNodeInfo field = focusedField();
        if (field == null) return "Tap a text field first";
        if (Build.VERSION.SDK_INT >= 30
                && field.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.getId())) {
            return null;
        }
        return "The text field has no Enter action";
    }

    /**
     * The focused text field, fetched fresh: this service only listens to window
     * changes, so Android's node cache isn't told about text edits, and editing
     * from a stale copy would undo what was just typed.
     */
    private AccessibilityNodeInfo focusedField() {
        AccessibilityNodeInfo node = findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
        if (node == null || !node.refresh()) return null;
        if (!node.isEditable()) {
            // A WebView reports itself as focused; the field is in its page's tree
            AccessibilityNodeInfo inner = node.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
            node = inner != null && inner.isEditable() ? inner : focusedEditableIn(node);
            if (node == null || !node.refresh()) return null;
        }
        return node.isEditable() ? node : null;
    }

    private static AccessibilityNodeInfo focusedEditableIn(AccessibilityNodeInfo root) {
        java.util.ArrayDeque<AccessibilityNodeInfo> queue = new java.util.ArrayDeque<>();
        queue.add(root);
        for (int seen = 0; !queue.isEmpty() && seen < 5000; seen++) {
            AccessibilityNodeInfo n = queue.poll();
            if (n.isEditable() && n.isFocused()) return n;
            for (int i = 0; i < n.getChildCount(); i++) {
                AccessibilityNodeInfo c = n.getChild(i);
                if (c != null) queue.add(c);
            }
        }
        return null;
    }

    private static String currentText(AccessibilityNodeInfo field) {
        if (Build.VERSION.SDK_INT >= 26 && field.isShowingHintText()) return "";
        CharSequence t = field.getText();
        return t == null ? "" : t.toString();
    }

    /** The selection {start, end}, clamped to the text; the end of the text when unknown. */
    private static int[] selection(AccessibilityNodeInfo field, String text) {
        int a = field.getTextSelectionStart(), b = field.getTextSelectionEnd();
        if (a < 0 || b < 0) return new int[] {text.length(), text.length()};
        a = Math.min(a, text.length());
        b = Math.min(b, text.length());
        return new int[] {Math.min(a, b), Math.max(a, b)};
    }

    private static boolean setText(AccessibilityNodeInfo field, String text, int cursor) {
        Bundle args = new Bundle();
        args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text);
        if (!field.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)) return false;
        Bundle sel = new Bundle();
        sel.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, cursor);
        sel.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, cursor);
        field.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, sel);
        return true;
    }

    private static float clamp(float v, float lo, float hi) {
        return Math.max(lo, Math.min(hi, v));
    }
}
