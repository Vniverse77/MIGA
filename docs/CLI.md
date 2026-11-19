# MIGA terminal client

`miga` with no arguments opens the chat UI. The subcommands (`init`, `address`, `add`, `contacts`, `send`, `listen`, `log`)
work without a terminal UI and are meant for scripts. Protocol and engine rules: `PROTOCOL.md`, `ENGINE.md`.

## Chat UI

- Left: chat list (name, last message, time, unread badge, `Draft:` marker). Right: conversation with date separators,
  own and other messages on filled bubbles, delivery ticks (`...` pending, one tick sent, two ticks delivered, bright two
  ticks read, `failed`), reply quotes, `edited`, and a marker where a message was deleted. Bottom: composer. Footer: hints for the
  current pane, notices and the version. Header: connection state (`online`, `connecting`, `offline`).
- Below 80 columns (`sidebar_collapse_below`) only one pane is shown: the list or the conversation (`Tab`, `Ctrl+B`).
- Messages written while offline are saved as pending and sent when the relay is reachable again. Editing and deleting for
  everyone need a connection (the change is applied locally after the relay accepted the request).
- Read receipts (`seen`) are sent for the open chat only while the terminal has focus and the view is at the bottom
  (`show_receipts = false` turns them off). Delivery receipts are always sent.

### Keys

Press `?` (or `F1`) for the list generated from the active key map. Defaults:

| Where | Keys |
|---|---|
| Anywhere | `Ctrl+K` / `Ctrl+P` quick switcher, `Ctrl+N` new chat by address, `Alt+A` next unread chat, `Alt+Up/Down` previous/next chat, `Tab` / `Shift+Tab` pane, `Ctrl+B` back to the list, `F2` your address, `F1` help, `Ctrl+C` / `Ctrl+Q` quit |
| Chat list | `j` `k` / arrows, `g` `G`, `Enter` open, `?` help, `q` quit, `:` command line |
| Messages | `j` `k`, `g` `G`, `PgUp` `PgDn`, `r` reply, `e` edit (own), `d` delete for everyone (own, asks first), `y` copy (OSC 52), `o` open the first link, `Enter` / `i` / `Esc` back to the composer |
| Composer | `Enter` send, `Alt+Enter` / `Shift+Enter` / `Ctrl+J` new line, `Up` in an empty composer edits your last message, `Ctrl+E` write in `$VISUAL`/`$EDITOR`, `Esc` cancel reply/edit or go to the messages, `PgUp` `PgDn` scroll, readline keys (`Ctrl+A/E/W/U`, `Alt+B/F`) |
| Mouse | wheel scrolls the conversation, click selects a chat, a message, or the composer |

Command line (`:`): `:quit`, `:help`, `:address`, `:add <address> [name]`, `:bell on|off`.
Quitting with an unsent draft asks first; drafts and read markers are stored per chat in the profile data directory
(`ui.json`) and restored on the next start.

Many terminals cannot tell `Shift+Enter` from `Enter`, so `Alt+Enter` is the dependable newline.

### One interface per profile

The UI takes a lock on the profile. While it is open, `miga send` and `miga listen` for the same profile refuse to run
with a clear message (a local socket that lets `miga send` talk to the running UI is planned for M3). `miga log`, `contacts`,
`address` and `add` are safe. Use `--profile <name>` for a second account.

## Configuration

`~/.config/miga/config.toml` (or `--config <path>`). The file is optional and is **never written** by the program;
unknown keys are ignored and a broken file falls back to the defaults with a notice in the footer.

```toml
mouse = true
ascii_borders = false          # + - | borders and v/vv ticks for limited terminals
sidebar_width = 28
sidebar_collapse_below = 80    # columns
editor = "default"             # default = $VISUAL, then $EDITOR
open_command = "xdg-open"      # "" = show the link instead
confirm_delete = true
show_receipts = true

[theme]
name = "miga-dark"             # miga-dark | transparent | mono
color = "auto"                 # auto | truecolor | 256 | 16 | none   (NO_COLOR always wins)
# primary = "#1a6bbf"          # also bg, card, secondary, muted, text

[notifications]
bell = true                    # terminal bell on a new message
desktop = false
notify_cmd = "notify-send {title} {body}"   # no shell; {title}/{body} are replaced per argument
show_text = false              # false: generic "New message" so nothing leaks to the lock screen
when_focused = false           # false: no notification for the open chat while the terminal has focus

[keybinds]
default_keybindings = true
[keybinds.history]             # tables: global, list, history, composer
"x" = "reply"                  # action names are listed by `?`; see keys.rs
"r" = ""                       # empty string unbinds
```

Colours: truecolor when `COLORTERM` says so, 256 colours when `TERM` contains `256color`, otherwise the 16 ANSI colours
(messages then use bars instead of filled bubbles). `NO_COLOR` gives a monochrome UI. Emoji and wide characters are measured
with `unicode-width`; terminals disagree on some emoji sequences, so a line with them can be off by a column.

Received text is stripped of control characters and bidi overrides before it is drawn.

## Not in M2 (planned)

Device linking and history pull, backup, attachments (shown as a placeholder), local socket for `miga send`, in-chat search,
per-chat mute, live typing line, QR code popup, translations.
