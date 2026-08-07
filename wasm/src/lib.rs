//! Re-export of the Verus SDK's WebAssembly bindings, and nothing else.
//!
//! There is deliberately no code here. Key handling, transaction building and
//! signing all live in `verus-wasm`, which is pinned by revision in
//! `Cargo.toml` to the same commit the `pecu` CLI uses. That pin is the point:
//! a wallet that signs differently from the CLI would be a second
//! implementation of consensus-critical serialisation, which is exactly the
//! thing worth never having twice.
//!
//! The glob re-export is what makes `wasm-bindgen` emit JS glue for the SDK's
//! exports from this crate's `cdylib`.

pub use verus_wasm::*;
