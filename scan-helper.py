#!/usr/bin/env python3
import contextlib
import io
import json
import os
import sys
import time

EMITTED = False


def emit(payload):
    global EMITTED
    EMITTED = True
    print(json.dumps(payload), flush=True)


class StopWhenListed:
    """Stands in for the time module inside FluxCast's NetworkManager scan.

    That scan's only wait is one sleep for the whole scan before it reads the
    peer list; this sleep returns as soon as a target peer is listed.
    """

    PEER_IFACE = "org.freedesktop.NetworkManager.WifiP2PPeer"

    def __init__(self, nm, targets):
        self._nm = nm
        self._targets = targets

    def _target_listed(self):
        from wfd.p2p.dbus import _object_paths
        path = self._nm._nm_p2p_device_path(None)
        peers = self._nm._nm_get_property(
            path, "org.freedesktop.NetworkManager.Device.WifiP2P", "Peers")
        for peer in _object_paths(peers):
            for prop in ("HwAddress", "Name"):
                if self._nm._nm_get_string(peer, self.PEER_IFACE, prop).lower() in self._targets:
                    return True
        return False

    def sleep(self, seconds):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline and not self._target_listed():
            time.sleep(0.5)

    def __getattr__(self, name):
        return getattr(time, name)


def discover(protocol, timeout, targets):
    if protocol == "wfd":
        from wfd import active_scan
        from wfd.p2p import nm
        if targets:
            nm.time = StopWhenListed(nm, targets)
        peers = active_scan(timeout=timeout)
        return [
            {
                "name": peer.name or "(unknown)",
                "address": peer.address,
                "detail": peer.source or "Wi-Fi Direct",
                "capable": peer.wfd_capable,
            }
            for peer in peers
        ]
    if protocol == "monitors":
        from capture.capture import gather_monitors
        return [
            {
                "name": monitor.name,
                "address": monitor.name,
                "detail": f"{monitor.width}x{monitor.height}",
                "capable": bool(monitor.primary),
            }
            for monitor in gather_monitors()
        ]
    raise ValueError(f"unknown protocol: {protocol}")


def main():
    if len(sys.argv) < 4:
        emit({"error": "usage: scan-helper.py <app_dir> <protocol> <timeout> [stop-at-name-or-address ...]"})
        return 2

    app_dir = sys.argv[1]
    protocol = sys.argv[2]
    try:
        timeout = int(float(sys.argv[3]))
    except ValueError:
        timeout = 5
    # A wfd scan ends early once any of these names or addresses is listed.
    targets = {target.lower() for target in sys.argv[4:]}

    if protocol not in ("wfd", "monitors"):
        emit({"error": f"unknown protocol: {protocol}"})
        return 2
    if not os.path.isdir(app_dir):
        emit({"error": f"FluxCast directory not found: {app_dir}"})
        return 2

    os.chdir(app_dir)
    sys.path.insert(0, app_dir)

    try:
        with contextlib.redirect_stdout(io.StringIO()):
            devices = discover(protocol, timeout, targets)
    except SystemExit as exc:
        if EMITTED:
            raise
        if exc.code in (0, None):
            emit({"protocol": protocol, "devices": []})
            return 0
        emit({"error": "FluxCast dependencies missing (run: fluxcast --doctor)"})
        return 2
    except Exception as exc:
        emit({"error": f"{type(exc).__name__}: {exc}"})
        return 2

    emit({"protocol": protocol, "devices": devices})
    return 0


if __name__ == "__main__":
    sys.exit(main())
