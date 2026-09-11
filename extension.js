/**
 * extension.js
 *
 * Composition root for the Color Timer Clock GNOME extension.
 */

import { Extension } from 'resource:///org/gnome/shell/misc/extensionUtils.js';

import { DEFAULTS } from './lib/defaults.js';
import { Store } from './lib/store.js';
import { ColorClockWidget } from './widget.js';

export default class ColorClockExtension extends Extension {
    enable() {
        this._store = new Store(this.uuid, DEFAULTS);
        this._store.watch();

        this._widget = new ColorClockWidget(this, this._store);
        this._widget.show();
    }

    disable() {
        if (this._widget) {
            this._widget.destroy();
            this._widget = null;
        }
        if (this._store) {
            this._store.unwatch();
            this._store = null;
        }
    }
}
