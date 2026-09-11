/**
 * widget.js
 *
 * The desktop widget: up to three cards (clock, timer, chronometer)
 * whose background colors follow per-card schedules. Ported from the
 * Cinnamon desklet's desklet.js. GNOME-forced differences:
 *
 * - No desklet API: an St.Bin on _backgroundGroup (layer "desktop") or
 *   uiGroup (layer "overlay").
 * - Alt+drag moves the widget and persists the position.
 * - Timer and chronometer state persists through the JSON store
 *   instead of hidden Cinnamon settings keys.
 * - GNOME St has no Table, so card rows use Clutter.GridLayout.
 */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Pango from 'gi://Pango';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Tooltips from 'resource:///org/gnome/shell/ui/tooltips.js';

import * as CA from './lib/cardActions.js';

const DEFAULT_TIME_FORMAT = "%H:%M:%S";
const DEFAULT_DATE_FORMAT = "%A, %e %B";

const TIMER_PHASES = ["stopped", "paused", "running", "expired"];
const CHRONO_PHASES = ["stopped", "paused", "running"];

/* A timer that finished while the extension was disabled only re-notifies
 * when it expired recently; a stale expiry from hours ago is not worth a
 * startup pop. */
const STALE_EXPIRY_MS = 10 * 60 * 1000;

const SWATCH_PX = 28;
const TIMER_ADJUST = {
    "minus-hour": -3600,
    "minus-minute": -60,
    "minus-second": -1,
    "plus-hour": 3600,
    "plus-minute": 60,
    "plus-second": 1
};

export function formatStrftime(dateMs, fmt, tzName) {
    if (!fmt)
        return "";
    try {
        let tz;
        if (tzName && String(tzName).trim())
            tz = GLib.TimeZone.new(String(tzName).trim());
        else
            tz = GLib.TimeZone.new_local();
        let dt = GLib.DateTime.new_from_unix_utc(Math.floor(dateMs / 1000));
        if (tz)
            dt = dt.to_timezone(tz);
        const out = dt.format(fmt);
        if (out)
            return out;
    } catch (e) {
    }
    return "";
}

function _pad2(n) {
    return n < 10 ? "0" + n : "" + n;
}

export function formatDuration(ms, ceil, hundredths) {
    const total = Math.max(0, Number(ms) || 0);
    const secs = ceil ? Math.ceil(total / 1000) : Math.floor(total / 1000);
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    let out = h > 0 ? h + ":" + _pad2(m) + ":" + _pad2(s) : _pad2(m) + ":" + _pad2(s);
    if (hundredths && !ceil)
        out += "." + _pad2(Math.floor((total % 1000) / 10));
    return out;
}

function _formatClock(ms, ceil) {
    const total = Math.max(0, Number(ms) || 0);
    const secs = ceil ? Math.ceil(total / 1000) : Math.floor(total / 1000);
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    return (h < 100 ? _pad2(h) : String(h)) + ":" + _pad2(m) + ":" + _pad2(s);
}

function _centerLabelText(label) {
    if (!label || !label.clutter_text)
        return;
    try {
        label.clutter_text.set_line_alignment(Pango.Alignment.CENTER);
        label.clutter_text.x_align = Clutter.ActorAlign.CENTER;
    } catch (e) {
    }
}

class Card {
    constructor(kind, widget) {
        this.widget = widget;
        this.kind = kind;

        this.actor = new St.BoxLayout({
            style_class: "ctc-card",
            vertical: true
        });

        this._title = new St.Label({
            style_class: "ctc-card-title",
            text: widget.cardTitle(kind)
        });
        this._value = new St.Label({ style_class: "ctc-card-value" });
        this._sub = new St.Label({ style_class: "ctc-card-sub" });

        try {
            this._title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            this._title.clutter_text.line_wrap = false;
            this._value.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            this._value.clutter_text.line_wrap = false;
            this._sub.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            this._sub.clutter_text.line_wrap = false;
        } catch (e) {
        }
        _centerLabelText(this._title);
        _centerLabelText(this._value);
        _centerLabelText(this._sub);

        this._content = new St.BoxLayout({
            vertical: true,
            style_class: "ctc-card-content"
        });
        this._content.add_child(this._title);
        this._body = new St.BoxLayout({
            vertical: true,
            style_class: "ctc-card-body"
        });
        this._body.add_child(this._value);
        this._body.add_child(this._sub);
        if (kind !== "clock") {
            this._aux = new St.BoxLayout({ style_class: "ctc-card-aux" });
            this._body.add_child(this._aux);
        }
        this._content.add_child(this._body);
        this.actor.add_child(this._content);
        this.actor.y_expand = true;

        this._swatchBox = new St.Widget({
            style_class: "ctc-swatch",
            layout_manager: new Clutter.BinLayout(),
            reactive: true
        });
        this._swatchBox.set_size(SWATCH_PX, SWATCH_PX);
        this._swatch = new St.DrawingArea({ reactive: true });
        this._swatch.set_size(SWATCH_PX, SWATCH_PX);
        this._swatchColor = null;
        this._swatch.connect("repaint", () => this._paintSwatch());
        this._nextIcon = new St.Icon({
            icon_name: "go-next-symbolic",
            icon_size: 14,
            style_class: "ctc-next-icon",
            reactive: false
        });
        this._nextIcon.x_align = Clutter.ActorAlign.CENTER;
        this._nextIcon.y_align = Clutter.ActorAlign.CENTER;
        this._swatchBox.add_child(this._swatch);
        this._swatchBox.add_child(this._nextIcon);
        this._swatchTooltip = new Tooltips.Tooltip(this._swatchBox, "");
        this._nextText = new St.Label({
            style_class: "ctc-next-label",
            reactive: false
        });
        try {
            this._nextText.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            this._nextText.clutter_text.line_wrap = false;
            this._nextText.clutter_text.set_font_name("Monospace Bold 14");
        } catch (e) {
        }
        _centerLabelText(this._nextText);
        this._buildControls();

        /* The card's whole inline style (margin + colors + transition) is
         * owned here, so every part goes through one string. */
        this._margin = 0;
        this._styleKey = null;
        this._expired = false;
        this._lastRgba = null;
        this._lastSmooth = false;
        this._fitLen = undefined;
    }

    _buildControls() {
        this._ctlButtons = [];
        this._adjustButtons = [];

        if (this.kind !== "clock") {
            this._controls = new St.BoxLayout({ style_class: "ctc-card-controls" });
            this._playButton = this._ctlButton("media-playback-start", "toggle",
                false, "Start");
            this._controls.add_child(this._playButton);
            this._controls.add_child(this._ctlButton("view-refresh", "reset",
                false, "Reset"));
        }

        if (this.kind === "timer" && this._aux) {
            this._aux.add_child(this._ctlButton(null, "minus-hour", true, "-1 hour", true, "-h"));
            this._aux.add_child(this._ctlButton(null, "minus-minute", true, "-1 minute", true, "-m"));
            this._aux.add_child(this._ctlButton(null, "minus-second", true, "-1 second", true, "-s"));
            this._aux.add_child(new St.Label({
                text: "|",
                style_class: "ctc-adjust-sep"
            }));
            this._aux.add_child(this._ctlButton(null, "plus-second", true, "+1 second", true, "+s"));
            this._aux.add_child(this._ctlButton(null, "plus-minute", true, "+1 minute", true, "+m"));
            this._aux.add_child(this._ctlButton(null, "plus-hour", true, "+1 hour", true, "+h"));
        } else if (this.kind === "chrono" && this._aux) {
            this._lapButton = new St.Button({
                style_class: "ctc-ctl ctc-ctl-text ctc-adjust",
                can_focus: true,
                label: "Lap"
            });
            this._ctlButtons.push(this._lapButton);
            this._lapButton.connect("clicked", () => {
                this.widget.onControl(this.kind, "lap");
            });
            new Tooltips.Tooltip(this._lapButton, "Lap");
            this._aux.add_child(this._lapButton);
        }

        this._bottom = new St.BoxLayout({
            style_class: "ctc-card-bottom ctc-footer-host"
        });
        if (this._controls)
            this._bottom.add_child(this._controls);
        this._bottom.add_child(this._nextText);
        this._nextText.x_expand = true;
        this._bottom.add_child(this._swatchBox);
        this._bottom.set_height(38);
        this._nextText.y_align = Clutter.ActorAlign.CENTER;
        this._footerHost = this._bottom;
        this.actor.add_child(this._footerHost);
    }

    _ctlButton(iconName, action, small, tipText, adjust, labelText) {
        let klass = small ? "ctc-ctl ctc-ctl-small" : "ctc-ctl";
        if (labelText)
            klass += " ctc-ctl-text";
        if (adjust)
            klass += " ctc-adjust";
        const props = {
            style_class: klass,
            can_focus: true
        };
        if (labelText)
            props.label = labelText;
        const button = new St.Button(props);
        this._ctlButtons.push(button);
        if (adjust)
            this._adjustButtons.push(button);
        if (!labelText) {
            const icon = new St.Icon({
                icon_name: iconName,
                icon_size: 16
            });
            button.set_child(icon);
            if (iconName === "media-playback-start")
                this._playIcon = icon;
        }
        button.connect("clicked", () => {
            this.widget.onControl(this.kind, action);
        });
        if (tipText) {
            new Tooltips.Tooltip(button, tipText);
            if (iconName === "media-playback-start")
                this._playTooltip = null; /* GNOME Tooltip has no set_text swap; title carried by icon */
        }
        return button;
    }

    setSpacing(px) {
        this._margin = Math.max(0, Math.round(px) || 0);
        this._styleKey = null;
    }

    setPlaying(isRunning) {
        if (this._playIcon)
            this._playIcon.icon_name = isRunning
                ? "media-playback-pause"
                : "media-playback-start";
    }

    setAdjustVisible(visible) {
        for (const button of this._adjustButtons || []) {
            button.reactive = visible;
            button.can_focus = visible;
            if (visible)
                button.remove_style_pseudo_class("dim");
            else
                button.add_style_pseudo_class("dim");
        }
    }

    setLapEnabled(enabled) {
        if (!this._lapButton)
            return;
        this._lapButton.reactive = enabled;
        this._lapButton.can_focus = enabled;
        if (enabled)
            this._lapButton.remove_style_pseudo_class("dim");
        else
            this._lapButton.add_style_pseudo_class("dim");
    }

    setExpired(on) {
        on = !!on;
        if (on === this._expired)
            return;
        this._expired = on;
        this._styleKey = null;
        if (on)
            this.actor.add_style_pseudo_class("expired");
        else
            this.actor.remove_style_pseudo_class("expired");
        this._applyColors(this._lastRgba, this._lastSmooth);
    }

    update(nowMs, rgba, smooth, nextStop, pos) {
        if (this.kind === "clock")
            this._updateClock(nowMs);
        else if (this.kind === "timer")
            this._updateTimer(nowMs);
        else
            this._updateChrono(nowMs);
        this._applyColors(rgba, smooth);
        this._updateNextBar(nextStop, pos);
    }

    _updateNextBar(nextStop, pos) {
        const showBar = this.widget.settings.showNextBar !== false;
        const hasNext = !!(nextStop && Array.isArray(nextStop.rgba));
        const showInfo = showBar && hasNext;

        if (this._nextText)
            this._nextText.visible = showInfo;
        if (this._swatchBox)
            this._swatchBox.visible = showInfo;
        if (this._footerHost) {
            if (this.kind === "clock" && !showInfo)
                this._footerHost.hide();
            else
                this._footerHost.show();
        }
        if (!showInfo)
            return;

        const opts = this.kind === "clock" ? { wrap: true } :
            this.kind === "timer" ? { reverse: true } : {};
        const until = CA.secondsUntilStop(pos, nextStop.t, opts);
        this._nextText.set_text(_formatClock((Number(until) > 0 ? until : 0) * 1000, true));

        this._swatchColor = nextStop.rgba;
        if (this._nextIcon && CA.contrastColors) {
            const fg = CA.contrastColors(nextStop.rgba).fg;
            this._nextIcon.style = "color: " + CA.rgbaToCss(fg) + ";";
        }
        this._swatch.queue_repaint();
    }

    _paintSwatch() {
        const area = this._swatch;
        const cr = area.get_context();
        if (!cr)
            return;
        const [w, h] = area.get_surface_size();
        cr.setSourceRGBA(0, 0, 0, 0);
        cr.rectangle(0, 0, w, h);
        cr.fill();
        const c = this._swatchColor;
        if (c) {
            cr.setSourceRGBA(c[0] / 255, c[1] / 255, c[2] / 255, c[3]);
            cr.rectangle(0, 0, w, h);
            cr.fill();
        }
        cr.setSourceRGBA(10 / 255, 14 / 255, 18 / 255, 0.78);
        cr.setLineWidth(1);
        cr.rectangle(0.5, 0.5, Math.max(0, w - 1), Math.max(0, h - 1));
        cr.stroke();
        cr.$dispose();
    }

    _updateClock(nowMs) {
        try {
            const timeFormat = this.widget.settings.timeFormat || DEFAULT_TIME_FORMAT;
            const dateFormat = this.widget.settings.dateFormat || DEFAULT_DATE_FORMAT;
            const tz = this.widget.settings.clockTimezone;
            this._value.set_text(formatStrftime(nowMs, timeFormat, tz));
            this._sub.set_text(formatStrftime(nowMs, dateFormat, tz));
        } catch (e) {
            console.error("color-clock: could not format clock: " + e);
            this._value.set_text("");
            this._sub.set_text("");
        }
    }

    _updateTimer(nowMs) {
        const phase = this.widget.timer.phase;
        if (phase === "expired") {
            this._title.set_text(this.widget.cardTitle("timer", true));
            this._value.set_text("00:00");
            this._sub.set_text("");
            return;
        }
        this._title.set_text(this.widget.cardTitle("timer"));
        this._value.set_text(formatDuration(
            this.widget.timerRemainingMs(nowMs), true));
        this._sub.set_text(
            phase === "stopped" ? "Ready" :
            phase === "paused" ? "Paused" : "");
    }

    _updateChrono(nowMs) {
        this._value.set_text(formatDuration(
            this.widget.chronoElapsedMs(nowMs), false,
            this.widget.settings.chronoMilliseconds));
        const lap = this.widget.chronoLap;
        if (lap && lap.count > 0) {
            this._sub.set_text("Lap " + String(lap.count) + "  " +
                formatDuration(lap.lastMs, false, this.widget.settings.chronoMilliseconds));
        } else {
            this._sub.set_text("");
        }
    }

    _applyColors(rgba, smooth) {
        this._lastRgba = rgba;
        this._lastSmooth = !!smooth;
        const key = (rgba ? CA.rgbaToKey(rgba) : "default") + "/" +
            (smooth ? "1" : "0") + "/" + this._margin + "/" +
            (this._expired ? "x" : "n");
        if (key === this._styleKey)
            return;
        this._styleKey = key;

        const margin = this._margin > 0 ? "margin: " + this._margin + "px; " : "";
        if (!rgba) {
            this.actor.style = margin;
            return;
        }

        const contrast = CA.contrastColors(rgba);
        const border = this._expired
            ? [contrast.fg[0], contrast.fg[1], contrast.fg[2], 0.9]
            : contrast.border;
        this.actor.style = margin +
            "background-color: " + CA.rgbaToCss(rgba) + ";" +
            "color: " + CA.rgbaToCss(contrast.fg) + ";" +
            "border-color: " + CA.rgbaToCss(border) + ";" +
            "transition-duration: " + (smooth ? 1000 : 0) + "ms;";
    }

    applyFittedSizes(inner, samples) {
        inner = inner || {};
        samples = samples || {};
        const box = {
            width: Math.max(0, Number(inner.width) || 0),
            height: Math.max(0, Number(inner.height) || 0)
        };
        if (box.width < 1 || box.height < 1)
            return;

        const texts = {
            time: samples.value || this._value.get_text() || "23:59:59",
            date: samples.sub || this._sub.get_text() || "Wednesday, 31 December",
            label: this._title.get_text() || ""
        };
        this._fitLen = texts.time.length;
        const maxSizes = {
            time: Number(this.widget.settings.timeSize) || 44,
            date: Number(this.widget.settings.dateSize) || 13,
            timezone: Number(this.widget.settings.labelSize) || 11
        };

        const sizes = CA.computeFittedFontSizes(box.width, box.height, texts, maxSizes);
        this._setFontSizes(sizes);
        if (box.width > 1)
            this._title.width = Math.max(1, Math.floor(box.width));
        this._refineWithMetrics(box, sizes);
    }

    _setFontSizes(sizes) {
        this._value.style = "font-size: " + sizes.time + "pt; color: inherit;";
        this._sub.style = "font-size: " + sizes.date + "pt; color: inherit;";
        this._title.style = "font-size: " + sizes.timezone + "pt; color: inherit;";
    }

    _refineWithMetrics(inner, sizes) {
        if (!this.actor || !this.actor.get_stage())
            return;
        try {
            const gap = CA.CARD_LAYOUT.lineGap;
            for (let i = 0; i < 8; i++) {
                const valueW = this._value.get_preferred_width(-1)[1];
                const subW = this._sub.get_preferred_width(-1)[1];
                const valueH = this._value.get_preferred_height(-1)[1];
                const subH = this._sub.get_preferred_height(-1)[1];
                const titleH = this._title.get_preferred_height(-1)[1];
                const auxH = this._aux ? this._aux.get_preferred_height(-1)[1] : 0;
                const pillH = (this._footerHost && this._footerHost.visible)
                    ? this._footerHost.get_preferred_height(-1)[1] : 0;
                const totalH = valueH + subH + titleH + auxH + pillH + 2 * gap;
                const wide = valueW > inner.width + 1 || subW > inner.width + 1;
                const tall = totalH > inner.height + 1;
                if (!wide && !tall)
                    return;
                sizes.time = Math.max(1, sizes.time * 0.88);
                sizes.date = Math.max(1, Math.min(sizes.date * 0.88, sizes.time));
                sizes.timezone = Math.max(1, Math.min(sizes.timezone * 0.88, sizes.date));
                this._setFontSizes(sizes);
            }
        } catch (e) {
            console.error("color-clock: font metric refine failed: " + e);
        }
    }
}

export class ColorClockWidget {
    constructor(extension, store) {
        this.extension = extension;
        this.store = store;
        this.settings = store.values();
        const translate = extension.gettext.bind(extension);

        this._cards = [];
        this._schedules = { clock: null, timer: null, chrono: null };
        this._notifyTimes = {};
        this._lastPos = { clock: null, chrono: null };
        this._lastBadTimezone = null;
        this._timeout = 0;
        this._fastTimeout = 0;
        this._rebuildTimeout = 0;
        this._fitSource = 0;
        this._fitRetrySource = 0;
        this._destroyed = false;
        this._dragging = false;
        this._dragOffset = [0, 0];
        this._lastDragEnd = 0;
        this._layoutHeight = this.settings.height || 260;
        this._widthSamples = null;
        this._cardInner = null;
        this._gridDims = null;

        this.actor = new St.Bin({
            style_class: "ctc-container",
            reactive: true,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.START
        });
        this._box = new St.BoxLayout({ vertical: true });
        this.actor.set_child(this._box);

        this._capturedId = this.actor.connect("captured-event", (a, event) =>
            this._onCaptured(event));

        store.onChanged(() => this._onSettingsReloaded());

        this._restoreState();
        this._rebuildCards();
        this._applySize();
        this._applyLayer();
        this._applyPosition();
        this._scheduleTick();
    }

    get settings() {
        return this._settings;
    }

    set settings(values) {
        this._settings = values;
    }

    cardTitle(kind, expired) {
        const titles = {
            clock: "Clock",
            timer: expired ? "Time is up" : "Timer",
            chrono: "Chronometer"
        };
        return this.extension.gettext(titles[kind] || kind);
    }

    show() {
        if (this._destroyed)
            return;
        this._applyLayer();
        this._applyPosition();
    }

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;

        for (const source of [this._timeout, this._fastTimeout,
                              this._rebuildTimeout, this._fitSource,
                              this._fitRetrySource]) {
            if (source)
                GLib.source_remove(source);
        }
        this._timeout = 0;
        this._fastTimeout = 0;
        this._rebuildTimeout = 0;
        this._fitSource = 0;
        this._fitRetrySource = 0;

        this._cards = [];

        if (this._capturedId) {
            this.actor.disconnect(this._capturedId);
            this._capturedId = 0;
        }
        if (this.actor.get_parent())
            this.actor.get_parent().remove_child(this.actor);
        this.actor.destroy();
    }

    /* ------------------------------------------------------------------ *
     * Settings reactions
     * ------------------------------------------------------------------ */

    _onSettingsReloaded() {
        if (this._destroyed)
            return;
        this.settings = this.store.values();
        this._applySize();
        this._applyLayer();
        this._applyPosition();
        if (this.timer.phase === "stopped") {
            const duration = this._timerDurationFromSettings();
            if (duration !== this.timer.durationSec) {
                this.timer.durationSec = duration;
                this._persistTimer();
            }
        }
        this._lastBadTimezone = null;
        if (this._rebuildTimeout)
            GLib.source_remove(this._rebuildTimeout);
        this._rebuildTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            this._rebuildTimeout = 0;
            this._rebuildCards();
            return GLib.SOURCE_REMOVE;
        });
    }

    _applySize() {
        this._box.width = Math.max(200, Number(this.settings.width) || 840);
        this._box.height = this._layoutHeight || 260;
    }

    _applyLayer() {
        const parent = this.actor.get_parent();
        if (parent)
            parent.remove_child(this.actor);
        const group = this.settings.layer === "overlay"
            ? Main.uiGroup
            : Main.layoutManager._backgroundGroup;
        group.add_child(this.actor);
    }

    _applyPosition() {
        const monitor = Main.layoutManager.primaryMonitor;
        const width = this._box.width;
        const height = this._box.height;
        let x = Number(this.settings.positionX) || 0;
        let y = Number(this.settings.positionY) || 0;
        if (monitor) {
            x = Math.min(Math.max(x, monitor.x), monitor.x + Math.max(0, monitor.width - width));
            y = Math.min(Math.max(y, monitor.y), monitor.y + Math.max(0, monitor.height - height));
        }
        this.actor.set_position(Math.round(x), Math.round(y));
    }

    _onCaptured(event) {
        const type = event.type();
        if (type === Clutter.EventType.BUTTON_PRESS) {
            const button = event.get_button();
            const state = event.get_state();
            const alt = (state & Clutter.ModifierType.MOD1_MASK) !== 0;
            if (button === 1 && alt) {
                const [stageX, stageY] = event.get_coords();
                const [actorX, actorY] = this.actor.get_position();
                this._dragging = true;
                this._dragOffset = [stageX - actorX, stageY - actorY];
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        }
        if (!this._dragging)
            return Clutter.EVENT_PROPAGATE;
        if (type === Clutter.EventType.MOTION) {
            const [stageX, stageY] = event.get_coords();
            this.actor.set_position(
                Math.round(stageX - this._dragOffset[0]),
                Math.round(stageY - this._dragOffset[1]));
            return Clutter.EVENT_STOP;
        }
        if (type === Clutter.EventType.BUTTON_RELEASE) {
            this._dragging = false;
            this._lastDragEnd = Date.now();
            const [x, y] = this.actor.get_position();
            this.store.set("positionX", x);
            this.store.set("positionY", y);
            this.store.save();
            this._applyPosition();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    /* ------------------------------------------------------------------ *
     * Card construction
     * ------------------------------------------------------------------ */

    _visibleKinds() {
        const kinds = [];
        if (this.settings.showClock)
            kinds.push("clock");
        if (this.settings.showTimer)
            kinds.push("timer");
        if (this.settings.showChronometer)
            kinds.push("chrono");
        return kinds;
    }

    _rebuildCards() {
        if (this._destroyed)
            return;
        try {
            this._refreshSchedules();
            this._box.destroy_all_children();
            this._box.remove_style_class_name("ctc-compact");
            this._box.remove_style_class_name("ctc-empty-container");
            this._cards = [];

            const kinds = this._visibleKinds();
            if (kinds.length === 0) {
                this._layoutHeight = Math.max(Number(this.settings.height) || 260, 150);
                this._box.height = this._layoutHeight;
                this._box.add_style_class_name("ctc-empty-container");
                const empty = new St.Label({
                    text: this.extension.gettext("No cards enabled"),
                    style_class: "ctc-empty-title"
                });
                _centerLabelText(empty);
                this._box.add_child(empty);
                this._gridDims = { rows: 0, cols: 0 };
                this._cardInner = null;
                this._widthSamples = null;
                return;
            }

            const dims = CA.computeResponsiveGrid(
                kinds.length, this.settings.width, this.settings.cardSpacing);
            this._gridDims = dims;
            this._layoutHeight = CA.computeResponsiveHeight(
                dims.rows, this.settings.height, this.settings.cardSpacing);
            this._box.height = this._layoutHeight;
            if (dims.rows > 1)
                this._box.add_style_class_name("ctc-compact");

            const grid = new St.BoxLayout({
                vertical: true,
                style_class: "ctc-grid"
            });
            this._box.add_child(grid);

            const availableWidth = Math.max(1, (Number(this.settings.width) || 840) - 8);
            const rowLayouts = [];
            for (let row = 0; row < dims.rows; row++) {
                const rowStart = row * dims.cols;
                const rowCount = Math.min(dims.cols, kinds.length - rowStart);
                const rowTable = new St.Widget({
                    style_class: "ctc-grid-row",
                    layout_manager: new Clutter.GridLayout()
                });
                rowTable.layout_manager.set_row_homogeneous(true);
                rowTable.layout_manager.set_column_homogeneous(true);
                rowTable.width = Math.floor(availableWidth * rowCount / dims.cols);
                const rowHost = new St.Bin({
                    y_align: Clutter.ActorAlign.CENTER,
                    x_align: Clutter.ActorAlign.CENTER
                });
                rowHost.set_child(rowTable);
                grid.add_child(rowHost);
                rowLayouts.push(rowTable.layout_manager);
            }

            for (let i = 0; i < kinds.length; i++) {
                const card = new Card(kinds[i], this);
                card.setSpacing(this.settings.cardSpacing);
                const row = Math.floor(i / dims.cols);
                const indexInRow = i % dims.cols;
                rowLayouts[row].attach(card.actor, indexInRow, 0, 1, 1);
                this._cards.push(card);
            }

            this._updateAll();
            this._widthSamples = this._formatWidthSamples();
            this._cardInner = CA.computeCardInnerSize(
                this.settings.width || 840, this._layoutHeight,
                Math.max(1, dims.rows), Math.max(1, dims.cols),
                this.settings.cardSpacing);
            this._scheduleFit();
        } catch (e) {
            console.error("color-clock: card rebuild failed: " + e);
        }
    }

    _refreshSchedules() {
        this._schedules = {};
        this._notifyTimes = {};
        for (const kind of ["clock", "timer", "chrono"]) {
            const rows = {
                clock: this.settings.clockSchedule,
                timer: this.settings.timerSchedule,
                chrono: this.settings.chronoSchedule
            }[kind];
            const result = CA.normalizeSchedule(rows, CA.DAY_SECONDS);
            if (result.dropped > 0)
                console.warn("color-clock: dropped " + result.dropped +
                    " " + kind + " schedule row(s) with an unparsable time or colour");
            this._schedules[kind] = result.stops;
            this._notifyTimes[kind] = result.stops
                .filter(s => s.notify)
                .map(s => s.t);
        }
        this._lastPos = { clock: null, chrono: null };
    }

    /* ------------------------------------------------------------------ *
     * Timer / chronometer state machines
     * ------------------------------------------------------------------ */

    _timerDurationFromSettings() {
        const mins = Number(this.settings.timerMinutes) || 0;
        const secs = Number(this.settings.timerSeconds) || 0;
        return Math.max(1, Math.min(86400, Math.round(mins * 60 + secs)));
    }

    get timer() {
        if (!this._timer)
            this._timer = { phase: "stopped", durationSec: this._timerDurationFromSettings(), endMs: 0, remainingMs: 0 };
        return this._timer;
    }

    get chrono() {
        if (!this._chrono)
            this._chrono = { phase: "stopped", startMs: 0, accumMs: 0 };
        return this._chrono;
    }

    get chronoLap() {
        if (!this._chronoLap)
            this._chronoLap = { count: 0, lastMs: 0 };
        return this._chronoLap;
    }

    _restoreState() {
        const now = Date.now();

        const savedTimer = this.store.get("timerState");
        let t = (savedTimer && TIMER_PHASES.includes(savedTimer.phase) &&
                 Number.isFinite(savedTimer.durationSec) &&
                 Number.isFinite(savedTimer.endMs) &&
                 Number.isFinite(savedTimer.remainingMs))
            ? {
                phase: savedTimer.phase,
                durationSec: Math.max(1, Math.min(86400, Math.round(savedTimer.durationSec))),
                endMs: savedTimer.endMs,
                remainingMs: Math.max(0, savedTimer.remainingMs)
            }
            : { phase: "stopped", durationSec: this._timerDurationFromSettings(), endMs: 0, remainingMs: 0 };
        if (t.phase === "stopped")
            t.durationSec = this._timerDurationFromSettings();
        if (t.phase === "running" && t.endMs <= now) {
            t.phase = "expired";
            if (now - t.endMs <= STALE_EXPIRY_MS)
                this._notifyTimerExpired();
        }
        this._timer = t;
        this._persistTimer();

        const savedChrono = this.store.get("chronoState");
        this._chrono = (savedChrono && CHRONO_PHASES.includes(savedChrono.phase) &&
                        Number.isFinite(savedChrono.startMs) &&
                        Number.isFinite(savedChrono.accumMs))
            ? {
                phase: savedChrono.phase,
                startMs: savedChrono.startMs,
                accumMs: Math.max(0, savedChrono.accumMs)
            }
            : { phase: "stopped", startMs: 0, accumMs: 0 };
        this._chronoLap = { count: 0, lastMs: 0 };
        this._persistChrono();
    }

    _persistTimer() {
        if (this._timer)
            this.store.set("timerState", {
                phase: this._timer.phase,
                durationSec: this._timer.durationSec,
                endMs: this._timer.endMs,
                remainingMs: this._timer.remainingMs
            });
    }

    _persistChrono() {
        if (this._chrono)
            this.store.set("chronoState", {
                phase: this._chrono.phase,
                startMs: this._chrono.startMs,
                accumMs: this._chrono.accumMs
            });
    }

    _notifyTimerExpired() {
        if (!this.settings.timerNotify)
            return;
        try {
            Main.notify(this.extension.gettext("Timer finished"),
                        this.extension.gettext("The timer reached zero."));
        } catch (e) {
            console.error("color-clock: notify failed: " + e);
        }
    }

    _checkNotifyCrossing(kind, pos) {
        const times = this._notifyTimes ? this._notifyTimes[kind] : null;
        if (!times || !times.length)
            return;
        const prev = this._lastPos ? this._lastPos[kind] : null;
        this._lastPos[kind] = pos;
        if (prev == null)
            return;
        const crossed = CA.thresholdsCrossed(prev, pos, times, kind === "clock");
        for (const t of crossed)
            this._notifyCardTime(kind, t);
    }

    _notifyCardTime(kind, t) {
        let body;
        if (kind === "clock") {
            const h = Math.floor(t / 3600);
            const m = Math.floor((t % 3600) / 60);
            body = "It is now " + _pad2(h) + ":" + _pad2(m) + ".";
        } else {
            body = "Reached " + formatDuration(t * 1000, false, false) + ".";
        }
        try {
            Main.notify(this.cardTitle(kind), this.extension.gettext(body));
        } catch (e) {
            console.error("color-clock: notify failed: " + e);
        }
    }

    timerRemainingMs(nowMs) {
        const t = this.timer;
        if (t.phase === "running")
            return Math.max(0, t.endMs - nowMs);
        if (t.phase === "paused")
            return Math.max(0, t.remainingMs);
        if (t.phase === "stopped")
            return t.durationSec * 1000;
        return 0;
    }

    chronoElapsedMs(nowMs) {
        const c = this.chrono;
        if (c.phase === "running")
            return c.accumMs + (nowMs - c.startMs);
        if (c.phase === "paused")
            return c.accumMs;
        return 0;
    }

    onControl(kind, action) {
        try {
            if (this._destroyed)
                return;
            if (kind === "timer")
                this._timerControl(action);
            else if (kind === "chrono")
                this._chronoControl(action);
            this._updateAll();
        } catch (e) {
            console.error("color-clock: control failed: " + e);
        }
    }

    _timerControl(action) {
        const now = Date.now();
        const t = this.timer;

        if (action === "toggle") {
            if (t.phase === "running") {
                t.remainingMs = Math.max(0, t.endMs - now);
                t.phase = t.remainingMs > 0 ? "paused" : "expired";
                if (t.phase === "expired")
                    this._notifyTimerExpired();
            } else {
                const fromStopped = t.phase === "stopped" || t.phase === "expired";
                t.remainingMs = fromStopped
                    ? t.durationSec * 1000
                    : Math.max(0, t.remainingMs);
                t.phase = "running";
                t.endMs = now + t.remainingMs;
            }
        } else if (action === "reset") {
            t.phase = "stopped";
            t.durationSec = this._timerDurationFromSettings();
            t.endMs = 0;
            t.remainingMs = 0;
        } else if (TIMER_ADJUST[action] !== undefined) {
            if (t.phase !== "stopped")
                return;
            t.durationSec = Math.max(1, Math.min(86400, t.durationSec + TIMER_ADJUST[action]));
        } else {
            return;
        }

        this._persistTimer();
        this.store.save();
    }

    _chronoControl(action) {
        const now = Date.now();
        const c = this.chrono;

        if (action === "toggle") {
            if (c.phase === "running") {
                c.accumMs += now - c.startMs;
                c.phase = "paused";
            } else {
                if (c.phase === "stopped") {
                    c.accumMs = 0;
                    this._chronoLap = { count: 0, lastMs: 0 };
                }
                c.startMs = now;
                c.phase = "running";
            }
        } else if (action === "reset") {
            c.phase = "stopped";
            c.startMs = 0;
            c.accumMs = 0;
            this._chronoLap = { count: 0, lastMs: 0 };
        } else if (action === "lap") {
            if (c.phase !== "running")
                return;
            this.chronoLap.count++;
            this.chronoLap.lastMs = this.chronoElapsedMs(now);
            return;
        } else {
            return;
        }

        this._persistChrono();
        this.store.save();
    }

    /* ------------------------------------------------------------------ *
     * Per-second update
     * ------------------------------------------------------------------ */

    _clockWallParts(now) {
        const timezoneName = (this.settings.clockTimezone || "").trim();
        try {
            const tz = timezoneName
                ? GLib.TimeZone.new(timezoneName)
                : GLib.TimeZone.new_local();
            const dt = GLib.DateTime.new_from_unix_utc(Math.floor(now / 1000))
                .to_timezone(tz);
            return {
                hours: dt.get_hour(),
                minutes: dt.get_minute(),
                seconds: dt.get_second()
            };
        } catch (e) {
            if (timezoneName && this._lastBadTimezone !== timezoneName) {
                this._lastBadTimezone = timezoneName;
                console.error("color-clock: invalid timezone: " + timezoneName + ": " + e);
            }
            const date = new Date(now);
            return {
                hours: date.getHours(),
                minutes: date.getMinutes(),
                seconds: date.getSeconds()
            };
        }
    }

    _smoothFor(kind) {
        if (kind === "clock")
            return !!this.settings.clockSmooth;
        if (kind === "timer")
            return !!this.settings.timerSmooth;
        return !!this.settings.chronoSmooth;
    }

    _updateAll() {
        if (this._destroyed)
            return;

        try {
            const nowMs = Date.now();

            if (this.timer.phase === "running" && this.timer.endMs <= nowMs) {
                this.timer.phase = "expired";
                this._persistTimer();
                this.store.save();
                this._notifyTimerExpired();
            }

            const clockParts = this._clockWallParts(nowMs);

            for (const card of this._cards) {
                const smooth = this._smoothFor(card.kind);
                let pos, rgba, nextStop;

                if (card.kind === "clock") {
                    pos = clockParts.hours * 3600 +
                        clockParts.minutes * 60 +
                        clockParts.seconds;
                    rgba = CA.evaluate(this._schedules.clock, pos, {
                        wrap: true,
                        smooth
                    });
                    nextStop = CA.nextStop(this._schedules.clock, pos, { wrap: true });
                } else if (card.kind === "timer") {
                    pos = this.timerRemainingMs(nowMs) / 1000;
                    rgba = CA.evaluate(this._schedules.timer, pos, {
                        smooth
                    });
                    nextStop = CA.nextStop(this._schedules.timer, pos, { reverse: true });
                } else {
                    pos = this.chronoElapsedMs(nowMs) / 1000;
                    rgba = CA.evaluate(this._schedules.chrono, pos, {
                        smooth
                    });
                    nextStop = CA.nextStop(this._schedules.chrono, pos, {});
                }
                card.update(nowMs, rgba, smooth, nextStop, pos);
                this._checkNotifyCrossing(card.kind, pos);
            }

            for (const card of this._cards) {
                if (card._fitLen !== undefined &&
                    (card._value.get_text() || "").length !== card._fitLen) {
                    this._scheduleFit();
                    break;
                }
            }

            this._syncControlStates();
        } catch (e) {
            console.error("color-clock: update failed: " + e);
        }
    }

    _syncControlStates() {
        for (const card of this._cards) {
            if (card.kind === "timer") {
                card.setPlaying(this.timer.phase === "running");
                card.setAdjustVisible(this.timer.phase === "stopped");
                card.setExpired(this.timer.phase === "expired");
            } else if (card.kind === "chrono") {
                card.setPlaying(this.chrono.phase === "running");
                card.setLapEnabled(this.chrono.phase === "running");
                card.setExpired(false);
            }
        }
        this._syncFastTick();
    }

    _syncFastTick() {
        let want = false;
        if (!this._destroyed && this.settings.chronoMilliseconds &&
            this.chrono.phase === "running") {
            for (const card of this._cards) {
                if (card.kind === "chrono") {
                    want = true;
                    break;
                }
            }
        }
        if (want && !this._fastTimeout) {
            this._fastTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
                if (this._destroyed) {
                    this._fastTimeout = 0;
                    return GLib.SOURCE_REMOVE;
                }
                for (const card of this._cards) {
                    if (card.kind === "chrono") {
                        card._updateChrono(Date.now());
                        break;
                    }
                }
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!want && this._fastTimeout) {
            GLib.source_remove(this._fastTimeout);
            this._fastTimeout = 0;
        }
    }

    _scheduleTick() {
        if (this._timeout)
            GLib.source_remove(this._timeout);
        this._timeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            if (this._destroyed)
                return GLib.SOURCE_REMOVE;
            try {
                this._updateAll();
            } catch (e) {
                console.error("color-clock: tick failed: " + e);
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    /* ------------------------------------------------------------------ *
     * Font fitting
     * ------------------------------------------------------------------ */

    _formatWidthSamples() {
        const timeFormat = this.settings.timeFormat || DEFAULT_TIME_FORMAT;
        const dateFormat = this.settings.dateFormat || DEFAULT_DATE_FORMAT;
        const dates = [
            Date.UTC(2023, 11, 27, 23, 59, 59),
            Date.UTC(2023, 8, 20, 12, 0, 0),
            Date.now()
        ];
        let sub = "";
        for (let i = 0; i < dates.length; i++) {
            const d = formatStrftime(dates[i], dateFormat, this.settings.clockTimezone);
            if (String(d).length > sub.length)
                sub = d;
        }
        const clockSample = CA.worstTimeSample(timeFormat);
        const chronoSample = this.settings.chronoMilliseconds ? "99:59:59.99" : "99:59:59";
        let value = clockSample.length >= chronoSample.length ? clockSample : chronoSample;
        for (const card of this._cards) {
            const v = card._value.get_text();
            if (v && v.length > value.length)
                value = v;
        }
        return {
            value: value || "23:59:59",
            clock: clockSample,
            chrono: chronoSample,
            timer: "99:59:59",
            sub: sub || "Wednesday, 31 December"
        };
    }

    _scheduleFit() {
        if (this._fitSource)
            GLib.source_remove(this._fitSource);
        this._fitSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 0, () => {
            this._fitSource = 0;
            if (this._destroyed)
                return GLib.SOURCE_REMOVE;
            this._fitAllCards(this._cardInner);
            if (this._fitRetrySource)
                GLib.source_remove(this._fitRetrySource);
            this._fitRetrySource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
                this._fitRetrySource = 0;
                if (this._destroyed)
                    return GLib.SOURCE_REMOVE;
                this._fitAllCards(this._cardInner);
                return GLib.SOURCE_REMOVE;
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    _fitAllCards(inner) {
        if (!inner)
            return;
        const samples = this._widthSamples || this._formatWidthSamples();
        this._widthSamples = samples;
        for (const card of this._cards) {
            let sampleValue = samples.value;
            if (card.kind === "clock" && samples.clock)
                sampleValue = samples.clock;
            else if (card.kind === "chrono" && samples.chrono)
                sampleValue = samples.chrono;
            else if (card.kind === "timer" && samples.timer)
                sampleValue = samples.timer;
            const live = card._value.get_text() || "";
            if (live.length > sampleValue.length)
                sampleValue = live;
            card.applyFittedSizes(inner, {
                value: sampleValue,
                sub: samples.sub
            });
        }
    }
}
