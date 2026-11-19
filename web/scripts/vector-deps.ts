// Re-exports the noble primitives for protocol/gen-vectors.ts. protocol/ is outside the web
// package, so Deno cannot resolve bare `@noble/...` imports from there; going through this file
// makes the generator use the exact versions (and lockfile entries) the web app uses.
export { xchacha20poly1305 } from '@noble/ciphers/chacha';
export { ed25519, edwardsToMontgomeryPriv, edwardsToMontgomeryPub, x25519 } from '@noble/curves/ed25519';
export { hkdf } from '@noble/hashes/hkdf';
export { scryptAsync } from '@noble/hashes/scrypt';
export { sha256, sha512 } from '@noble/hashes/sha2';
export { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';
