import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { QuickMenuToggle, SystemIndicator } from 'resource:///org/gnome/shell/ui/quickSettings.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

const CONFIG_DIR = GLib.build_filenamev([GLib.get_user_config_dir(), 'fluxcast-gnome-extension']);
const CONFIG_PATH = GLib.build_filenamev([CONFIG_DIR, 'config.json']);
// NetworkManager drops a Wi-Fi Direct peer about 57s after the last scan saw
// it. Within this window FluxCast can find the TV with a 1s scan of its own.
const PEER_FRESH_USEC = 45 * GLib.USEC_PER_SEC;

function loadConfig() {
    try {
        const [ok, contents] = GLib.file_get_contents(CONFIG_PATH);
        if (!ok)
            return {};
        return JSON.parse(new TextDecoder().decode(contents));
    } catch {
        return {};
    }
}

function saveConfig(config) {
    try {
        GLib.mkdir_with_parents(CONFIG_DIR, 0o755);
        GLib.file_set_contents(CONFIG_PATH, JSON.stringify(config, null, 2));
    } catch {
    }
}

function venvPython(appDir) {
    const candidate = GLib.build_filenamev([appDir, 'venv', 'bin', 'python3']);
    if (GLib.file_test(candidate, GLib.FileTest.IS_EXECUTABLE))
        return candidate;
    return 'python3';
}

function resolveLaunch(config) {
    if (config.fluxcast_path) {
        const dir = GLib.path_get_dirname(config.fluxcast_path);
        if (config.fluxcast_path.endsWith('.py') && GLib.file_test(config.fluxcast_path, GLib.FileTest.IS_REGULAR))
            return { command: venvPython(dir), baseArgs: [config.fluxcast_path], appDir: dir };
        const found = GLib.find_program_in_path(config.fluxcast_path);
        if (found)
            return { command: found, baseArgs: [], appDir: config.app_dir || null };
    }

    const fluxcast = GLib.find_program_in_path('fluxcast');
    if (fluxcast)
        return { command: fluxcast, baseArgs: [], appDir: config.app_dir || null };

    const candidates = [
        config.app_dir,
        '/opt/fluxcast',
        GLib.build_filenamev([GLib.get_home_dir(), '.local', 'opt', 'fluxcast']),
    ];
    for (const dir of candidates) {
        if (!dir)
            continue;
        const mainPath = GLib.build_filenamev([dir, 'main.py']);
        if (GLib.file_test(mainPath, GLib.FileTest.IS_REGULAR))
            return { command: venvPython(dir), baseArgs: [mainPath], appDir: dir };
    }

    return null;
}

function callDisplayConfig(method, params) {
    return new Promise((resolve, reject) => {
        Gio.DBus.session.call(
            'org.gnome.Mutter.DisplayConfig', '/org/gnome/Mutter/DisplayConfig',
            'org.gnome.Mutter.DisplayConfig', method, params,
            null, Gio.DBusCallFlags.NONE, -1, null,
            (connection, res) => {
                try {
                    resolve(connection.call_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
    });
}

async function getDisplayState() {
    const reply = await callDisplayConfig('GetCurrentState', null);
    const [serial, monitors, logicalMonitors] = reply.recursiveUnpack();
    return { serial, monitors, logicalMonitors };
}

// The current logical monitor layout, in the shape ApplyMonitorsConfig takes.
function currentLayout(state) {
    return state.logicalMonitors.map(([x, y, scale, transform, primary, specs]) => [
        x, y, scale, transform, primary,
        specs.map(([connector]) => {
            const monitor = state.monitors.find(entry => entry[0][0] === connector);
            const mode = monitor?.[1].find(entry => entry[6]['is-current']);
            if (!mode)
                throw new Error(`no current mode for ${connector}`);
            return [connector, mode[0], {}];
        }),
    ]);
}

// Wi-Fi Display streams are always 16:9 (CEA 1080p/720p), so matching the TV
// means putting the primary monitor on its largest 16:9 mode. Returns null
// when it already is 16:9 or has no such mode.
function tvLayout(state) {
    const layout = currentLayout(state);
    const logical = layout.find(entry => entry[4]);
    if (!logical)
        return null;

    const [connector, currentId] = logical[5][0];
    const modes = state.monitors.find(entry => entry[0][0] === connector)[1];
    const current = modes.find(mode => mode[0] === currentId);
    const is16x9 = mode => Math.abs(mode[1] / mode[2] - 16 / 9) < 0.01;
    if (is16x9(current))
        return null;

    const vrr = currentId.includes('+vrr');
    const target = modes
        .filter(mode => is16x9(mode) && mode[0].includes('+vrr') === vrr &&
            mode[1] <= current[1] && mode[2] <= current[2])
        .sort((a, b) => b[1] - a[1] || Math.abs(a[3] - current[3]) - Math.abs(b[3] - current[3]))[0];
    if (!target)
        return null;

    logical[2] = target[5].find(value => Math.abs(value - logical[2]) < 0.001) ?? target[4];
    logical[5][0] = [connector, target[0], {}];
    return layout;
}

function applyLayout(serial, layout) {
    // Method 1 is temporary: not saved to monitors.xml and no confirm dialog.
    return callDisplayConfig('ApplyMonitorsConfig',
        new GLib.Variant('(uua(iiduba(ssa{sv}))a{sv})', [serial, 1, layout, {}]));
}

function isWayland() {
    return GLib.getenv('XDG_SESSION_TYPE') === 'wayland' || GLib.getenv('WAYLAND_DISPLAY') !== null;
}

function isHyprland() {
    const desktop = (GLib.getenv('XDG_CURRENT_DESKTOP') || '').toLowerCase();
    return desktop.includes('hyprland') || GLib.getenv('HYPRLAND_INSTANCE_SIGNATURE') !== null;
}

const FluxCastIndicator = GObject.registerClass(
class FluxCastIndicator extends SystemIndicator {
    _init(extension) {
        super._init();

        this._extension = extension;
        this._state = 'idle';
        this._startToken = 0;
        this._devices = [];
        this._autoConnect = false;
        this._lastScanAt = 0;
        this._scanProcs = [];
        this._scanKillIds = [];
        this._monitorProc = null;
        this._monitorKillId = 0;
        this._castProcess = null;
        this._castName = '';
        this._stopTimer = 0;
        this._savedLayout = null;
        this._displayQueue = Promise.resolve();

        const gicon = Gio.icon_new_for_string(
            GLib.build_filenamev([this._extension.path, 'icons', 'fluxcast-symbolic.svg']));

        this._icon = this._addIndicator();
        this._icon.gicon = gicon;

        this._toggle = new QuickMenuToggle({
            title: 'FluxCast',
            gicon,
        });
        this._toggle.connect('clicked', () => this._onToggleClicked());

        this._statusItem = new PopupMenu.PopupMenuItem('Idle', { reactive: false });
        this._toggle.menu.addMenuItem(this._statusItem);
        this._toggle.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._deviceSection = new PopupMenu.PopupMenuSection();
        this._toggle.menu.addMenuItem(this._deviceSection);
        this._toggle.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._addConfigSwitch('Auto-connect to remembered TVs', 'auto_connect');
        this._addConfigSwitch('Match TV resolution', 'match_resolution');

        this._scanItem = new PopupMenu.PopupMenuItem('Scan for devices');
        // Replaces activate() so the 'activate' signal, which makes the menu
        // close, never fires: the menu stays open to show the results.
        this._scanItem.activate = () => this._scan();
        this._toggle.menu.addMenuItem(this._scanItem);

        this._stopItem = new PopupMenu.PopupMenuItem('Stop casting');
        this._stopItem.connect('activate', () => this._stop());
        this._toggle.menu.addMenuItem(this._stopItem);

        this.quickSettingsItems.push(this._toggle);
        this._syncMenu();
    }

    _addConfigSwitch(label, key) {
        const item = new PopupMenu.PopupSwitchMenuItem(label, loadConfig()[key] === true);
        // Replaces activate() so flipping the switch doesn't close the menu.
        item.activate = () => item.toggle();
        item.connect('toggled', (_item, state) => {
            const config = loadConfig();
            config[key] = state;
            saveConfig(config);
        });
        this._toggle.menu.addMenuItem(item);
    }

    _syncMenu() {
        const active = this._state === 'starting' || this._state === 'casting';
        let status = 'Idle';
        if (this._state === 'scanning')
            status = 'Scanning…';
        else if (this._state === 'starting')
            status = 'Starting…';
        else if (this._state === 'casting')
            status = `Casting to ${this._castName}`;

        this._statusItem.label.text = status;
        this._scanItem.label.text = this._state === 'scanning' ? 'Scanning…' : 'Scan for devices';
        this._stopItem.sensitive = active;
        this._toggle.checked = active;
        this._icon.visible = active;

        this._rebuildDeviceItems();
    }

    _rankedDevices() {
        // Peers that advertise Wi-Fi Display sink support first; peers that
        // explicitly are not sinks (printers, other sources) are dropped.
        return this._devices
            .filter(device => device.capable !== false)
            .sort((a, b) => (b.capable === true) - (a.capable === true));
    }

    _rebuildDeviceItems() {
        this._deviceSection.removeAll();

        const devices = this._rankedDevices();
        if (devices.length === 0) {
            this._deviceSection.addMenuItem(new PopupMenu.PopupMenuItem('No devices found', { reactive: false }));
            return;
        }

        const busy = this._state === 'starting' || this._state === 'casting';
        for (const device of devices) {
            const item = new PopupMenu.PopupMenuItem(device.name || device.address);
            item.sensitive = !busy;
            item.connect('activate', () => {
                this._toggle.menu.close();
                this._beginCast(device);
            });
            this._deviceSection.addMenuItem(item);
        }
    }

    _setState(state) {
        this._state = state;
        this._syncMenu();
    }

    _setSubtitle(text) {
        this._toggle.subtitle = text;
    }

    _onToggleClicked() {
        if (this._state === 'scanning')
            return;
        if (this._state === 'casting' || this._state === 'starting') {
            this._stop();
            return;
        }

        this._scan(loadConfig().auto_connect === true);
    }

    _killScans() {
        for (const id of this._scanKillIds)
            GLib.source_remove(id);
        this._scanKillIds = [];

        for (const proc of this._scanProcs)
            proc.force_exit();
        this._scanProcs = [];

        this._autoConnect = false;
    }

    _scan(autoConnect = false) {
        if (this._state !== 'idle')
            return;

        const config = loadConfig();
        const launch = resolveLaunch(config);
        if (!launch) {
            this._setSubtitle('FluxCast not found');
            return;
        }

        if (launch.appDir && config.app_dir !== launch.appDir) {
            config.app_dir = launch.appDir;
            saveConfig(config);
        }

        this._autoConnect = autoConnect;
        this._setState('scanning');
        this._setSubtitle('Scanning…');

        // With auto-connect, the scan stops as soon as a remembered TV shows up.
        const targets = autoConnect
            ? (config.known_devices ?? []).flatMap(known => [known.address, known.name])
            : [];
        const spawned = launch.appDir
            ? this._spawnScan(launch.appDir, 8, targets)
            : this._spawnFallbackScan(launch);
        if (!spawned)
            this._finishScans();
    }

    _spawnScan(appDir, timeout, targets) {
        const helper = GLib.build_filenamev([this._extension.path, 'scan-helper.py']);
        const argv = [venvPython(appDir), helper, appDir, 'wfd', String(timeout), ...targets];
        let proc;
        try {
            proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE);
        } catch {
            return false;
        }
        this._trackScan(proc, timeout + 4, stdout => this._parseScanOutput(stdout));
        return true;
    }

    _spawnFallbackScan(launch) {
        const argv = [launch.command, ...launch.baseArgs, '--wfd-scan'];
        let proc;
        try {
            proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE);
        } catch {
            return false;
        }
        this._trackScan(proc, 12, stdout => ({ devices: this._parseWfdScan(stdout) }));
        return true;
    }

    _trackScan(proc, killAfter, parse) {
        this._scanProcs.push(proc);

        const killId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, killAfter, () => {
            const index = this._scanKillIds.indexOf(killId);
            if (index >= 0)
                this._scanKillIds.splice(index, 1);
            proc.force_exit();
            return GLib.SOURCE_REMOVE;
        });
        this._scanKillIds.push(killId);

        const token = this._startToken;
        proc.communicate_utf8_async(null, null, (p, res) => {
            const index = this._scanKillIds.indexOf(killId);
            if (index >= 0) {
                GLib.source_remove(killId);
                this._scanKillIds.splice(index, 1);
            }

            const procIndex = this._scanProcs.indexOf(p);
            if (procIndex >= 0)
                this._scanProcs.splice(procIndex, 1);

            let stdout = null;
            try {
                [, stdout] = p.communicate_utf8_finish(res);
            } catch {
            }

            if (token !== this._startToken)
                return;

            this._onScanDone(parse(stdout));
        });
    }

    _parseScanOutput(stdout) {
        if (!stdout)
            return null;
        const lines = stdout.trim().split('\n');
        for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i].trim();
            if (!line.startsWith('{'))
                continue;
            try {
                return JSON.parse(line);
            } catch {
                return null;
            }
        }
        return null;
    }

    _parseWfdScan(stdout) {
        const devices = [];
        if (!stdout)
            return devices;

        for (const rawLine of stdout.split('\n')) {
            const match = rawLine.trim().match(/^\[(\d+)\]\s+(\S+)\s*(.*)$/);
            if (!match)
                continue;

            const address = match[2];
            const rest = match[3];
            let name = rest.trim();
            let detail = '';
            const viaIndex = rest.lastIndexOf(' via ');
            if (viaIndex >= 0) {
                name = rest.slice(0, viaIndex).trim();
                detail = rest.slice(viaIndex + 5).trim();
            }

            devices.push({ name: name || address, address, detail, capable: null });
        }

        return devices;
    }

    _onScanDone(parsed) {
        this._devices = parsed && Array.isArray(parsed.devices) ? parsed.devices : [];
        this._lastScanAt = GLib.get_monotonic_time();
        this._syncMenu();
        this._finishScans();
    }

    _finishScans() {
        if (this._autoConnect) {
            const known = this._knownDevice();
            if (known) {
                this._beginCast(known);
                return;
            }
        }

        this._setState('idle');
        const total = this._rankedDevices().length;
        if (total === 0) {
            this._setSubtitle('No devices found');
            return;
        }

        this._setSubtitle(`${total} device${total === 1 ? '' : 's'} found`);
        // Expand to the device list, unless Quick Settings was closed meanwhile.
        if (Main.panel.statusArea.quickSettings.menu.isOpen)
            this._toggle.menu.open();
    }

    // The found device whose TV was cast to most recently, if any. Matches on
    // name too, in case the TV's Wi-Fi Direct address changed.
    _knownDevice() {
        const devices = this._rankedDevices();
        for (const known of loadConfig().known_devices ?? []) {
            const device = devices.find(entry =>
                entry.address === known.address || entry.name === known.name);
            if (device)
                return device;
        }
        return null;
    }

    _beginCast(device) {
        if (this._state === 'starting' || this._state === 'casting')
            return;

        const token = ++this._startToken;
        this._killScans();

        const config = loadConfig();
        const launch = resolveLaunch(config);
        if (!launch) {
            this._setState('idle');
            this._setSubtitle('FluxCast not found');
            return;
        }

        if (launch.appDir)
            config.app_dir = launch.appDir;
        // Most recent first; replaces any older entry for the same TV.
        config.known_devices = [
            { name: device.name, address: device.address },
            ...(config.known_devices ?? []).filter(known =>
                known.address !== device.address && known.name !== device.name),
        ];
        saveConfig(config);

        this._castName = device.name;
        this._setState('starting');
        this._setSubtitle(null);

        // GNOME/KDE Wayland capture goes through the screen-share portal,
        // which picks the monitor itself.
        if (isWayland() && !isHyprland()) {
            this._spawnCast(launch, device, null);
            return;
        }

        if (config.monitor) {
            this._spawnCast(launch, device, config.monitor);
            return;
        }

        this._resolveMonitor(launch, token, device);
    }

    _resolveMonitor(launch, token, device) {
        const fail = () => this._spawnCast(launch, device, null);

        if (!launch.appDir) {
            fail();
            return;
        }

        const helper = GLib.build_filenamev([this._extension.path, 'scan-helper.py']);
        const argv = [venvPython(launch.appDir), helper, launch.appDir, 'monitors', '5'];
        let proc;
        try {
            proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE);
        } catch {
            fail();
            return;
        }

        this._monitorProc = proc;
        this._monitorKillId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 9, () => {
            this._monitorKillId = 0;
            proc.force_exit();
            return GLib.SOURCE_REMOVE;
        });

        proc.communicate_utf8_async(null, null, (p, res) => {
            this._monitorProc = null;
            if (this._monitorKillId) {
                GLib.source_remove(this._monitorKillId);
                this._monitorKillId = 0;
            }

            let stdout = null;
            try {
                [, stdout] = p.communicate_utf8_finish(res);
            } catch {
            }

            if (token !== this._startToken || this._state !== 'starting')
                return;

            const parsed = this._parseScanOutput(stdout);
            const devices = parsed && Array.isArray(parsed.devices) ? parsed.devices : [];
            const monitor = devices.find(entry => entry.capable === true) || devices[0];
            if (!monitor) {
                fail();
                return;
            }

            const config = loadConfig();
            config.monitor = monitor.address;
            saveConfig(config);
            this._spawnCast(launch, device, monitor.address);
        });
    }

    // Display changes run one at a time, so a restore queued by a stop always
    // lands after the switch it undoes.
    _queueDisplay(op) {
        this._displayQueue = this._displayQueue.then(op).catch(e =>
            console.warn(`FluxCast: display change failed: ${e.message}`));
        return this._displayQueue;
    }

    _matchTvResolution() {
        return this._queueDisplay(async () => {
            if (this._savedLayout)
                return;
            const state = await getDisplayState();
            const target = tvLayout(state);
            if (!target)
                return;
            const original = currentLayout(state);
            await applyLayout(state.serial, target);
            this._savedLayout = original;
        });
    }

    _restoreResolution() {
        return this._queueDisplay(async () => {
            if (!this._savedLayout)
                return;
            const layout = this._savedLayout;
            this._savedLayout = null;
            const state = await getDisplayState();
            await applyLayout(state.serial, layout);
        });
    }

    _spawnCast(launch, device, monitor) {
        if (!loadConfig().match_resolution) {
            this._runCast(launch, device, monitor);
            return;
        }

        // The portal only starts capturing once the TV has connected, so the
        // switch can run alongside FluxCast's startup. Other capture backends
        // read the monitor size at launch and have to wait for it.
        if (isWayland() && !isHyprland()) {
            this._matchTvResolution();
            this._runCast(launch, device, monitor);
            return;
        }

        const token = this._startToken;
        this._matchTvResolution().then(() => {
            if (token === this._startToken && this._state === 'starting')
                this._runCast(launch, device, monitor);
        });
    }

    _runCast(launch, device, monitor) {
        const argv = [launch.command, ...launch.baseArgs, '--protocol', 'wfd', '--wfd-peer', device.address];
        if (GLib.get_monotonic_time() - this._lastScanAt < PEER_FRESH_USEC)
            argv.push('--wfd-timeout', '1');
        if (monitor)
            argv.push('--monitor', monitor);

        // Unbuffered, so each step reaches the journal when it happens.
        const launcher = new Gio.SubprocessLauncher({ flags: Gio.SubprocessFlags.NONE });
        launcher.setenv('PYTHONUNBUFFERED', '1', true);
        let proc;
        try {
            proc = launcher.spawnv(argv);
        } catch {
            this._restoreResolution();
            this._setState('idle');
            this._setSubtitle('Failed to start');
            return;
        }

        this._castProcess = proc;
        this._setState('casting');
        this._setSubtitle(null);

        const startedAt = GLib.get_monotonic_time();
        const token = this._startToken;
        proc.wait_async(null, (p, res) => {
            try {
                p.wait_finish(res);
            } catch {
            }

            if (this._castProcess === p)
                this._castProcess = null;

            if (this._stopTimer) {
                GLib.source_remove(this._stopTimer);
                this._stopTimer = 0;
            }

            if (token !== this._startToken)
                return;

            this._restoreResolution();
            const elapsed = GLib.get_monotonic_time() - startedAt;
            this._setState('idle');

            if (elapsed < 3000000) {
                const config = loadConfig();
                if (config.monitor) {
                    delete config.monitor;
                    saveConfig(config);
                }
                this._setSubtitle('Cast failed');
                return;
            }

            this._setSubtitle('Cast screen to TV');
        });
    }

    _stop() {
        this._startToken++;
        this._killScans();

        if (this._monitorProc) {
            if (this._monitorKillId) {
                GLib.source_remove(this._monitorKillId);
                this._monitorKillId = 0;
            }
            this._monitorProc.force_exit();
            this._monitorProc = null;
        }

        if (this._castProcess) {
            const proc = this._castProcess;
            this._castProcess = null;
            try {
                proc.send_signal(15);
            } catch {
                proc.force_exit();
            }
            this._stopTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => {
                this._stopTimer = 0;
                proc.force_exit();
                return GLib.SOURCE_REMOVE;
            });
        }

        this._restoreResolution();
        this._setState('idle');
        this._setSubtitle(null);
    }

    destroy() {
        this._startToken++;
        this._killScans();

        if (this._monitorKillId) {
            GLib.source_remove(this._monitorKillId);
            this._monitorKillId = 0;
        }
        if (this._monitorProc) {
            this._monitorProc.force_exit();
            this._monitorProc = null;
        }
        if (this._castProcess) {
            this._castProcess.force_exit();
            this._castProcess = null;
        }
        if (this._stopTimer) {
            GLib.source_remove(this._stopTimer);
            this._stopTimer = 0;
        }
        this._restoreResolution();

        this._toggle.destroy();
        super.destroy();
    }
});

export default class FluxCastExtension extends Extension {
    enable() {
        this._indicator = new FluxCastIndicator(this);
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator, 1);
    }

    disable() {
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }
}
