Vendored builds of wasm-audio-decoders (MIT, (c) Ethan Halsall, https://github.com/eshaz/wasm-audio-decoders).
Loaded on demand by js/decoders.js only when the browser cannot play a file natively.

  mpg123-decoder.min.js       mpg123-decoder@1.0.3                 MPEG Layer I/II/III
  flac-decoder.min.js         @wasm-audio-decoders/flac@0.2.11     FLAC, Ogg FLAC
  ogg-vorbis-decoder.min.js   @wasm-audio-decoders/ogg-vorbis@0.1.20  Ogg Vorbis
  ogg-opus-decoder.min.js     ogg-opus-decoder@1.7.5               Ogg Opus

Update: curl -L https://unpkg.com/<package>@<version>/dist/<file> -o vendor/<file>
