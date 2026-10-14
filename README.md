# CD case & player

A jewel-case CD player for your own music. Open the case, load the disc, press play. The disc label and accent colors are sampled from each cover, and the disc sheen and LCD meter follow the real audio through a Web Audio analyser.

No build step and no dependencies: plain ES modules plus a small Python server.

## Run

```bash
python3 scripts/serve.py
```

Then open http://localhost:5173.

The server exists because `python3 -m http.server` doesn't answer HTTP Range requests, which Safari needs to play audio and every browser needs to seek.

## Adding music

**Library folder.** Put your music in `albums/` and reload. Any layout works (`Artist/Album`, `Artist - Album (Year)`, loose songs, `Disc 1`/`CD 02`/`Digital Media 01` subfolders), for example:

```
albums/
  Artist - Album Title (2024)/
    cover.jpg
    01 - First Song.mp3
    02 - Second Song.mp3
```

- **Albums come from tags, not folders.** ID3v2.2/2.3/2.4 and ID3v1 (mp3, and ID3 chunks in AIFF/WAV), Vorbis comments (FLAC), MP4 atoms (m4a) and RIFF INFO (wav) supply title, artist, album artist, album, year, genre, and track/disc numbers. Ogg/Opus tags aren't read yet.
  - Tracks with an album tag are grouped by album artist (or artist) and album, wherever they live: disc subfolders merge into one album, and a stray album track in an artist folder joins its album. A compilation without an album-artist tag becomes one "Various Artists" album as long as its tracks share a folder.
  - Tagged tracks without an album tag go into one **Singles** case per artist, with a generated cover.
  - Files with no usable tags at all are grouped by folder. Names come from the folder (`Artist - Title (Year)`, or `Artist/Album (Year)`), and track titles from file names with leading numbers and `Artist - Album - NN - ` prefixes stripped.
  - Tracks are ordered by disc and track number. Hidden files and macOS `._` AppleDouble files are ignored.
- Cover priority: an image named `cover`/`folder`/`front`/`album`/`art` or `AlbumArt_*_Large`, or the only full-size image in the folder (a `Disc N` folder also looks in its parent); then art embedded in the album's first tracks; then any other image. Thumbnails like `AlbumArtSmall.jpg` are a last resort. Without any, a placeholder is generated.
- Imports stream: each album is shelved as soon as its folder has been read, sliding into its sorted slot in the rack, so the first cases appear within seconds even for thousands of tracks. A plaque above the rack shows albums shelved, tracks read and an estimate of the time left, and the status line under the player logs the same. Tags are read a few files at a time, and embedded pictures are skipped except for the few tracks a cover is taken from.
- An optional `album.json` (`{"title": …, "artist": …, "year": …}`) in an album folder overrides both tags and parsed names.
- Formats: anything your browser plays natively (mp3, m4a/aac, flac, wav, ogg/opus, webm), plus AIFF/AIFF-C. If the browser can't decode a file, the player falls back to software decoding (see below). APE and single-file album rips with a `.cue` sheet aren't supported.

**Drop or pick.** Drag album folders (or a whole music folder) onto the player, or click **+** above the rack. These live only for the current tab.

With an empty library the page shows four generated demo albums, which have no audio; their playback is simulated.

## Software decoding fallback

Some files won't play natively. For example, Chromium can't decode MPEG Layer II, which some stores ship as `.mp3`. When the browser reports an unsupported or undecodable file, the player identifies the codec from the file's first bytes and loads the matching [wasm-audio-decoders](https://github.com/eshaz/wasm-audio-decoders) build from `vendor/`. That build decodes the file in a Web Worker, and the result is played as WAV. Only the decoder that's needed is loaded.

| Codec | Decoder |
|---|---|
| MPEG Layer I/II/III | mpg123-decoder |
| FLAC, Ogg FLAC | @wasm-audio-decoders/flac |
| Ogg Vorbis | @wasm-audio-decoders/ogg-vorbis |
| Ogg Opus | ogg-opus-decoder |
| AIFF, AIFF-C | built in (byte swap to WAV, no WASM) |

After one track in an album fails natively, the rest of that album is decoded directly. The next track is decoded in the background while the current one plays. Up to three decoded tracks are kept in memory, at about 47 MB each for 4½ minutes of stereo. Versions and update instructions are in `vendor/README.txt`; to add a codec, see the `DECODERS` table in `js/decoders.js`.

## Controls

Space plays and pauses, ← goes to the previous track and → to the next. Media keys and the OS now-playing controls work through the Media Session API.

- **Seek:** click or drag the progress bar in the LCD, or focus it and use ←/→ for 5-second steps (Home/End jump to the start or end).
- **Volume:** drag the knob up or down, scroll on it, or focus it and use the arrow, Page Up/Down and Home/End keys. The setting is remembered per browser.
- **Track list:** with the case open, click a track on the liner notes to play from there.

## Static hosting

`python3 scripts/scan_library.py` writes `albums/library.json`, so the folder can be served by any static host. The host must support Range requests, which most do.
