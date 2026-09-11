/**
 * defaults.js
 *
 * Default settings for the Color Timer Clock extension. Mirrors the
 * Cinnamon desklet's settings-schema.json defaults, plus the two
 * GNOME-specific keys: layer and position.
 */

export const DEFAULTS = {
    showClock: true,
    showTimer: true,
    showChronometer: true,
    showNextBar: true,
    clockTimezone: "",
    clockSchedule: [
        { hour: 6, color: "#f4433c" },
        { hour: 12, color: "#9c27b0" },
        { hour: 18, color: "#3949ab" }
    ],
    clockSmooth: true,
    timerMinutes: 5,
    timerSeconds: 0,
    timerSchedule: [
        { remaining: 60, color: "#43a047" },
        { remaining: 30, color: "#fdd835" },
        { remaining: 0, color: "#f4433c" }
    ],
    timerSmooth: true,
    timerNotify: false,
    chronoSchedule: [
        { elapsed: 0, color: "#00897b" },
        { elapsed: 1800, color: "#f4511e" }
    ],
    chronoSmooth: true,
    chronoMilliseconds: false,
    timeFormat: "%H:%M:%S",
    dateFormat: "%A, %e %B",
    timeSize: 44,
    dateSize: 13,
    labelSize: 11,
    cardSpacing: 6,
    width: 840,
    height: 260,
    layer: "desktop",
    positionX: 64,
    positionY: 64
};
