# promo — the product videos
[简体中文](README.zh.md)

Everything under this directory exists to produce video about pi-xfer. Each
subdirectory is one cut: its captures, its composition timeline, and a
`build.mjs` that turns them into an MP4.

```
promo/
  intro/     "Intro: pi-xfer" — the 76s overview published on YouTube
```

Only sources are tracked. Every media product — MP4s, the music bed, poster
frames, capture output — is gitignored and rebuilt locally, so this repository
carries no binary weight. See `.gitignore` in this directory.

## One command per video

```sh
brew install vhs ffmpeg        # once
node promo/intro/build.mjs      # capture everything, render, compress
```

That prints where the products landed; they are gitignored and therefore local
only. The published cut lives on YouTube — see the Demo section of the top-level
README.

## Adding another video

Give it a sibling directory named for what it shows (`web-picker/`, `mesh/`,
`admin/`) and give it its own `build.mjs` and composition timeline.

Two things worth knowing before you do:

- **Copy `intro/capture/lib/`.** It holds the tape builder, the retimer and the
  music-bed synthesizer. The first two are shot-agnostic; the synthesizer takes
  the video's length and writes a matching bed.
- **Do not factor out shared tooling yet.** Each cut is shot-specific — its
  durations, captions and layout are authored in its own capture scripts. A
  second video will most likely want its own shots rather than a variant of the
  first. Abstract when two cuts actually want the same thing, not before.

Each video's own directory carries a README describing its shots and how its
data is produced.