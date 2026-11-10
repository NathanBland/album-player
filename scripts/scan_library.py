#!/usr/bin/env python3
"""Scan albums/ and describe it as JSON for the player.

Each directory under albums/ that contains audio files becomes one folder record. The browser
(js/library.js) reads the tracks' embedded tags and regroups them into albums, so these records only
carry what tags can't: folder-name fallbacks ("Artist - Album (2024)"), the folder's cover image, and
album.json overrides (title/artist/year). A "Disc N" folder takes its name and cover from its parent.

The library lives in albums/ by default; set MUSIC_DIR to scan a folder anywhere else (the Docker
image mounts the collection at /music). Track URLs are always "albums/<path inside the library>",
and serve.py maps that URL prefix onto MUSIC_DIR.

Run directly to write library.json into the library folder (for static hosting).
"""
import json
import os
import re
import sys
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parent.parent
ALBUMS = Path(os.environ.get("MUSIC_DIR") or ROOT / "albums")
AUDIO = {".mp3", ".m4a", ".aac", ".flac", ".wav", ".aiff", ".aif", ".ogg", ".oga", ".opus", ".webm"}
IMAGES = {".jpg", ".jpeg", ".png", ".webp", ".gif"}
COVER_NAMES = ["cover", "folder", "front", "album", "art"]
DISC_DIR = re.compile(r"^(?:disc|disk|cd|digital\s*media)\s*[-_.]?\s*\d+\b", re.I)  # "CD 02", "Digital Media 01"


def natural_key(name):
    return [int(p) if p.isdigit() else p.lower() for p in re.split(r"(\d+)", name)]


def track_title(name):
    stem = Path(name).stem
    named = re.match(r"^.+? - (?:.+? - )?(?:\d+-)?\d{1,3} - (.+)$", stem)  # "Artist - [Album - ]NN - Title"
    title = re.sub(r"^\s*(?:\d+-)?\d{1,3}(?:\s*[-._)]+\s*|\s+)", "", named.group(1) if named else stem).replace("_", " ").strip()
    return title or stem


def parse_folder(name):
    year = None
    m = re.search(r"\s*[\[(](\d{4})[\])]\s*$", name)
    if m:
        year, name = int(m.group(1)), name[: m.start()]
    m = re.match(r"^(.+?)\s+-\s+(.+)$", name)
    if m:
        return {"artist": m.group(1).strip(), "title": m.group(2).strip(), "year": year}
    return {"artist": "Unknown artist", "title": name.strip(), "year": year}


def url(path):
    return "albums/" + quote(path.relative_to(ALBUMS).as_posix())


def pick_cover(images):
    """Return (image, named). A conventionally named image or the only image counts as the cover;
    otherwise the first image is just a fallback behind embedded art (the browser decides)."""
    for want in COVER_NAMES:
        for img in images:
            if img.stem.lower() == want:
                return img, True
    for img in images:  # Windows Media Player's AlbumArt_{GUID}_Large.jpg
        if re.match(r"^albumart_.*_large$", img.stem.lower()):
            return img, True
    full = [i for i in images if not re.search(r"(?:^albumartsmall$|_small$|thumb)", i.stem.lower())]
    if full:
        return full[0], len(full) == 1
    return (images[0], False) if images else (None, False)  # only thumbnails: last resort


unreadable = []  # folders the last scan couldn't open, for diagnose()


def scan():
    unreadable.clear()
    if not ALBUMS.is_dir():
        return []
    albums = []
    # os.walk(followlinks=True): a library symlinked into albums/ (e.g. a NAS share) is scanned too;
    # Path.rglob skips symlinked folders before Python 3.13. onerror: os.walk otherwise skips
    # unreadable folders silently, which makes a permissions problem look like an empty library.
    walked = [Path(r) for r, ds, _ in os.walk(ALBUMS, followlinks=True, onerror=unreadable.append) if not ds.sort()]
    for d in sorted(walked, key=lambda p: natural_key(p.as_posix())):
        if not d.is_dir() or any(part.startswith(".") for part in d.relative_to(ALBUMS).parts):
            continue
        try:
            files = sorted((f for f in d.iterdir() if f.is_file() and not f.name.startswith(".")), key=lambda f: natural_key(f.name))
        except OSError as e:  # e.g. a symlink into a macOS-protected folder like ~/Downloads
            unreadable.append(e)
            continue
        audio = [f for f in files if f.suffix.lower() in AUDIO]
        if not audio:
            continue
        in_disc = bool(DISC_DIR.match(d.name)) and d != ALBUMS
        home = d.parent if in_disc else d
        # loose files at the library root: don't name them after the "albums" folder
        meta = parse_folder(home.name) if home != ALBUMS else {"artist": "Unknown artist", "title": "Loose tracks", "year": None}
        if meta["artist"] == "Unknown artist" and home != ALBUMS and home.parent != ALBUMS:
            meta["artist"] = home.parent.name  # "Artist/Album (2024)" layout
        overrides = {}
        override = d / "album.json"
        if override.is_file():
            try:
                overrides = {k: v for k, v in json.loads(override.read_text()).items() if k in ("title", "artist", "year")}
            except (ValueError, OSError) as e:
                print(f"warning: ignoring {override}: {e}", file=sys.stderr)
        cover, named = pick_cover([f for f in files if f.suffix.lower() in IMAGES])
        if not cover and in_disc:
            try:
                cover, named = pick_cover(sorted((f for f in d.parent.iterdir() if f.is_file() and not f.name.startswith(".")
                                                  and f.suffix.lower() in IMAGES), key=lambda f: natural_key(f.name)))
            except OSError:
                pass
        albums.append({
            **meta,
            "dir": d.relative_to(ALBUMS).as_posix() if d != ALBUMS else "",
            "cover": url(cover) if cover else None,
            "coverNamed": named,
            "overrides": overrides,  # applied in the browser after embedded tags
            "tracks": [{"title": track_title(f.name), "src": url(f), "file": f.name} for f in audio],
        })
    return albums


def _whoami():
    try:
        return f"uid {os.getuid()}, gid {os.getgid()}"
    except AttributeError:  # Windows
        return "the current user"


def _other_mounts():
    """Mount points (Linux) that look like a music share, for 'did you mean /music?' hints."""
    try:
        lines = Path("/proc/mounts").read_text().splitlines()
    except OSError:
        return []
    found = []
    for line in lines:
        parts = line.split()
        if len(parts) < 3:
            continue
        point, fstype = parts[1].replace("\\040", " "), parts[2]
        if point == str(ALBUMS) or point.startswith(("/proc", "/sys", "/dev", "/run", "/etc/")) or point == "/":
            continue
        if fstype.startswith(("nfs", "cifs", "smb", "fuse")) or point.startswith(("/mnt", "/media", "/data", "/srv")):
            found.append(point)
    return found


def diagnose(track_count):
    """Explain a scan that found nothing (or skipped folders), as warning lines; [] when all is well."""
    where = f"music folder {ALBUMS}"
    hints = []
    if track_count == 0:
        try:
            entries = [n for n in os.listdir(ALBUMS) if not n.startswith(".") and n != "library.json"]
        except FileNotFoundError:
            entries, hints = None, [f"{where} doesn't exist."]
        except OSError as e:
            entries, hints = None, [f"can't read {where} as {_whoami()}: {e.strerror}. "
                                    "Run as a user that can read it (Docker: user: \"<uid>:<gid>\" matching the files' owner)."]
        if entries == []:
            hints.append(f"{where} is empty. Mount your collection there (Docker: the right side of the volume "
                         f"must be {ALBUMS}, e.g. /path/to/music:{ALBUMS}:ro) or set MUSIC_DIR to where it is.")
        elif entries and not unreadable:
            hints.append(f"no audio files found in {where} ({len(entries)} item(s) at the top level). "
                         f"Looked for: {' '.join(sorted(AUDIO))}.")
        if entries is not None and not entries:
            others = _other_mounts()
            if others:
                hints.append(f"found a mount at {', '.join(others)}: did you mean to mount it at {ALBUMS}?")
    if unreadable:
        first = unreadable[0]
        owner = ""
        try:
            st = os.stat(first.filename)
            owner = f", owned by uid {st.st_uid} gid {st.st_gid}"
        except (OSError, TypeError):
            pass
        hints.append(f"{len(unreadable)} folder(s) couldn't be read as {_whoami()}, e.g. {first.filename}: "
                     f"{first.strerror}{owner}. Docker: set user: \"<uid>:<gid>\" to match the files' owner.")
    return hints


if __name__ == "__main__":
    ALBUMS.mkdir(exist_ok=True)
    found = scan()
    (ALBUMS / "library.json").write_text(json.dumps({"albums": found}, indent=2))
    print(f"Wrote {ALBUMS / 'library.json'} with {len(found)} album(s).")
    for hint in diagnose(sum(len(a["tracks"]) for a in found)):
        print(f"warning: {hint}", file=sys.stderr)
