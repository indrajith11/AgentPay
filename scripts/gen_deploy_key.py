#!/usr/bin/env python3
"""Regenerate the GitHub deploy keypair after a workspace reset.
Writes /home/z/.ssh/id_ed25519 (+ .pub), backups to /tmp/my-project/.ssh-backup/,
prints the pubkey for the user to authorize at GitHub -> Deploy keys (write).
"""
import os, sys, stat

KEY = os.path.expanduser("~/.ssh/id_ed25519")

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives import serialization

key = Ed25519PrivateKey.generate()
priv = key.private_bytes(
    serialization.Encoding.PEM,
    serialization.PrivateFormat.OpenSSH,
    serialization.NoEncryption(),
)
pub = key.public_key().public_bytes(
    serialization.Encoding.OpenSSH,
    serialization.PublicFormat.OpenSSH,
).decode()

os.makedirs(os.path.dirname(KEY), exist_ok=True)
with open(KEY, "wb") as f:
    f.write(priv)
os.chmod(KEY, 0o600)
with open(KEY + ".pub", "w") as f:
    f.write(pub + " indrajith11@AgentPay-deploy\n")

# reset-proof backup
bak = "/tmp/my-project/.ssh-backup"
os.makedirs(bak, exist_ok=True)
with open(os.path.join(bak, "id_ed25519"), "wb") as f:
    f.write(priv)
os.chmod(os.path.join(bak, "id_ed25519"), 0o600)

print("PUBKEY (add at github.com/indrajith11/AgentPay -> Settings -> Deploy keys -> Allow write access):")
print(pub)
