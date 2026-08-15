"""
Self-signed HTTPS certificate, generated once and reused across restarts.

This app talks to your Protect controller over the real UniFi OS TLS
connection regardless; this cert is only for the browser <-> this app hop.
Being self-signed, browsers will still show a one-time "not secure"
warning to click through per browser/device -- that's inherent to
self-signed certs, not something SAN/CN correctness can avoid. What it
does get right is including your actual reachable IPs as Subject
Alternative Names, so browsers don't *also* complain about a hostname
mismatch on top of the untrusted-issuer warning.
"""
import socket
from datetime import datetime, timedelta, timezone
from pathlib import Path

CERTS_DIR = Path(__file__).parent / "certs"
CERT_PATH = CERTS_DIR / "cert.pem"
KEY_PATH = CERTS_DIR / "key.pem"


def _local_ips():
    ips = {"127.0.0.1"}
    try:
        # Doesn't actually send anything -- just asks the OS which local
        # interface/IP it would use to reach an external address, which is
        # a reliable way to find the primary LAN IP without extra deps.
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ips.add(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    try:
        ips.add(socket.gethostbyname(socket.gethostname()))
    except OSError:
        pass
    return sorted(ips)


def ensure_self_signed_cert():
    """Returns (cert_path, key_path) as strings, generating a new
    self-signed cert on first run and reusing it on subsequent starts."""
    if CERT_PATH.exists() and KEY_PATH.exists():
        return str(CERT_PATH), str(KEY_PATH)

    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID

    CERTS_DIR.mkdir(exist_ok=True)

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)

    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "unifi-facegraph")])
    san = x509.SubjectAlternativeName(
        [x509.DNSName("localhost")] + [x509.IPAddress(__import__("ipaddress").ip_address(ip)) for ip in _local_ips()]
    )

    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(datetime.now(timezone.utc) - timedelta(days=1))
        .not_valid_after(datetime.now(timezone.utc) + timedelta(days=3650))
        .add_extension(san, critical=False)
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .sign(key, hashes.SHA256())
    )

    KEY_PATH.write_bytes(
        key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.TraditionalOpenSSL,
            encryption_algorithm=serialization.NoEncryption(),
        )
    )
    CERT_PATH.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    KEY_PATH.chmod(0o600)

    return str(CERT_PATH), str(KEY_PATH)
