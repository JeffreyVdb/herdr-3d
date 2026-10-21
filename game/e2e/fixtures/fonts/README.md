# H3D Test Symbols

The Ubuntu symbol-width browser test uses this small font fixture instead of the
host's optional monospace fonts. It keeps the application's fallback family and
font descriptors, including `size-adjust`; only the font bytes are controlled.
The fixture is never part of the game bundle.

Source: [DejaVu 2.37](https://github.com/dejavu-fonts/dejavu-fonts/releases/tag/version_2_37),
`dejavu-fonts-ttf-2.37.zip`, SHA-256
`7576310b219e04159d35ff61dd4a4ec4cdba4f35c00e002a136f00e96a908b0a`.
This is the same release used for the game's `src/fonts/h3d-box`.

The subset contains the test's symbols from DejaVu Sans Mono. Its one braille
character, absent from Mono, comes from DejaVu Sans in the same archive, scaled
horizontally to Mono's advance. The modified font is named H3D Test Symbols;
`LICENSE` contains the license text from the archive.

Regenerate after downloading the pinned release asset:

```sh
uv run --python 3.12 --with 'fonttools[woff]==4.67.0' --with 'brotli==1.2.0' python game/e2e/fixtures/fonts/build-symbols.py /path/to/dejavu-fonts-ttf-2.37.zip
```
