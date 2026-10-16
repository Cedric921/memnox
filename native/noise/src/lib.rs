//! The one Noise layer the Memnox runtime and the iPhone share. Every cipher, hash, DH and nonce comes from snow.

pub mod core;

#[cfg(feature = "node")]
mod node;

#[cfg(feature = "ffi")]
pub mod ffi;
