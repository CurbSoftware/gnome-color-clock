/**
 * prefs.js
 *
 * Preferences window for the Color Timer Clock extension: card
 * visibility, per-card color schedules, timer duration, and display
 * formatting. Writes go through the same JSON store the extension
 * watches, so edits apply live.
 */

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gtk from 'gi://Gtk';

import { ExtensionPreferences } from 'resource:///org/gnome/shell/misc/extensionUtils.js';

import * as CA from './lib/cardActions.js';
import { DEFAULTS } from './lib/defaults.js';
import { Store } from './lib/store.js';

const LAYERS = ["desktop", "overlay"];

const SCHEDULE_KINDS = [
    { kind: "clock", key: "clockSchedule", title: "Clock schedule",
      subtitle: "Stops by time of day", notify: true, timeStyle: "clock" },
    { kind: "timer", key: "timerSchedule", title: "Timer schedule",
      subtitle: "Stops by seconds remaining", notify: false, timeStyle: "seconds" },
    { kind: "chrono", key: "chronoSchedule", title: "Chronometer schedule",
      subtitle: "Stops by seconds elapsed", notify: true, timeStyle: "seconds" }
];

export default class ColorClockPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        this._store = new Store(this.uuid, DEFAULTS);

        window.add(this._cardsPage());
        window.add(this._schedulesPage());
        window.add(this._displayPage());
        window.set_default_size(620, 680);
    }

    _save() {
        this._store.save();
    }

    /* ------------------------------------------------------------------ *
     * Cards page
     * ------------------------------------------------------------------ */

    _cardsPage() {
        const page = new Adw.PreferencesPage({
            title: "Cards",
            icon_name: "preferences-system-symbolic"
        });

        const group = new Adw.PreferencesGroup({ title: "Cards" });
        for (const [key, title] of [
            ["showClock", "Clock"],
            ["showTimer", "Timer"],
            ["showChronometer", "Chronometer"]
        ]) {
            group.add(this._switchRow(title, key));
        }
        group.add(this._switchRow("Show footer bar", "showNextBar",
            "Counts down to the next colour on each card"));
        page.add(group);

        const clock = new Adw.PreferencesGroup({ title: "Clock card" });
        const zones = CA.listTimezones();
        const labels = new Gtk.StringList();
        for (const zone of zones)
            labels.append(zone === "local" ? "Local (system timezone)" : zone);
        const picker = new Adw.ComboRow({
            title: "Timezone",
            model: labels,
            enable_search: true
        });
        const current = (this._store.get("clockTimezone") || "").trim();
        const index = zones.indexOf(current || "local");
        if (index >= 0)
            picker.set_selected(index);
        picker.connect("notify::selected", () => {
            const zone = zones[picker.get_selected()];
            this._store.set("clockTimezone", zone === "local" ? "" : zone);
            this._save();
        });
        clock.add(picker);
        page.add(clock);

        const timer = new Adw.PreferencesGroup({ title: "Timer card" });
        timer.add(this._spinRow("Default minutes", "timerMinutes",
            this._store.get("timerMinutes"), 0, 1440, 1));
        timer.add(this._spinRow("Default seconds", "timerSeconds",
            this._store.get("timerSeconds"), 0, 59, 1));
        timer.add(this._switchRow("Notify when the timer finishes", "timerNotify"));
        page.add(timer);

        return page;
    }

    /* ------------------------------------------------------------------ *
     * Schedules page
     * ------------------------------------------------------------------ */

    _schedulesPage() {
        const page = new Adw.PreferencesPage({
            title: "Schedules",
            icon_name: "preferences-color-symbolic"
        });

        const reset = new Adw.PreferencesGroup();
        const resetButton = new Gtk.Button({
            label: "Reset all schedules to defaults",
            valign: Gtk.Align.CENTER
        });
        resetButton.connect("clicked", () => {
            this._store.set("clockSchedule", CA.DEFAULT_CLOCK_SCHEDULE);
            this._store.set("timerSchedule", CA.DEFAULT_TIMER_SCHEDULE);
            this._store.set("chronoSchedule", CA.DEFAULT_CHRONO_SCHEDULE);
            this._save();
            this._rebuildScheduleRows();
        });
        reset.add(resetButton);
        page.add(reset);

        this._scheduleLists = {};
        for (const spec of SCHEDULE_KINDS) {
            const group = new Adw.PreferencesGroup({
                title: spec.title,
                description: spec.subtitle
            });
            const add = new Gtk.Button({
                label: "+",
                valign: Gtk.Align.CENTER,
                tooltip_text: "Add stop"
            });
            add.connect("clicked", () => this._addScheduleRow(spec));
            group.add(add);
            const list = new Gtk.ListBox({ selection_mode: Gtk.SelectionMode.NONE });
            list.add_css_class("boxed-list");
            group.add(list);
            this._scheduleLists[spec.kind] = { list, spec };
            page.add(group);
        }
        this._rebuildScheduleRows();
        return page;
    }

    _rebuildScheduleRows() {
        for (const kind of Object.keys(this._scheduleLists)) {
            const { list } = this._scheduleLists[kind];
            let child = list.get_first_child();
            while (child) {
                const next = child.get_next_sibling();
                list.remove(child);
                child = next;
            }
        }
        for (const spec of SCHEDULE_KINDS) {
            const rows = Array.isArray(this._store.get(spec.key))
                ? this._store.get(spec.key) : [];
            const { list } = this._scheduleLists[spec.kind];
            for (const row of rows)
                list.append(this._scheduleRow(spec, row));
        }
    }

    _addScheduleRow(spec) {
        const rows = (Array.isArray(this._store.get(spec.key))
            ? this._store.get(spec.key) : []).slice();
        rows.push(spec.timeStyle === "clock"
            ? { hour: 0, color: "#888888" }
            : spec.kind === "timer"
                ? { remaining: 60, color: "#888888" }
                : { elapsed: 60, color: "#888888" });
        this._store.set(spec.key, rows);
        this._save();
        this._rebuildScheduleRows();
    }

    _scheduleRow(spec, row) {
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            margin_top: 8,
            margin_bottom: 8,
            margin_start: 8,
            margin_end: 8
        });

        const rows = () => Array.isArray(this._store.get(spec.key))
            ? this._store.get(spec.key) : [];
        const write = (next) => {
            this._store.set(spec.key, next);
            this._save();
        };

        const updateTime = (patch) => {
            const next = rows().map(r => r === row ? Object.assign({}, r, patch) : r);
            write(next);
        };

        if (spec.timeStyle === "clock") {
            const hour = this._plainSpin(row.hour || 0, 0, 23, 1);
            const minute = this._plainSpin(row.minute || 0, 0, 59, 1);
            hour.connect("notify::value", () => updateTime({ hour: hour.get_value() }));
            minute.connect("notify::value", () => updateTime({ minute: minute.get_value() }));
            box.append(hour);
            box.append(minute);
        } else {
            const key = spec.kind === "timer" ? "remaining" : "elapsed";
            const seconds = this._plainSpin(row[key] || 0, 0, 86400, 30);
            seconds.connect("notify::value", () => {
                const patch = {};
                patch[key] = seconds.get_value();
                updateTime(patch);
            });
            box.append(seconds);
        }

        const colorButton = new Gtk.ColorDialogButton({
            dialog: new Gtk.ColorDialog(),
            valign: Gtk.Align.CENTER
        });
        const rgba = new Gdk.RGBA();
        const parsed = CA.parseColor(row.color);
        if (parsed.ok && rgba.parse(CA.rgbaToCss(parsed.rgba)))
            colorButton.set_rgba(rgba);
        colorButton.connect("notify::rgba", () => {
            const value = colorButton.get_rgba();
            const channel = (n) => Math.round(n * 255).toString(16).padStart(2, "0");
            updateTime({ color: "#" + channel(value.red) + channel(value.green) + channel(value.blue) });
        });
        box.append(colorButton);

        if (spec.notify) {
            const notify = new Gtk.Switch({
                active: !!row.notify,
                valign: Gtk.Align.CENTER
            });
            notify.connect("notify::active", () =>
                updateTime({ notify: notify.get_active() }));
            box.append(notify);
        }

        const remove = new Gtk.Button({
            icon_name: "user-trash-symbolic",
            valign: Gtk.Align.CENTER,
            tooltip_text: "Remove stop"
        });
        remove.connect("clicked", () => {
            write(rows().filter(r => r !== row));
            this._rebuildScheduleRows();
        });
        box.append(remove);

        const rowWidget = new Adw.PreferencesRow();
        rowWidget.set_child(box);
        return rowWidget;
    }

    /* ------------------------------------------------------------------ *
     * Display page
     * ------------------------------------------------------------------ */

    _displayPage() {
        const page = new Adw.PreferencesPage({
            title: "Display",
            icon_name: "preferences-desktop-appearance-symbolic"
        });

        const formats = new Adw.PreferencesGroup({
            title: "Formats",
            description: "strftime patterns, for example %H:%M:%S or %A, %e %B"
        });
        formats.add(this._entryRow("Time format (strftime)", "timeFormat"));
        formats.add(this._entryRow("Date format (strftime)", "dateFormat"));
        page.add(formats);

        const sizes = new Adw.PreferencesGroup({ title: "Maximum font sizes" });
        sizes.add(this._spinRow("Value (pt)", "timeSize", this._store.get("timeSize"), 6, 96, 1));
        sizes.add(this._spinRow("Subtitle (pt)", "dateSize", this._store.get("dateSize"), 6, 96, 1));
        sizes.add(this._spinRow("Title (pt)", "labelSize", this._store.get("labelSize"), 6, 96, 1));
        page.add(sizes);

        const behaviour = new Adw.PreferencesGroup({ title: "Behaviour" });
        behaviour.add(this._spinRow("Card spacing (px)", "cardSpacing",
            this._store.get("cardSpacing"), 0, 24, 1));
        behaviour.add(this._switchRow("Chronometer hundredths", "chronoMilliseconds",
            "Needs a faster refresh while the chronometer runs"));
        page.add(behaviour);

        const size = new Adw.PreferencesGroup({ title: "Widget size and placement" });
        size.add(this._spinRow("Width (px)", "width", this._store.get("width"), 200, 3000, 50));
        size.add(this._spinRow("Height (px)", "height", this._store.get("height"), 150, 2000, 50));
        size.add(this._spinRow("Position X (px)", "positionX", this._store.get("positionX"), 0, 8000, 10));
        size.add(this._spinRow("Position Y (px)", "positionY", this._store.get("positionY"), 0, 8000, 10));
        const layer = new Adw.ComboRow({
            title: "Layer",
            model: Gtk.StringList.new(["Desktop (under windows)", "Overlay (always visible)"])
        });
        layer.set_selected(Math.max(0, LAYERS.indexOf(this._store.get("layer"))));
        layer.connect("notify::selected", () => {
            this._store.set("layer", LAYERS[layer.get_selected()] || "desktop");
            this._save();
        });
        size.add(layer);
        page.add(size);

        return page;
    }

    /* ------------------------------------------------------------------ *
     * Row builders
     * ------------------------------------------------------------------ */

    _switchRow(title, key, subtitle) {
        const row = new Adw.SwitchRow({ title });
        if (subtitle)
            row.set_subtitle(subtitle);
        row.set_active(!!this._store.get(key));
        row.connect("notify::active", () => {
            this._store.set(key, row.get_active());
            this._save();
        });
        return row;
    }

    _spinRow(title, key, value, lower, upper, step) {
        const row = new Adw.SpinRow({
            title,
            adjustment: new Gtk.Adjustment({
                value: Number(value) || lower,
                lower,
                upper,
                step_increment: step
            })
        });
        row.connect("notify::value", () => {
            this._store.set(key, Math.round(row.get_value()));
            this._save();
        });
        return row;
    }

    _plainSpin(value, lower, upper, step) {
        return new Gtk.SpinButton({
            value: Number(value) || lower,
            adjustment: new Gtk.Adjustment({
                value: Number(value) || lower,
                lower,
                upper,
                step_increment: step
            }),
            valign: Gtk.Align.CENTER
        });
    }

    _entryRow(title, key) {
        const row = new Adw.EntryRow({ title });
        row.set_text(this._store.get(key) || "");
        row.connect("changed", () => {
            this._store.set(key, row.get_text());
            this._save();
        });
        return row;
    }
}
