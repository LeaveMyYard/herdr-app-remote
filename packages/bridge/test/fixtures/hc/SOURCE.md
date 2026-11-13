# hc fixtures

Recorded in the rig (`rig/scenarios/chat.sh`, which writes them to `$RIG/rec`) with the real **hc 0.1.20**, against
terminals running a synthetic script (no real agent output):

| file | command |
|---|---|
| ls-0.1.20.json | `hc ls --json` |
| read-0.1.20.txt | `hc read <t> --lines 200` (stdout is not a TTY: plain text, no ANSI) |
| read-working-0.1.20.txt | `hc read <t> --lines 200` of a working agent: the screen, then hc's own `[hc] only its screen: ...` notice as the last line of stdout (appended by hand: the rig's synthetic terminals are not agents, so hc never prints it there; the text is hc 0.1.20's own, in its binary) |
| read-not-found-0.1.20.json | stderr of `hc read no-such-terminal --lines 200` (exit 3) |

`ls.json` and `ls-without-t3.json` are hand-written in the recorded shape (`{"hidden_finished":N,"terminals":[{"address":…}]}`)
so the tests can name `t3`, `t4` and a remote `vps/t7`. **The remote entry is unverified**: the rig has no second
machine, so nothing shows that `hc ls --json` lists `--on` terminals or spells them `machine/t7` (that form comes from
`hc read --help`: "`t7`, a name, or `machine/t7`"). If it doesn't list them, a remote chat shows "This terminal has
closed" until it does. Before fix/chat-loading-forever they used a guessed shape
(`[{"id":…}]`), which is why the bridge never matched hc 0.1.20's `address` and every chat said `terminal_not_found`.

`read-agent.ansi` and `read-hostile.ansi` are synthetic ANSI for the parser. The `keys-*` and `send-*` files belong to
the terminal input tests (S16, S16b) and are not part of this note.
