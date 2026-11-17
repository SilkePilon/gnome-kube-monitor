// SPDX-FileCopyrightText: 2026 Denys Lysenok
//
// SPDX-License-Identifier: GPL-2.0-or-later

// The view: a PanelMenu.Button and its dropdown menu (St/Clutter). Emits
// refresh-requested, context-selected and menu-open-changed; never reads
// GSettings. Node rows are keyed by name and updated in place between polls.

import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';

import * as Config from 'resource:///org/gnome/shell/misc/config.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {NodeLevel, compareNodes, nodeQualifier, meterLevel, formatDuration} from './model.js';
import {styleVariant, verticalBoxParams} from './theme.js';
import {_, N_, ngettext, format} from './i18n.js';

// Not translated: this is the name the extension is published under, and a
// screen reader saying anything else would not match what is installed.
const APP_NAME = 'Kube Node Monitor';

// St.BoxLayout constructor params for a column, whichever property this shell has.
const VERTICAL = verticalBoxParams(Config.PACKAGE_VERSION, Clutter.Orientation.VERTICAL);

// Scopes the light half of stylesheet.css. St has no media queries, so the
// palette can only follow the theme through a class set from here.
const LIGHT_CLASS = 'kube-light';

/**
 * Point one surface at the palette its own foreground implies.
 * @param {St.Widget} actor the panel button or the menu box
 * @param {'light' | 'dark'} variant
 */
function applyVariant(actor, variant) {
    const light = variant === 'light';
    // Setting the class restyles the actor, so re-entry has to stop here.
    if (light === actor.has_style_class_name(LIGHT_CLASS))
        return;
    if (light)
        actor.add_style_class_name(LIGHT_CLASS);
    else
        actor.remove_style_class_name(LIGHT_CLASS);
}

// Spoken form of each level; the panel's only visual state is a 10px coloured
// dot. N_() because the table is built at module load, before any locale is
// bound; _() happens at lookup.
const LEVEL_WORD = {
    // Translators: spoken cluster state. Every node is Ready.
    ok: N_('healthy'),
    // Translators: spoken cluster state. Something is wrong, nothing is down.
    warning: N_('degraded'),
    // Translators: spoken cluster state. At least one node is down.
    error: N_('critical'),
    // Translators: spoken cluster state. No reading yet, or kubectl failed.
    unknown: N_('status unknown'),
};

// How long the "Mute Alerts" submenu can mute for, in seconds.
const MUTE_DURATIONS = [900, 3600, 28800];

/**
 * "For 15 Minutes" / "For 1 Hour". Spelled out rather than abbreviated because
 * this is a menu of choices, not a status readout.
 * @param {number} seconds
 * @returns {string}
 */
function muteDurationLabel(seconds) {
    if (seconds < 3600) {
        const minutes = Math.round(seconds / 60);
        // Translators: a choice in the "Mute Alerts" submenu. %d is a number
        // of minutes.
        return format(ngettext('For %d Minute', 'For %d Minutes', minutes), minutes);
    }
    const hours = Math.round(seconds / 3600);
    // Translators: a choice in the "Mute Alerts" submenu. %d is a number of hours.
    return format(ngettext('For %d Hour', 'For %d Hours', hours), hours);
}

// Most node rows to build at once. Rows are built synchronously on the
// compositor's main loop at roughly 2.5 ms each, so the cap keeps menu-open
// cost flat whatever the cluster size. The remainder is summarised, not dropped.
const MAX_NODE_ROWS = 50;

// Network-shaped failures often heal on the next poll, so the first one keeps
// the previous data on show with a note. Config errors replace the view at once.
const TRANSIENT_ERRORS = new Set(['timeout', 'unreachable', 'offline']);

/**
 * A rendered node row, kept for in-place updates between polls.
 * @typedef {object} NodeRow
 * @property {PopupMenu.PopupBaseMenuItem} item
 * @property {St.Widget} dot
 * @property {St.Label} nameLabel
 * @property {St.Label} durationLabel
 * @property {St.Label} qualLabel
 * @property {St.Label} cpuLabel
 * @property {St.Label} memLabel
 */

// Middle dot between the parts of a secondary line, as gnome-shell writes it.
const SEP = ' · ';

const LEVEL_CLASSES = ['ok', 'warning', 'error', 'unknown'];

/**
 * Swap an actor's one level-suffixed class, e.g. kube-text-warning.
 * @param {St.Widget} actor
 * @param {string} prefix
 * @param {string | null} level  null drops the class altogether
 */
function setLevelClass(actor, prefix, level) {
    for (const l of LEVEL_CLASSES)
        actor.remove_style_class_name(`${prefix}-${l}`);
    if (level)
        actor.add_style_class_name(`${prefix}-${level}`);
}

export const KubeIndicator = GObject.registerClass({
    Signals: {
        'refresh-requested': {},
        'context-selected': {param_types: [GObject.TYPE_STRING]},
        'menu-open-changed': {param_types: [GObject.TYPE_BOOLEAN]},
        'node-copied': {param_types: [GObject.TYPE_STRING]},
        'snooze-requested': {param_types: [GObject.TYPE_INT]},
    },
}, class KubeIndicator extends PanelMenu.Button {
    // No class fields: in a GObject.registerClass class their initializers run
    // after _init() and would clobber what it set.
    // @ts-expect-error: PanelMenu.Button._init has a wider signature; GObject construction passes the one extension argument.
    _init(/** @type {{path: string, openPreferences: () => void}} */ extension) {
        super._init(0.5, APP_NAME, false);

        this._extension = extension;
        /** @type {number | null} */
        this._lastMonotonic = null;
        // Wall-ms until which alerts are muted (0 = not muted); set by the extension.
        this._snoozeUntil = 0;
        /** @type {Map<string, NodeRow>} */
        this._nodeRows = new Map();
        /** @type {string | null} */
        this._nodesSig = null;

        const overlay = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._icon = new St.Icon({
            gicon: Gio.icon_new_for_string(`${extension.path}/icons/kubernetes-symbolic.svg`),
            icon_size: 22,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._panelDot = new St.Widget({
            style_class: 'kube-dot kube-panel-dot kube-dot-unknown',
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.END,
            x_expand: true,
            y_expand: true,
        });
        overlay.add_child(this._icon);
        overlay.add_child(this._panelDot);
        this.add_child(overlay);

        // get_theme_node() logs a critical outside the stage, and the panel adopts
        // this button only after _init returns: the first read borrows its node.
        this._syncPanelStyle(Main.panel);
        this._styleChangedId = this.connect('style-changed', () => this._syncPanelStyle(this));

        this._buildMenu();

        // The popup is a second surface: a theme can restyle the panel alone.
        this._menuBox = /** @type {PopupMenu.PopupMenu} */ (this.menu).box;
        this._syncMenuStyle();
        this._menuStyleId = this._menuBox.connect('style-changed', () => this._syncMenuStyle());
    }

    /**
     * Colour the logo and pick the panel palette, both from one foreground.
     * @param {St.Widget} surface
     */
    _syncPanelStyle(surface) {
        const fg = surface.get_theme_node().get_foreground_color();
        this._icon.set_style(`color: rgba(${fg.red}, ${fg.green}, ${fg.blue}, ${fg.alpha / 255});`);
        applyVariant(this, styleVariant(fg));
    }

    _syncMenuStyle() {
        const box = this._menuBox;
        applyVariant(box, styleVariant(box.get_theme_node().get_foreground_color()));
    }

    _buildMenu() {
        const menu = /** @type {PopupMenu.PopupMenu} */ (this.menu);

        // Laid out like a Quick Settings menu header: status icon, title and
        // subtitle. Reactive but not activatable, or St greys out the title and
        // the live refresh button with it (see .agents/rules/ui.md).
        const headerItem = new PopupMenu.PopupBaseMenuItem({
            reactive: true, activate: false, hover: false,
            can_focus: false, style_class: 'kube-header',
        });
        headerItem.track_hover = false;

        this._statusIcon = new St.Icon({
            gicon: Gio.icon_new_for_string(`${this._extension.path}/icons/kubernetes-symbolic.svg`),
            style_class: 'kube-status-icon kube-status-unknown',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const text = new St.BoxLayout({...VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._titleLabel = new St.Label({
            // Translators: placeholder in the menu header before the first poll lands.
            text: _('Loading…'), style_class: 'kube-title',
        });
        // Long context names (gke_project_zone_cluster) must not stretch the
        // header; max-width in CSS caps it, the ellipsis trims what is left.
        this._titleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._subtitleLabel = new St.Label({text: '', style_class: 'kube-subtitle'});
        this._subtitleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        text.add_child(this._titleLabel);
        text.add_child(this._subtitleLabel);

        // Age of the reading, beside the button that renews it.
        this._timeLabel = new St.Label({
            text: '', style_class: 'kube-time', y_align: Clutter.ActorAlign.CENTER,
        });
        const refreshBtn = new St.Button({
            style_class: 'kube-icon-button',
            child: new St.Icon({icon_name: 'view-refresh-symbolic', style_class: 'popup-menu-icon'}),
            y_align: Clutter.ActorAlign.CENTER,
            // St.Widget defaults can-focus to FALSE, which left this the one
            // control in the menu a keyboard user could not reach.
            can_focus: true,
            // Translators: spoken name of the icon-only refresh button.
            accessible_name: _('Refresh now'),
        });
        refreshBtn.connect('clicked', () => {
            // Instant feedback: the poll's answer can be up to a watchdog away.
            // Translators: shown beside the refresh button after a manual
            // refresh, until the poll answers.
            this._timeLabel.text = _('updating…');
            this.emit('refresh-requested');
        });

        headerItem.add_child(this._statusIcon);
        headerItem.add_child(text);
        headerItem.add_child(this._timeLabel);
        headerItem.add_child(refreshBtn);
        menu.addMenuItem(headerItem);

        // A single transient failure keeps the last data on show; this strip
        // names the failure above it. See update().
        this._errorStrip = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        this._errorStripLabel = this._wrapLabel('', 'kube-error-strip');
        this._errorStrip.add_child(this._errorStripLabel);
        this._errorStrip.visible = false;
        menu.addMenuItem(this._errorStrip);

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._nodesSection = new PopupMenu.PopupMenuSection();
        menu.addMenuItem(this._nodesSection);

        this._podsItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        this._podsBox = new St.BoxLayout({style_class: 'kube-pods', x_expand: true});
        this._podsItem.add_child(this._podsBox);
        this._podsItem.visible = false;
        menu.addMenuItem(this._podsItem);

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Translators: submenu listing the kubeconfig contexts to switch between.
        // "context" is the kubectl term; use whatever kubectl's own translation uses.
        this._contextMenu = new PopupMenu.PopupSubMenuMenuItem(_('Context'), true);
        this._contextMenu.icon.icon_name = 'network-server-symbolic';
        menu.addMenuItem(this._contextMenu);

        // Muting withholds the banners only: the alert machine keeps tracking,
        // and an alert still firing when the mute expires notifies then.
        // Translators: submenu that mutes alert banners for a while.
        this._muteItem = new PopupMenu.PopupSubMenuMenuItem(_('Mute Alerts'), true);
        this._muteItem.icon.icon_name = 'notifications-disabled-symbolic';
        for (const seconds of MUTE_DURATIONS) {
            const row = new PopupMenu.PopupMenuItem(muteDurationLabel(seconds));
            row.connect('activate', () => this.emit('snooze-requested', seconds));
            this._muteItem.menu.addMenuItem(row);
        }
        // Translators: menu row that cancels an active mute.
        this._unmuteItem = new PopupMenu.PopupMenuItem(_('Turn Muting Off'));
        this._unmuteItem.connect('activate', () => this.emit('snooze-requested', 0));
        this._muteItem.menu.addMenuItem(this._unmuteItem);
        menu.addMenuItem(this._muteItem);
        // Set the initial label here rather than waiting for the first
        // setSnoozeUntil(), so "Turn Muting Off" is not offered before a mute.
        this._syncMuteLabel();

        // Translators: menu row that opens the extension's preferences window.
        const settingsItem = new PopupMenu.PopupImageMenuItem(_('Settings'), 'preferences-system-symbolic');
        settingsItem.connect('activate', () => this._extension.openPreferences());
        menu.addMenuItem(settingsItem);

        menu.connect('open-state-changed', (_menu, open) => {
            if (open) {
                this._updateTime();
                this._syncMuteLabel();
            }
            this.emit('menu-open-changed', open);
        });
    }

    /** @param {number} untilMs  wall-ms until which alerts are muted (0 = not muted) */
    setSnoozeUntil(untilMs) {
        this._snoozeUntil = untilMs || 0;
        this._syncMuteLabel();
    }

    // Title carries the remaining time; the "off" row only appears while muted.
    // Every caller runs after _buildMenu, so no existence guard is needed.
    _syncMuteLabel() {
        const leftMs = this._snoozeUntil - Date.now();
        if (leftMs > 0) {
            // Round up to whole minutes (whole hours past an hour) so the
            // countdown reads "1m left" rather than "3s left" as it runs out.
            const mins = Math.ceil(leftMs / 60000);
            const left = formatDuration(mins >= 60 ? Math.round(mins / 60) * 3600 : mins * 60);
            // Translators: the "Mute Alerts" row while muting is active. %s is a
            // short duration such as "45m" or "2h".
            this._muteItem.label.text = format(_('Muted · %s Left'), left);
            this._unmuteItem.visible = true;
        } else {
            this._muteItem.label.text = _('Mute Alerts');
            this._unmuteItem.visible = false;
        }
    }

    /**
     * @param {string[]} contexts
     * @param {string} current
     */
    setContexts(contexts, current) {
        const section = this._contextMenu.menu;
        section.removeAll();
        if (contexts.length === 0) {
            // Translators: shown in the context submenu when the kubeconfig
            // defines no contexts.
            section.addMenuItem(new PopupMenu.PopupMenuItem(_('No contexts'), {reactive: false}));
        }
        // NONE reserves the ornament column, so every label lines up with the
        // checked one; the shell's default hides it.
        for (const ctx of contexts) {
            const row = new PopupMenu.PopupMenuItem(ctx);
            // The check ornament also sets the CHECKED accessible state.
            row.setOrnament(ctx === current ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
            row.connect('activate', () => {
                this._showSwitching(ctx);
                this.emit('context-selected', ctx);
            });
            section.addMenuItem(row);
        }
        // Translators: last row of the context submenu; opens preferences so
        // another kubeconfig can be added.
        const add = new PopupMenu.PopupMenuItem(_('Add Connection…'));
        add.setOrnament(PopupMenu.Ornament.NONE);
        add.connect('activate', () => this._extension.openPreferences());
        section.addMenuItem(add);
    }

    // Flip the title and show a loading state before the new context's poll
    // arrives, which can be slow.
    /** @param {string} ctx */
    _showSwitching(ctx) {
        this._titleLabel.text = ctx;
        this._subtitleLabel.text = _('Loading…');
        this._setLevel(NodeLevel.UNKNOWN);
        this._lastMonotonic = null;
        this._errorStrip.visible = false;
        this._updateTime();
        this._renderPods(null);
        this._nodesSection.removeAll();
        this._nodeRows.clear();
        this._nodesSig = null;
    }

    /** @param {import('./poller.js').PollState} state */
    update(state) {
        if (state.context)
            this._titleLabel.text = state.context;

        if (state.error) {
            this._setLevel(NodeLevel.ERROR);
            this._subtitleLabel.text = state.error.title;
            this._setAccessibleSummary(state.error.title);
            // First network-shaped failure: the data on show is likelier to be
            // useful than a full error view, so it stays, under a note. The
            // header keeps the shown data's age, not this failure's.
            if (TRANSIENT_ERRORS.has(state.error.key) && (state.failures ?? 0) < 2) {
                this._errorStripLabel.text = state.error.title;
                this._errorStrip.visible = true;
                this._updateTime();
                return;
            }
            this._lastMonotonic = state.monotonic ?? null;
            this._errorStrip.visible = false;
            this._renderPods(null);
            this._nodesSection.removeAll();
            this._nodeRows.clear();
            this._nodesSig = null;
            this._nodesSection.addMenuItem(this._makeErrorItem(state.error));
            this._updateTime();
            return;
        }

        this._lastMonotonic = state.monotonic ?? null;
        this._errorStrip.visible = false;
        this._setLevel(state.level);
        this._subtitleLabel.text = state.total > 0
            // Translators: subtitle of the menu header. %1$d is how many nodes
            // are Ready, %2$d how many there are. The plural follows %2$d.
            ? format(ngettext('%1$d of %2$d node ready', '%1$d of %2$d nodes ready', state.total),
                state.readyCount, state.total)
            : _('No nodes');
        // Translators: spoken summary of the whole cluster. %1$s is a state word
        // ("healthy", "degraded", …), %2$d is how many nodes are Ready and %3$d
        // how many there are. The plural form follows the total, %3$d.
        const summary = ngettext('%1$s, %2$d of %3$d node ready',
            '%1$s, %2$d of %3$d nodes ready', state.total);
        this._setAccessibleSummary(format(summary,
            _(LEVEL_WORD[state.level ?? NodeLevel.UNKNOWN]), state.readyCount, state.total));

        if (state.tier === 'detail') {
            this._renderPods(state.pods ?? null);
            this._renderNodes(/** @type {import('./model.js').DetailNode[]} */ (state.nodes));
        }

        this._updateTime();
    }

    // A headline plus kubectl's own de-noised words. Both labels wrap at
    // WORD_CHAR so a long error (or an unbreakable URL) reflows inside the menu
    // instead of stretching it; max-width in the stylesheet caps the reflow.
    /**
     * @param {import('./model.js').ClassifiedError} err
     * @returns {PopupMenu.PopupBaseMenuItem}
     */
    _makeErrorItem(err) {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const box = new St.BoxLayout({...VERTICAL, x_expand: true, style_class: 'kube-error'});
        box.add_child(this._wrapLabel(err.title, 'kube-error-title'));
        if (err.detail)
            box.add_child(this._wrapLabel(err.detail, 'kube-error-detail'));
        item.add_child(box);
        return item;
    }

    /**
     * @param {string} text
     * @param {string} styleClass
     * @returns {St.Label}
     */
    _wrapLabel(text, styleClass) {
        const label = new St.Label({text, style_class: styleClass, x_expand: true});
        label.clutter_text.line_wrap = true;
        label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        return label;
    }

    /** @param {import('./model.js').DetailNode[]} nodes */
    _renderNodes(nodes) {
        const all = [...nodes].sort(compareNodes);
        // compareNodes puts the most severe first, so those survive the cap.
        // Rows are keyed by name, so a duplicate would leave _nodeRows smaller
        // than the list and make the reuse check below permanently false.
        const seen = new Set();
        const unique = all.filter(n => !seen.has(n.name) && seen.add(n.name));
        const sorted = unique.slice(0, MAX_NODE_ROWS);
        const hidden = unique.length - sorted.length;
        const sig = `${sorted.map(n => `${n.name}:${n.level}`).join('|')}#${hidden}`;

        if (sig === this._nodesSig && this._nodeRows.size === sorted.length) {
            for (const node of sorted) {
                const row = this._nodeRows.get(node.name);
                if (row)
                    this._updateRow(row, node);
            }
            return;
        }

        this._nodesSig = sig;
        this._nodesSection.removeAll();
        this._nodeRows.clear();

        // An empty cluster is already said by the header subtitle.
        for (const node of sorted) {
            const row = this._makeNodeItem(node);
            this._nodeRows.set(node.name, row);
            this._nodesSection.addMenuItem(row.item);
        }
        // Never silently truncate: say what was left out.
        if (hidden > 0) {
            const more = new PopupMenu.PopupMenuItem(
                // Translators: closes a truncated node list. %d is how many
                // further nodes exist that the menu did not draw.
                format(ngettext('… and %d more node', '… and %d more nodes', hidden), hidden),
                {reactive: false});
            more.label.add_style_class_name('kube-dim');
            this._nodesSection.addMenuItem(more);
        }
    }

    /**
     * @param {import('./model.js').DetailNode} node
     * @returns {NodeRow}
     */
    _makeNodeItem(node) {
        const item = new PopupMenu.PopupBaseMenuItem({style_class: 'kube-node-item'});
        const box = new St.BoxLayout({...VERTICAL, x_expand: true, style_class: 'kube-node-box'});

        // Primary line: status dot, name, and how long it has been up or down.
        const top = new St.BoxLayout({x_expand: true, style_class: 'kube-node-top'});
        const dot = new St.Widget({style_class: 'kube-dot', y_align: Clutter.ActorAlign.CENTER});
        const nameLabel = new St.Label({
            text: node.name, x_expand: true,
            y_align: Clutter.ActorAlign.CENTER, style_class: 'kube-node-name',
        });
        nameLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        const durationLabel = new St.Label({
            y_align: Clutter.ActorAlign.CENTER, style_class: 'kube-node-duration',
        });
        top.add_child(dot);
        top.add_child(nameLabel);
        top.add_child(durationLabel);
        box.add_child(top);

        // Secondary line, under the name: role or reason, then live load.
        const sub = new St.BoxLayout({x_expand: true, style_class: 'kube-node-sub'});
        const qualLabel = new St.Label({style_class: 'kube-node-qual'});
        const cpuLabel = new St.Label({style_class: 'kube-node-load'});
        const memLabel = new St.Label({style_class: 'kube-node-load'});
        sub.add_child(qualLabel);
        sub.add_child(cpuLabel);
        sub.add_child(memLabel);
        box.add_child(sub);

        item.add_child(box);

        const row = {item, dot, nameLabel, durationLabel, qualLabel, cpuLabel, memLabel};
        this._updateRow(row, node);

        item.connect('activate', () => {
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD,
                `kubectl describe node ${node.name}`);
            this.emit('node-copied', node.name);
        });
        return row;
    }

    /**
     * @param {NodeRow} row
     * @param {import('./model.js').DetailNode} node
     */
    _updateRow(row, node) {
        setLevelClass(row.dot, 'kube-dot', node.level);
        const qualifier = nodeQualifier(node);
        const up = node.ready
            // Translators: uptime on a node row: how long it has been Ready.
            // %s is a short duration such as "3d".
            ? format(_('up %s'), node.since)
            // Translators: downtime on a node row: how long it has been
            // NotReady. %s is a short duration such as "3d".
            : format(_('down %s'), node.since);
        row.durationLabel.text = up;
        setLevelClass(row.durationLabel, 'kube-text', node.ready ? null : NodeLevel.ERROR);

        // Healthy rows show their role in the dim secondary colour; anything
        // else is the reason, coloured, so the problem reads without the dot.
        row.qualLabel.text = qualifier;
        setLevelClass(row.qualLabel, 'kube-text', node.level === NodeLevel.OK ? null : node.level);
        this._setLoad(row.cpuLabel, 'CPU', node.cpuPct, qualifier !== '');
        this._setLoad(row.memLabel, 'MEM', node.memPct, qualifier !== '' || node.cpuPct != null);

        // One spoken sentence per row: the coloured dot carries state that
        // does not read out on its own.
        const parts = [node.name, qualifier || (node.ready ? 'Ready' : 'NotReady'), up];
        if (node.cpuPct != null) {
            // Translators: spoken CPU load on a node row. %d is a percentage.
            parts.push(format(_('CPU %d%%'), node.cpuPct));
        }
        if (node.memPct != null) {
            // Translators: spoken memory load on a node row. %d is a percentage.
            parts.push(format(_('memory %d%%'), node.memPct));
        }
        row.item.accessible_name = parts.join(', ');
    }

    // CPU/MEM mirror kubectl top's columns, so they stay in Latin.
    /**
     * @param {St.Label} label
     * @param {string} name
     * @param {number | null} pct
     * @param {boolean} separated  whether something precedes it on the line
     */
    _setLoad(label, name, pct, separated) {
        label.visible = pct != null;
        if (pct == null)
            return;
        label.text = `${separated ? SEP : ''}${name} ${pct}%`;
        const level = meterLevel(pct);
        setLevelClass(label, 'kube-text', level === NodeLevel.OK ? null : level);
    }

    /** @param {import('./model.js').PodsSummary | null} pods */
    _renderPods(pods) {
        this._podsBox.destroy_all_children();
        this._podsItem.visible = pods != null;
        if (!pods)
            return;

        const add = (/** @type {string} */ text, /** @type {string | null} */ level) => {
            const label = new St.Label({
                text: this._podsBox.get_n_children() ? `${SEP}${text}` : text,
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'kube-pods-label',
            });
            setLevelClass(label, 'kube-text', level);
            // Up to four of these share one row in a menu whose width is fixed
            // by the header. Ellipsizing (with .kube-pods' max-width) keeps a
            // long translation from stretching the popup; the count comes first.
            label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            this._podsBox.add_child(label);
        };
        // Translators: pod count under the node list. Keep it short: up to four
        // of these pod counts share one row.
        add(format(ngettext('%d pod running', '%d pods running', pods.running), pods.running), null);
        if (pods.pending > 0) {
            // Translators: pods accepted but not yet started. Keep it very short.
            add(format(ngettext('%d pending', '%d pending', pods.pending), pods.pending),
                NodeLevel.WARNING);
        }
        if (pods.crashloop > 0) {
            // Translators: pods stuck restarting (CrashLoopBackOff). Keep it very short.
            add(format(ngettext('%d crashing', '%d crashing', pods.crashloop), pods.crashloop),
                NodeLevel.ERROR);
        }
        if (pods.failed > 0) {
            // Translators: pods that terminated in failure. Keep it very short.
            add(format(ngettext('%d failed', '%d failed', pods.failed), pods.failed),
                NodeLevel.ERROR);
        }
    }

    // Keeps the panel button's spoken name in step with the dot.
    /** @param {string} summary */
    _setAccessibleSummary(summary) {
        // Translators: spoken name of the panel button. "Kube Node Monitor" is
        // the extension's name, so leave it as it is. %s is the cluster summary.
        this.accessible_name = format(_('Kube Node Monitor: %s'), summary);
    }

    // The panel dot and the header's status icon say the same thing.
    /** @param {import('./model.js').NodeLevelValue} [level] */
    _setLevel(level) {
        setLevelClass(this._panelDot, 'kube-dot', level ?? NodeLevel.UNKNOWN);
        setLevelClass(this._statusIcon, 'kube-status', level ?? NodeLevel.UNKNOWN);
    }

    _updateTime() {
        if (this._lastMonotonic == null) {
            // Translators: shown beside the refresh button while the first poll of
            // a cluster is still in flight.
            this._timeLabel.text = _('updating…');
            return;
        }
        const seconds = Math.max(0,
            Math.round((GLib.get_monotonic_time() - this._lastMonotonic) / GLib.TIME_SPAN_SECOND));

        // Translators: shown beside the refresh button when the reading is only
        // a few seconds old, in place of a duration.
        this._timeLabel.text = seconds < 5 ? _('now') : formatDuration(seconds);
    }

    destroy() {
        // Unparenting restyles an actor, so a handler left connected would read
        // a theme node that is no longer in the stage.
        if (this._styleChangedId) {
            this.disconnect(this._styleChangedId);
            this._styleChangedId = 0;
        }
        if (this._menuStyleId) {
            this._menuBox.disconnect(this._menuStyleId);
            this._menuStyleId = 0;
        }
        this._nodeRows.clear();
        super.destroy();
    }
});
