# Recipe: testing and verifying

Two parts: the isolated rig, which checks everything that can be checked without your real herdr-app, and the manual checks that need a real tailnet and an iPhone. The second part lists what is still open.

## 1. The rig

The rig starts an isolated herdr-app and runs one scenario against it. It is the only place a test may run `herdr-app` or `hc`. Never point it at your live app home.

What it sets up (`rig/run.sh`):

- a private `HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, `XDG_RUNTIME_DIR` and `HERDR_APP_HOME`, and a unique `HC_SESSION`;
- bwrap with `/run/user`, the live `~/.config/herdr-app` and tailscaled's socket directory hidden, its own pid and net namespaces, and a fresh `/proc`;
- a fake `tailscale` CLI that replays recorded outputs and keeps its serve config inside the rig, so the real one is unreachable;
- a headless mutter display.

It aborts if the scratch directory is under `/run/user` or inside the live app home, and when a needed tool is missing.

### Prerequisites

`bwrap`, `mutter`, `dbus-run-session`, `herdr-app`, `hc` and `node` on the PATH (Linux; the rig does not run on macOS). Then build once:

```
pnpm install && pnpm -r build
```

### Run a scenario

```
sh rig/run.sh <scenario> <scratch dir> [seconds]
# for example
sh rig/run.sh install "$HOME/rig-scratch/install" 90
```

Use a scratch directory outside the repo and outside `/run/user` and the live app home. Each run makes `rig-<time>-<pid>` under it and prints its path; logs and screenshots are inside. The exit code is 0 only if every assertion passed. Run one scenario at a time, and clean the scratch directory by hand when you are done (name it exactly, no wildcards in shared directories).

### Scenarios

| scenario | what it proves |
|---|---|
| `isolation` | the sandbox itself: private dirs, `/run/user` hidden, own pid and net namespaces, the socket inside the rig |
| `host` | a space appears, a layout switch keeps a mod alive, the mod mirrors host data, commands come back (`space.select`, `tab.select`) |
| `link` | the real link mod against the bridge's link server: hello, a host snapshot, an allowlisted run, a refused run |
| `install` | a clean install into the rig's app home, the derived layout starts one verified bridge under flock, a layout switch reconnects to it, uninstall refuses while the layout is shown and works after, the bridge idles out when the app is gone, shipped layouts unchanged |
| `panel` | the Remote panel against the real bridge pieces with fake devices, plugins and activity; `herdr-app check` passes; a screenshot per tab for the side-by-side with `design/DesktopRemote.dc.html` |
| `setup-panel` | the panel's Setup view against the fake `tailscale`: Start and Stop serving through the panel channel, the operator-error fix command, activity codes only |
| `pairing` | Tailscale setup and serve control against the fake CLI, then a phone (Playwright) through a stand-in for serve that injects `Tailscale-User-Login`: Host spoof, missing identity and wrong login refused, pairing, approval, the host snapshot, Funnel refusal, Stop serving leaves other handlers alone |
| `inbox-answer` | an inbox answer through a stub launcher (never the real binary), unknown-effect and capability cases, the audit lines |
| `terminal-input` | `terminal.send` through the rig's own `hc`: capability refusal, round trip, `--force` typed as text, Enter alone, refusals, rate limit, expiry, audit lines, and a check that `hc send` has not grown options |

The rig is required before merging any safety-critical change (`docs/PLAN.md` section 5). It is not in CI, since it needs herdr-app, hc, bwrap and mutter.

### Other gates

```
pnpm verify                         # typecheck, lint, build, test (unit, contract, mod, installer)
pnpm --filter @herdr-remote/pwa visual   # Playwright visual tests against design/refs
```

CI runs the same two groups (`check` and `visual`, the latter in the Playwright container whose tag must equal the `@playwright/test` version).

## 2. Verify on a real tailnet and iPhone

Do this once before relying on it, on a machine where you accept the risk, and only after the rig is green. The rig uses a fake `tailscale` and a stand-in for serve, so the real serve and the real iPhone are checked here.

1. Build, then install into your real app home as in the README, with the herdr-app you actually use. Nothing is selected for you.
2. Switch to `herdr-remote`. Confirm the Remote panel appears and `herdr-app check` still passes for the layout.
3. In the panel, work through Setup. Press Start serving. Then run `tailscale serve status --json` and confirm the handler matches what the bridge expects (see "Open checks").
4. On the iPhone (Tailscale app on), open the serve URL's `/pair` link from the panel's QR with the Camera. Approve the phone on the desktop.
5. Read through each tab. Check the Agents list against herdr-app, the inbox against herdr-inbox, Usage against the agent-usage panel.
6. Turn on `navigate` for the phone, tap an agent, and watch herdr-app focus it. Turn it off again and confirm the next tap is refused.
7. Turn on `terminal.input` for one hour, type a harmless line into a scratch terminal, and check the Activity tab shows only the length ("sent 12 chars to t3"), never the text. Check the phone shows the expiry and the permission goes away on time.
8. Revoke the phone in the panel and confirm the phone is cut off at once.
9. From a second tailnet device (a laptop), try the serve URL directly: without pairing it must not show data. Try `curl` with a wrong `Host` against `127.0.0.1:47391`: it must answer `403`.
10. Optionally turn Funnel on for the port (`tailscale funnel`), confirm every request answers `503 funnel`, then turn it off. Never leave Funnel on.
11. Stop serving in the panel, switch to another layout, and uninstall. Confirm `tailscale serve status` shows no handler of ours.

Use a throwaway phone name and scratch terminals; do not put real secrets into a terminal while testing.

## 3. Open checks

These could not be verified inside the rig and are still open. Tick them off here as they are done.

- [ ] **Serve handler shape.** Check once on a real tailnet that `tailscale serve --bg` writes the handler the exact-handler check expects. If not, Start serving fails safe (reported as `failed`) rather than claiming a config it cannot prove.
- [ ] **Identity headers.** The exact set Tailscale adds on serve, their absence for tagged nodes, and a request from another user on the same tailnet.
- [ ] **A real iPhone, end to end.** Pairing, approval, the Home Screen install, and storage: the Home Screen app's storage is separate from Safari's.
- [ ] **Push on a real iPhone** (iOS 16.4 or newer): permission from a tap inside the Home Screen app, a delivered notification for a new question, a blocked agent and an alert, a tap opening the right screen, and a lapsed subscription. Push has no rig scenario; it is tested against a loopback fake push service only.
- [ ] **Pairing transfer (S5b).** OPEN, not verified on a real iPhone. Whether Safari re-reads the manifest after the code is minted and keeps the `start_url` fragment (`/pair#t=`) on "Add to Home Screen"; if not, the Home Screen app opens unpaired and pairing must be repeated from Safari. Also confirm the Home Screen app gets a second token for the same device (Safari's keeps working, revoke removes both), and that a spent or expired code shows the "Each Home Screen setup works once, within 10 minutes." wording. Record the result here.
- [ ] **Special keys (S16b).** Each default key in the Keys sheet on a real iPhone against a real terminal, the typing-time lines, and the "Special keys" desktop switch. The rig has pressed every allowed token through the real `hc keys` (scenario terminal-keys); the phone has not.
- [ ] **`hc send` against a program on a dialog.** The `blocked` refusal kind was read from `hc schema` and has not been seen in the rig.
- [ ] **`hc events`** against a live core (chat polls once a second until then).
- [ ] **The 1 px link block.** Visual artifacts in the real app, starting reliably, and starting never in a layout opened with that column hidden.
- [ ] **CPU cost** of the mod's `render()` mirroring with a large number of terminals.
- [ ] **macOS.** The bridge's single-instance guard uses `flock` where it exists; stock macOS has none and relies on a narrower check. Install and run once on macOS.
- [ ] **Plugin freshness.** panorama's rich data is fresh only while its sidebar runs; confirm the phone falls back to Basic Agents otherwise.
- [ ] **Release script.** Run `scripts/release.sh <version>` on a clean checkout and confirm the printed hash equals the one `app-install` records (see CHANGELOG).
