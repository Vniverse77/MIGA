# MIGA protocol test vectors

Cross-implementation test vectors for MIGA protocol v0 (see `docs/PROTOCOL.md` and `docs/ENGINE.md`).
The TypeScript web client is the reference; other clients (the Rust CLI) must reproduce every file.

- `test-vectors/*.json` are **generated** by `gen-vectors.ts`, which imports the real modules from
  `web/src/lib` (no copies) with a seeded RNG and a fixed clock (`1700000000000`). Never edit them by hand.
- `check-vectors.ts` decrypts/recomputes every vector with the real modules and checks that regenerating
  gives byte-identical files.
- `lib.ts` holds the deterministic RNG and the shared imports.

```
cd web
deno install            # once
deno task vectors       # regenerate protocol/test-vectors/
deno task vectors:check # self-check
```

CI regenerates the vectors and fails on `git diff protocol/test-vectors`. A change to the wire format
must update `docs/PROTOCOL.md`, `docs/ENGINE.md`, the TS code and the vectors together.

Files: `identity`, `auth`, `pair-key`, `safety`, `envelope` (real encrypt of every payload type),
`envelope-raw` (hand-made plaintexts that probe decrypt leniency), `envelope-negative`, `padding`,
`validators` (clean* functions, JS whitespace set, UTF-16 length cases), `address` (valid, low-order,
non-canonical), `link` (code, scrypt, bundle seal), `sync-seal` (AAD), `sync-logic` (merge, history
pages, tombstones), `file-chunks` (attachment chunks and the chunk nonce table).

Notes for implementers: some strings contain lone UTF-16 surrogates (escaped `\udXXX`), which a Rust
`String` cannot hold; skip or special-case those cases. Cases marked `source: "raw"` are plaintexts sealed
by the generator itself to probe the receiver; `source: "real"` came from the app's own encrypt functions.
The deno config lives in `web/deno.json` so the web package's npm dependencies resolve; `web/scripts/vector-deps.ts`
re-exports the noble primitives for the generator.
