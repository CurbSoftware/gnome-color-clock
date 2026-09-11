/**
 * store.js
 *
 * JSON settings store for the GNOME ports. Settings live at
 * ~/.config/<uuid>/settings.json rather than in gschema: the Cinnamon
 * schemas are nested arrays that map badly to gsettings types, and a
 * JSON file keeps the extension installable without a schema compile
 * step. Cost: values are invisible to dconf dumps.
 *
 * The extension and the preferences dialog run in separate processes.
 * Both use this module, and the extension watches the directory with a
 * Gio.FileMonitor so edits made in preferences reload live. Saves are
 * atomic (temp file plus rename) so a crash never truncates settings.
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

export function settingsPath(uuid) {
    return GLib.build_filenamev([GLib.get_user_config_dir(), uuid, "settings.json"]);
}

const WATCH_DELAY_MS = 250;

export class Store {
    constructor(uuid, defaults) {
        this._path = settingsPath(uuid);
        this._defaults = defaults || {};
        this._values = Object.assign({}, this._defaults);
        this._listeners = [];
        this._monitor = null;
        this._monitorId = 0;
        this._watchSource = 0;
        this._lastSaved = null;
        this._load();
    }

    _load() {
        try {
            const [ok, contents] = GLib.file_get_contents(this._path);
            if (!ok || !contents)
                return;
            const text = new TextDecoder().decode(contents);
            const parsed = JSON.parse(text);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                this._values = Object.assign({}, this._defaults, parsed);
                this._lastSaved = text;
            }
        } catch (e) {
            // Missing or unreadable file: defaults stand.
        }
    }

    get(key) {
        return this._values[key];
    }

    set(key, value) {
        this._values[key] = value;
    }

    values() {
        return this._values;
    }

    save() {
        const text = JSON.stringify(this._values, null, 2) + "\n";
        if (text === this._lastSaved)
            return;
        try {
            const dir = GLib.path_get_dirname(this._path);
            if (!GLib.file_test(dir, GLib.FileTest.EXISTS))
                GLib.mkdir_with_parents(dir, 0o700);
            const temp = this._path + ".tmp";
            GLib.file_set_contents(temp, text);
            Gio.File.new_for_path(temp).move(
                Gio.File.new_for_path(this._path),
                Gio.FileCopyFlags.OVERWRITE,
                null,
                null);
            this._lastSaved = text;
        } catch (e) {
            console.error("color-clock store: could not save " + this._path + ": " + e);
        }
    }

    /* Reload from disk when the file changed, then notify listeners.
     * Same-content reloads are skipped so the extension and the prefs
     * process cannot ping-pong. */
    reloadIfChanged() {
        let text = "";
        try {
            const [ok, contents] = GLib.file_get_contents(this._path);
            if (ok && contents)
                text = new TextDecoder().decode(contents);
        } catch (e) {
            return;
        }
        if (text === this._lastSaved)
            return;
        this._lastSaved = text;
        this._load();
        for (const listener of this._listeners)
            listener();
    }

    onChanged(listener) {
        this._listeners.push(listener);
    }

    watch() {
        if (this._monitor)
            return;
        try {
            const dir = Gio.File.new_for_path(GLib.path_get_dirname(this._path));
            this._monitor = dir.monitor_directory(Gio.FileMonitorFlags.NONE, null);
            this._monitorId = this._monitor.connect("changed", (monitor, file) => {
                if (!file || file.get_basename() !== GLib.path_get_basename(this._path))
                    return;
                if (this._watchSource)
                    GLib.source_remove(this._watchSource);
                this._watchSource = GLib.timeout_add(
                    GLib.PRIORITY_DEFAULT, WATCH_DELAY_MS, () => {
                        this._watchSource = 0;
                        this.reloadIfChanged();
                        return GLib.SOURCE_REMOVE;
                    });
            });
        } catch (e) {
            console.error("color-clock store: could not watch " + this._path + ": " + e);
        }
    }

    unwatch() {
        if (this._watchSource) {
            GLib.source_remove(this._watchSource);
            this._watchSource = 0;
        }
        if (this._monitor) {
            if (this._monitorId)
                this._monitor.disconnect(this._monitorId);
            this._monitor.cancel();
            this._monitor = null;
            this._monitorId = 0;
        }
    }
}
