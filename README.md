# opencode-imagestripping-plugin

Treat base64 images in [OpenCode](https://opencode.ai) sessions as **one-shot observations**.

## The problem

OpenCode persists every image it has ever seen (screenshots, `read`-tool image output, pasted
clipboard images) and **re-sends the full base64 in every subsequent model request**. Base64
images are byte-heavy but token-cheap: a 1.6 MB PNG bills as a couple of thousand vision tokens
yet adds ~2.1 MB to the raw HTTP body. The result:

- The provider (or a proxy/gateway in front of it) rejects the request with
  `413` / `request body is too large` / `Exceeded limit on max bytes to request body`.
- Token-based auto-compaction never fires, because token usage is nowhere near the
  context window — only the raw body size is over the limit.
- The session is permanently stuck: every later message replays the same oversized
  history, and even `/compact` fails, because the summarization request ships the
  full transcript too.

Related upstream issues: [anomalyco/opencode#14562](https://github.com/anomalyco/opencode/issues/14562),
[#19525](https://github.com/anomalyco/opencode/issues/19525),
[#35112](https://github.com/anomalyco/opencode/issues/35112).

## What this plugin does

| Request flow | Behavior |
| --- | --- |
| Agent loop (`context` hook) | Images in the **current turn** (after the last user message) are sent untouched. Images from **older turns** are replaced in the outgoing request with a text placeholder. |
| Compaction (`compaction` hook) | All images are stripped from the transcript being summarized, so `/compact` never trips the size limit. |
| Transient `generate` calls | Same as the agent loop. |

Each stripped image is **preserved** as an immutable, content-hash-named file in a local store
(dir `700`, files `600`), and its slot becomes:

```text
[image stripped from history to keep the request within provider size limits:
"shot.png", image/png, ~2.1 MB. A copy is preserved at
~/.local/share/opencode/image-stripping/images/3f2a…​.png — use the read tool on that
path to view the image again.]
```

So the session can always retrieve the exact image again, much later — the model just `read`s
the path and the real pixels come back.

Only the **outgoing request** is rewritten. Persisted history, the TUI, session export, revert
and fork all keep the original images. The rewrite is deterministic (same part replaced the
same way every request), so wire history stays byte-stable and provider prompt caching keeps
working.

## Install

**Option A — global plugins directory (recommended):**

```sh
git clone https://github.com/ATEFred/Opencode-imagestripping-plugin
mkdir -p ~/.config/opencode/plugins
ln -s "$HOME/Opencode-imagestripping-plugin" ~/.config/opencode/plugins/image-stripping
```

OpenCode discovers plugins under `~/.config/opencode/plugins/` automatically, watches them,
and hot-reloads changes.

**Option B — config entry** in `~/.config/opencode/opencode.json` (or project config):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/path/to/opencode-imagestripping-plugin",
      // all options optional:
      "options": {
        "dir": "~/.local/share/opencode/image-stripping/images",
        "keepCurrentTurn": true,
        "minBytes": 0,
        "pruneDays": 30,
        "debug": false
      }
    }
  ]
}
```

The plugin deliberately imports nothing from `@opencode/plugin` (discovered/path plugins
often cannot resolve that package); it uses the plain `export default { id, setup }` shape,
so no install step or dependencies are required.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `dir` | `~/.local/share/opencode/image-stripping/images` (`$XDG_DATA_HOME` respected) | Where preserved image copies live. |
| `keepCurrentTurn` | `true` | Keep images from the last user turn in agent requests. Set `false` to strip every image from agent requests too. |
| `minBytes` | `0` | Only strip images whose decoded size is at least this many bytes (e.g. `32768` to let small icons pass through). |
| `pruneDays` | `30` | Stored copies older than this are deleted at service startup. `0` disables pruning. |
| `debug` | `false` | Append strip activity to `<dir>/plugin-debug.log`. |

## Notes & limitations

- Stripping happens at request assembly time, so the **session database** still contains the
  original base64. Disk copies are therefore additional, not a replacement. (Upstream does not
  currently expose a supported way to rewrite persisted parts.)
- If a *single* fresh turn embeds an oversized image, it goes out as-is — the model needs it
  then. Fix the source (downscale before `read`) or your gateway's body limit for that case.
- Copy filenames are sha256 of the base64 payload (first 24 hex chars) plus an extension
  derived from the MIME type or original filename; identical images dedupe automatically.

## License

MIT
