//! Identity, addresses and the Ed25519 to X25519 conversion (ENGINE.md sections 2 and 3).
use crate::{from_hex_array, js::is_lower_hex, random_bytes, to_hex, Error, Result};
use curve25519_dalek::edwards::CompressedEdwardsY;
use curve25519_dalek::montgomery::MontgomeryPoint;
use ed25519_dalek::{Signer, SigningKey};
use sha2::{Digest, Sha512};
use zeroize::Zeroizing;

/// A 32-byte Ed25519 seed and its address (lowercase hex of the public key).
#[derive(Clone)]
pub struct Identity {
    seed: Zeroizing<[u8; 32]>,
    address: String,
}

impl std::fmt::Debug for Identity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Identity({})", self.address)
    }
}

impl Identity {
    pub fn from_seed(seed: [u8; 32]) -> Self {
        let address = to_hex(SigningKey::from_bytes(&seed).verifying_key().as_bytes());
        Identity { seed: Zeroizing::new(seed), address }
    }

    pub fn from_seed_hex(text: &str) -> Result<Self> {
        if !is_lower_hex(text, 64) {
            return Err(Error::Invalid("seed must be 64 lowercase hex characters"));
        }
        Ok(Self::from_seed(from_hex_array(text)?))
    }

    pub fn generate() -> Result<Self> {
        Ok(Self::from_seed(random_bytes::<32>()?))
    }

    pub fn address(&self) -> &str {
        &self.address
    }

    pub fn seed(&self) -> &[u8; 32] {
        &self.seed
    }

    pub fn seed_hex(&self) -> String {
        to_hex(&*self.seed)
    }

    /// `Ed25519(seed, utf8("miga-auth-v0:" + nonceHex))`, 128 hex characters. The hex STRING of the
    /// nonce is signed, not the decoded bytes.
    pub fn sign_auth(&self, nonce: &str) -> String {
        let msg = format!("miga-auth-v0:{nonce}");
        to_hex(&SigningKey::from_bytes(&self.seed).sign(msg.as_bytes()).to_bytes())
    }

    /// `edwardsToMontgomeryPriv`: the first 32 bytes of SHA-512(seed), clamped.
    pub fn x25519_secret(&self) -> Zeroizing<[u8; 32]> {
        let (_, clamped) = x25519_secret_from_seed(&self.seed);
        clamped
    }

    /// X25519 with a peer address. `None` for an invalid address or an all-zero result.
    pub fn shared_secret(&self, peer: &str) -> Option<Zeroizing<[u8; 32]>> {
        let u = address_to_montgomery(peer)?;
        x25519(&self.x25519_secret(), &u).map(Zeroizing::new)
    }
}

/// Returns `(SHA-512(seed)[0..32], the same clamped)`.
pub fn x25519_secret_from_seed(seed: &[u8; 32]) -> ([u8; 32], Zeroizing<[u8; 32]>) {
    let hash = Sha512::digest(seed);
    let mut first = [0u8; 32];
    first.copy_from_slice(&hash[..32]);
    let mut clamped = first;
    clamped[0] &= 248;
    clamped[31] &= 127;
    clamped[31] |= 64;
    (first, Zeroizing::new(clamped))
}

/// `edwardsToMontgomeryPub` on a 64-hex address. Rejects text that is not lowercase hex, bytes
/// that do not decode to a curve point and non-canonical encodings (y >= p, or x = 0 with the
/// sign bit set).
pub fn address_to_montgomery(address: &str) -> Option<[u8; 32]> {
    if !is_lower_hex(address, 64) {
        return None;
    }
    let bytes: [u8; 32] = from_hex_array(address).ok()?;
    let point = CompressedEdwardsY(bytes).decompress()?;
    if point.compress().0 != bytes {
        return None;
    }
    Some(point.to_montgomery().to_bytes())
}

/// X25519(scalar, u). `None` when the result is all zero (low-order input), like noble throws.
pub fn x25519(secret: &[u8; 32], u: &[u8; 32]) -> Option<[u8; 32]> {
    let shared = MontgomeryPoint(*u).mul_clamped(*secret).to_bytes();
    (shared != [0u8; 32]).then_some(shared)
}

/// `isAddress`: 64 lowercase hex characters that convert to a curve point and survive a probe
/// key agreement (rejects low-order points).
pub fn is_address(value: &str) -> bool {
    match address_to_montgomery(value) {
        Some(u) => x25519(&[7u8; 32], &u).is_some(),
        None => false,
    }
}
