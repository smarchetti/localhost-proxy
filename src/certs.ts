// Local TLS: a name-constrained private CA plus one multi-SAN leaf cert.
//
// Public CAs can't issue for .test, so `lhp` runs its own CA (~/.lhp/ca).
// The CA carries an X.509 name constraint limiting it to the configured
// domain and localhost — even if the key leaked, it could never mint certs
// for real websites. The daemon auto-creates the CA; `lhp setup` adds it to
// the system trust store (the only sudo step).
//
// TLS wildcards match a single label and clients reject TLD-depth wildcards
// like *.test, so instead of per-host certs (Bun lacks SNICallback) we keep
// ONE leaf whose SANs cover every registered host explicitly plus a
// *.<repo>.<domain> wildcard per repo, re-minted when the set changes.
// openssl ships with macOS (LibreSSL) and Linux; note LibreSSL defaults to
// SHA-1 signatures, so every signing command pins -sha256.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR, DOMAIN } from './shared';

const CA_DIR = path.join(STATE_DIR, 'ca');
export const CA_KEY = path.join(CA_DIR, 'ca.key');
export const CA_CERT = path.join(CA_DIR, 'ca.pem');
const CA_DOMAIN = path.join(CA_DIR, 'domain');

const CERT_DIR = path.join(STATE_DIR, 'certs');
export const LEAF_KEY = path.join(CERT_DIR, 'leaf.key');
export const LEAF_CERT = path.join(CERT_DIR, 'leaf.pem');
const LEAF_SANS = path.join(CERT_DIR, 'sans');

function openssl(args: string[]): void {
  execFileSync('openssl', args, { stdio: ['ignore', 'ignore', 'pipe'] });
}

function writePrivate(file: string): void {
  fs.chmodSync(file, 0o600);
}

export function caExists(): boolean {
  try {
    return (
      fs.existsSync(CA_KEY) &&
      fs.existsSync(CA_CERT) &&
      fs.readFileSync(CA_DOMAIN, 'utf8').trim() === DOMAIN
    );
  } catch {
    return false;
  }
}

// Creates the CA when missing, or when the configured domain changed (the
// name constraint must cover it). Returns true when a new CA was minted —
// callers should tell the user to re-run `lhp setup` to trust it.
export function ensureCa(): boolean {
  if (caExists()) return false;
  fs.rmSync(CA_DIR, { recursive: true, force: true });
  fs.mkdirSync(CA_DIR, { recursive: true });

  const config = path.join(CA_DIR, 'ca.cnf');
  fs.writeFileSync(config, [
    '[req]',
    'distinguished_name = dn',
    'x509_extensions = v3_ca',
    'prompt = no',
    '[dn]',
    'CN = localhost-proxy local CA',
    '[v3_ca]',
    'basicConstraints = critical,CA:TRUE,pathlen:0',
    'keyUsage = critical,keyCertSign,cRLSign',
    'subjectKeyIdentifier = hash',
    `nameConstraints = critical,permitted;DNS:${DOMAIN},permitted;DNS:.${DOMAIN},permitted;DNS:localhost,permitted;DNS:.localhost,permitted;IP:127.0.0.1/255.255.255.255`,
    '',
  ].join('\n'));

  openssl(['ecparam', '-genkey', '-name', 'prime256v1', '-out', CA_KEY]);
  writePrivate(CA_KEY);
  openssl(['req', '-x509', '-new', '-sha256', '-key', CA_KEY, '-days', '3650', '-config', config, '-out', CA_CERT]);
  fs.writeFileSync(CA_DOMAIN, DOMAIN + '\n');
  fs.rmSync(config, { force: true });
  return true;
}

// Ensures the leaf cert covers exactly these SAN entries (e.g. "DNS:foo.test",
// "IP:127.0.0.1"). Returns true when a new cert was minted.
export function ensureLeaf(sans: string[]): boolean {
  const wanted = [...new Set(sans)].sort().join(',');
  try {
    if (
      fs.readFileSync(LEAF_SANS, 'utf8').trim() === wanted &&
      fs.existsSync(LEAF_KEY) &&
      fs.existsSync(LEAF_CERT)
    ) {
      return false;
    }
  } catch {
    // no leaf yet
  }

  fs.mkdirSync(CERT_DIR, { recursive: true });
  const csr = path.join(CERT_DIR, 'leaf.csr');
  const ext = path.join(CERT_DIR, 'leaf.cnf');
  fs.writeFileSync(ext, [
    'basicConstraints = CA:FALSE',
    'keyUsage = critical,digitalSignature,keyEncipherment',
    'extendedKeyUsage = serverAuth',
    `subjectAltName = ${wanted}`,
    '',
  ].join('\n'));

  if (!fs.existsSync(LEAF_KEY)) {
    openssl(['ecparam', '-genkey', '-name', 'prime256v1', '-out', LEAF_KEY]);
    writePrivate(LEAF_KEY);
  }
  openssl(['req', '-new', '-key', LEAF_KEY, '-subj', '/CN=localhost-proxy', '-out', csr]);
  // Apple caps locally-trusted TLS certs at 825 days; 398 is safely inside.
  openssl(['x509', '-req', '-sha256', '-in', csr, '-CA', CA_CERT, '-CAkey', CA_KEY, '-CAcreateserial', '-days', '398', '-extfile', ext, '-out', LEAF_CERT]);
  fs.writeFileSync(LEAF_SANS, wanted + '\n');
  fs.rmSync(csr, { force: true });
  fs.rmSync(ext, { force: true });
  return true;
}
