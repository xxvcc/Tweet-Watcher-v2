#!/usr/bin/env python3
"""Test-only launcher: real collector protocol/signing, loopback TLS transport.

Usage: .venv/bin/python -I scripts/simulation/bridge.py TLS_PORT CERT_PEM
The fixture server must serve an x.com/abs.twimg.com certificate trusted by
CERT_PEM. No production module gains an environment flag or test entrypoint.
"""
from __future__ import annotations

import asyncio
import importlib.util
from pathlib import Path
import sys
from urllib.parse import urlsplit, urlunsplit

from curl_cffi import CurlOpt

ROOT = Path(__file__).resolve().parents[2]
ALLOWED_HOSTS = frozenset(("x.com", "abs.twimg.com"))


def install_loopback_transport(port: int, certificate: Path):
    spec = importlib.util.spec_from_file_location("simulation_real_bridge", ROOT / "collector" / "bridge.py")
    if spec is None or spec.loader is None:
        raise RuntimeError("Simulation bridge import failed")
    bridge = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bridge)
    original_session = bridge.AsyncSession

    class LoopbackSession(original_session):
        def __init__(self, *args, **kwargs):
            # Certificate/hostname verification stays enabled. Production calls
            # request(verify=True), which preserves this session's explicit CA.
            kwargs["verify"] = str(certificate)
            kwargs["trust_env"] = False
            options = dict(kwargs.pop("curl_options", {}) or {})
            options[CurlOpt.RESOLVE] = [f"{host}:{port}:127.0.0.1".encode() for host in sorted(ALLOWED_HOSTS)]
            kwargs["curl_options"] = options
            super().__init__(*args, **kwargs)

        async def request(self, method, url, **kwargs):
            original = urlsplit(url)
            if (original.scheme != "https" or original.hostname not in ALLOWED_HOSTS
                    or original.port not in (None, 443) or original.username is not None
                    or original.password is not None or original.fragment):
                raise RuntimeError("Simulation blocked a non-fixture destination")
            # Explicit proxy scenarios must also stay on loopback. CONNECT is
            # handled by the parent fixture proxy, never a public proxy/DNS host.
            proxy = kwargs.get("proxy")
            if proxy:
                parsed = urlsplit(proxy)
                if (parsed.scheme not in ("http", "https") or parsed.hostname not in ("127.0.0.1", "::1", "localhost")
                        or parsed.port is None or parsed.username is not None or parsed.password is not None):
                    raise RuntimeError("Simulation blocked a non-loopback proxy")
            if kwargs.get("proxies") or kwargs.get("doh_url") or kwargs.get("verify") is False:
                raise RuntimeError("Simulation blocked a transport override")
            # SafeTransport already checked the original production URL. Keep
            # its hostname/SNI and complete path/query while routing its port.
            routed = urlunsplit(original._replace(netloc=f"{original.hostname}:{port}"))
            return await super().request(method, routed, **kwargs)

    bridge.AsyncSession = LoopbackSession
    return bridge


def main():
    if len(sys.argv) != 3:
        raise RuntimeError("Simulation requires a local TLS port and CA certificate")
    port = int(sys.argv[1])
    if not 1 <= port <= 65535:
        raise RuntimeError("Simulation TLS port is invalid")
    certificate = Path(sys.argv[2]).resolve(strict=True)
    if not certificate.is_file():
        raise RuntimeError("Simulation CA certificate is invalid")
    bridge = install_loopback_transport(port, certificate)
    sys.stdout.reconfigure(encoding="utf-8", errors="strict", newline="\n")
    asyncio.run(bridge.run())


if __name__ == "__main__":
    try:
        main()
    except (BrokenPipeError, KeyboardInterrupt):
        pass
    except Exception:
        # Match the real launcher's safe failure boundary; input and credentials
        # must never become traceback/diagnostic text.
        sys.stderr.write("Simulation bridge stopped safely\n")
        sys.exit(1)
