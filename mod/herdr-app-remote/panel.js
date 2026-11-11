// The Remote panel's views (design/DesktopRemote.dc.html): Status, Devices, Plugins and Activity, and
// the Setup view (design/DesktopSetup.dc.html) while the bridge is not serving yet, drawn from the
// PanelView the bridge pushes to the `panel` copy (docs/protocol/mod-link-v1.md).
//
// Everything here is plain functions of data: `sanitize` checks what came over the link, `renderPanel`
// builds the element tree and calls back into `on` for every click. Text from the bridge is drawn as
// text only. No Node APIs, no host calls (main.js owns those).
import { div, svg } from 'gpui-kit';
import { h_flex, v_flex } from 'gpui-base';

export const TABS = Object.freeze([
  ['status', 'Status'],
  ['devices', 'Devices'],
  ['plugins', 'Plugins'],
  ['activity', 'Activity'],
]);
/** The choices offered when turning terminal input or special keys on: minutes, or null for no limit. */
export const EXPIRY_CHOICES = Object.freeze([
  { label: '1 hour', minutes: 60 },
  { label: '8 hours', minutes: 480 },
  { label: 'No limit', minutes: null },
]);

const CAPS = Object.freeze([
  ['view', 'View', 'See agents, the inbox and usage'],
  ['inbox.answer', 'Answer questions', 'Answer, draft and dismiss in the inbox'],
  ['navigate', 'Navigate', 'Focus agents, tabs and spaces on this computer'],
  ['terminal.input', 'Terminal input', 'Type text into terminals, then Enter'],
  // S16b: the same switch as terminal input (asks how long, shows "until"). Wording: operator, 2026-11-11.
  ['terminal.keys', 'Special keys', 'Lets this phone press Esc, Ctrl-C and the arrow keys in a terminal.'],
  ['push', 'Notifications', 'Receive push notifications'],
]);

const ID = /^d-[0-9a-f]{16}$/;
/** Switches that ask how long before turning on. */
const EXPIRING = new Set(['terminal.input', 'terminal.keys']);
const STATUS = new Set(['serving', 'paused', 'setup', 'blocked']);
const CHECK = new Set(['ok', 'warn', 'bad', 'off']);
const PLUGIN = new Set(['ready', 'missing', 'too_old', 'broken', 'stale', 'not_running']);

export const SETUP_STEP_IDS = Object.freeze(['installed', 'signed_in', 'https', 'serving', 'phone']);
const STEP_STATE = new Set(['done', 'current', 'todo']);
/** Copies of the protocol enums (the mod can't import TS; a test pins them to bridgeApi). */
export const SETUP_SERVING = Object.freeze(['ours', 'identical', 'off', 'foreign', 'funnel', 'unknown']);
const SERVING = new Set(SETUP_SERVING);
export const SETUP_PROBLEM_CODES = Object.freeze([
  'not_installed', 'too_old', 'daemon_down', 'needs_login', 'stopped', 'tagged', 'magicdns_off', 'https_off',
  'port_taken', 'funnel_on', 'operator', 'serve_disabled', 'not_ours', 'failed', 'unknown', 'no_device',
]);
const PROBLEMS = new Set(SETUP_PROBLEM_CODES);
/** The only pages a setup problem may open: the Tailscale admin (bridge-api SetupProblem.url). */
const ADMIN_PREFIX = 'https://login.tailscale.com/';

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
const list = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);

/** The Setup part of a view, or null. Only known codes and steps; a URL only into the Tailscale admin. */
function sanitizeProblem(p) {
  return p && typeof p === 'object' && PROBLEMS.has(p.code)
    ? {
      code: p.code,
      message: str(p.message, 300),
      fix: typeof p.fix === 'string' && p.fix ? p.fix.slice(0, 200) : null,
      url: typeof p.url === 'string' && p.url.startsWith(ADMIN_PREFIX) && p.url.length <= 300 && !/\s/.test(p.url) ? p.url : null,
    }
    : null;
}

export function sanitizeSetup(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.steps) || raw.steps.length !== 5) return null;
  const steps = [];
  for (let i = 0; i < 5; i += 1) {
    const st = raw.steps[i];
    if (!st || st.id !== SETUP_STEP_IDS[i] || !STEP_STATE.has(st.state)) return null;
    steps.push({ id: st.id, state: st.state, title: str(st.title, 80), detail: str(st.detail, 200), problem: sanitizeProblem(st.problem) });
  }
  const step = Number.isInteger(raw.step) && raw.step >= 1 && raw.step <= 6 ? raw.step : 1;
  return {
    step, steps,
    serving: SERVING.has(raw.serving) ? raw.serving : 'unknown',
    port: Number.isInteger(raw.port) && raw.port > 0 && raw.port < 65536 ? raw.port : null,
    can_start: raw.can_start === true,
    can_stop: raw.can_stop === true,
    busy: raw.busy === true,
    notice: sanitizeProblem(raw.notice),
  };
}

/**
 * Checks a `panel` view from the link and returns a clean copy, or null when it isn't one. The bridge
 * validates its own output; this is the mod's side of the same boundary (the mod does not authenticate
 * the bridge), so nothing odd reaches the layout or an act's arguments.
 */
export function sanitize(raw) {
  if (!raw || typeof raw !== 'object' || !STATUS.has(raw.status)) return null;
  const devices = [];
  for (const d of list(raw.devices, 64)) {
    if (!d || typeof d.id !== 'string' || !ID.test(d.id) || (d.state !== 'pending' && d.state !== 'approved')) continue;
    const caps = {};
    for (const [k] of CAPS) caps[k] = d.caps?.[k] === true;
    devices.push({
      id: d.id, name: str(d.name, 32), login: str(d.login, 120), state: d.state, caps,
      terminal_input_until: num(d.terminal_input_until), terminal_keys_until: num(d.terminal_keys_until), created_at: num(d.created_at) ?? 0,
      last_seen: num(d.last_seen), live: num(d.live) ?? 0,
    });
  }
  const qr = list(raw.pairing?.qr, 200);
  const pairing = raw.pairing && qr.length > 0 && qr.every((r) => typeof r === 'string' && /^[01]{1,200}$/.test(r))
    ? { url: str(raw.pairing.url, 300), expires_at: num(raw.pairing.expires_at) ?? 0, qr }
    : null;
  return {
    status: raw.status,
    url: typeof raw.url === 'string' ? raw.url.slice(0, 300) : null,
    checks: list(raw.checks, 16).filter((c) => c && typeof c.id === 'string').map((c) => ({
      id: str(c.id, 32), label: str(c.label, 80), detail: str(c.detail, 160), state: CHECK.has(c.state) ? c.state : 'off',
    })),
    devices,
    plugins: list(raw.plugins, 16).filter((p) => p && typeof p.id === 'string').map((p) => ({
      id: str(p.id, 32), name: str(p.name, 40), state: PLUGIN.has(p.state) ? p.state : 'broken', powers: str(p.powers, 120), detail: str(p.detail, 160),
    })),
    activity: list(raw.activity, 100).filter((a) => a && num(a.ts) !== null).map((a) => ({ ts: a.ts, text: str(a.text, 200) })),
    pairing,
    setup: sanitizeSetup(raw.setup),
  };
}

// ---- small formatters ----

export const clock = (ms) => new Date(ms).toTimeString().slice(0, 5);

export function ago(ms, now) {
  const min = Math.max(0, Math.round((now - ms) / 60000));
  if (min < 1) return 'now';
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

export function countdown(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export const PLUGIN_TEXT = Object.freeze({
  ready: 'ready', missing: 'not installed', too_old: 'too old: update', broken: 'broken', stale: 'needs a restart', not_running: 'not running',
});

export function deviceState(d, now) {
  if (d.state === 'pending') return 'Waiting for approval';
  if (d.live > 0) return 'Live';
  return d.last_seen ? `Away · ${ago(d.last_seen, now).replace('now', 'just now')}` : 'Never connected';
}

export function capsSummary(d) {
  const on = CAPS.filter(([k]) => d.caps[k]).map(([, label]) => label.toLowerCase());
  return on.length ? `Can: ${on.join(', ')}` : 'Cannot do anything yet';
}

export const ACT_ERRORS = Object.freeze({
  not_found: 'That device is gone.',
  serve_not_configured: 'Tailscale is not set up yet.',
  paused: 'Remote access is paused.',
  no_link: "The bridge isn't connected.",
  link_lost: 'The bridge connection dropped.',
  timeout: "The bridge didn't answer.",
  bad_args: 'The bridge refused that request.',
  unsupported_action: 'The bridge refused that request.',
  no_setup: 'This bridge does not manage Tailscale serve.',
});

/** Kinds whose failures the Setup view already explains in the step itself (the problem box). */
export const SETUP_KINDS = Object.freeze(['setup.check', 'setup.start', 'setup.stop']);

/**
 * The message for a failed panel act, or null when the view already shows why: a Start or Stop refusal
 * with a setup problem code is drawn by the bridge's view itself (the current step's problem, or the
 * notice on the Status tab).
 */
export function actError(kind, code) {
  if ((kind === 'setup.start' || kind === 'setup.stop') && PROBLEMS.has(code)) return null;
  return ACT_ERRORS[code] ?? `That didn't work (${String(code).slice(0, 40)}).`;
}

// ---- colors ----

/** Board colors (design/DesktopRemote.dc.html) as fallbacks for theme keys a theme lacks. */
const FALLBACK = {
  surface: '#17191d', canvas: '#101114', raised: '#2c2e31', border: '#ffffff14', input: '#ffffff24',
  foreground: '#eeeeef', muted: '#98999b', dim: '#696a6d', ansi1: '#e06c75', ansi2: '#a6bd91', ansi3: '#d1bd80',
};

export function palette(theme) {
  const t = theme && typeof theme === 'object' ? theme : {};
  const c = {};
  for (const k of Object.keys(FALLBACK)) c[k] = typeof t[k] === 'string' && t[k] ? t[k] : FALLBACK[k];
  // The board's green and amber are the theme's ansi green and yellow (`done` is blue in the default theme).
  c.ok = c.ansi2;
  c.warn = c.ansi3;
  return c;
}

/** `#rrggbb` plus an alpha byte; anything else is returned as it is. */
export const tint = (color, alpha) => (/^#[0-9a-f]{6}$/i.test(color) ? `${color}${alpha}` : color);

// ---- elements ----

function button(c, id, label, onClick, { primary = false, danger = false, grow = false, height = 24 } = {}) {
  return div().id(id).flex().items_center().justify_center().h(height).px(10).rounded(grow ? 7 : 6).text_size(grow ? 12.5 : 12)
    .when(grow, (e) => e.border(1).border_color(c.input))
    .bg(primary ? c.foreground : c.raised).text_color(primary ? c.surface : danger ? c.ansi1 : c.foreground)
    .when(grow, (e) => e.flex_1())
    .hover((s) => s.bg(primary ? c.muted : c.input))
    .on_click(onClick)
    .child(label);
}

function dot(color) {
  return div().w(7).h(7).rounded(4).bg(color).flex_none();
}

function card(c, children) {
  return v_flex().gap(4).px(12).py(10).rounded(8).bg(tint(c.foreground, '08')).border(1).border_color(c.border).children(children);
}

function checkTile(c, state) {
  const color = { ok: c.ok, warn: c.warn, bad: c.ansi1, off: c.dim }[state];
  // The board's tile: solid, with a dark mark (the check is an icon: a font glyph renders thin).
  const tile = div().w(18).h(18).flex().items_center().justify_center().rounded(5).flex_none().mt(1).bg(color).text_color(c.canvas);
  if (state === 'ok') return tile.child(svg('mods/herdr-app-remote/check.svg').w(12).h(12));
  return tile.text_size(11).font_semibold().child({ warn: '!', bad: '✕', off: '–' }[state]);
}

/** The QR as rows of dark runs on a white square. */
export function qrElement(c, rows) {
  const n = rows.length;
  const px = n <= 34 ? 3 : 2;
  return v_flex().id('qr').flex_none().w(n * px).h(n * px).bg('#ffffff').children(
    rows.map((row, y) => {
      const cells = [];
      for (let x = 0; x < row.length;) {
        let e = x;
        while (e < row.length && row[e] === row[x]) e += 1;
        cells.push(div().w((e - x) * px).h(px).flex_none().bg(row[x] === '1' ? '#000000' : '#ffffff'));
        x = e;
      }
      return h_flex().id(`qr-${y}`).h(px).flex_none().children(cells);
    }),
  );
}

// ---- setup (design/DesktopSetup.dc.html) ----

/** The board's step marks: done (green), current (amber), later (outlined). */
const MARK = Object.freeze({
  done: { bg: '#2c6b4c', fg: '#e3f2e9', border: '#6c967350' },
  current: { bg: '#f2a93b', fg: '#1b1203', border: '#ffb54750' },
});

/** A fixed line under an admin link, by code (never text from the bridge; magicdns_off's message says it). */
const URL_HELP = Object.freeze({
  https_off: 'Turn on MagicDNS and HTTPS Certificates there.',
  serve_disabled: 'Enable Serve for this tailnet there.',
});
/** A fixed line under a fix command: it is only ever shown. */
const fixHelp = (code) => (code === 'needs_login' || code === 'stopped' ? 'Run it in a terminal on this computer.' : 'herdr never runs this for you.');
/** Problems the periodic checks can clear by themselves (the person fixes something elsewhere). */
const RECHECKED = new Set(['not_installed', 'too_old', 'daemon_down', 'needs_login', 'stopped', 'tagged', 'magicdns_off', 'https_off', 'port_taken', 'funnel_on', 'unknown']);

export function adminLabel(url) {
  return /\/admin\/dns\/?$/.test(url) ? 'Open Tailscale admin › DNS' : 'Open Tailscale admin';
}

function problemBox(m, c, p, on, id = `problem-${p.code}`) {
  const help = [
    p.fix ? fixHelp(p.code) : null,
    p.url ? URL_HELP[p.code] : null,
    RECHECKED.has(p.code) ? 'Checking again every 5 s…' : null,
  ].filter(Boolean).join(' ');
  return v_flex().id(id).gap(8).mt(6).px(12).py(10).rounded(8).bg('#252524').border(1).border_color('#4a4334').children([
    div().text_size(12).text_color(c.warn).child(p.message),
    p.fix
      // Shown to copy and run by hand; nothing here ever runs it.
      ? h_flex().id('fix').gap(8).pl(10).pr(6).py(6).rounded(7).bg(c.canvas).border(1).border_color(c.border).children([
        div().id('fix-command').flex_1().min_w(0).font_family('JetBrains Mono').text_size(11.5).child(p.fix),
        button(c, 'fix-copy', m.copied ? 'Copied' : 'Copy', (_e, cx) => on.copy(cx, p.fix)),
      ])
      : div(),
    p.url
      ? div().id('open-admin').flex().items_center().justify_center().h(28).rounded(7).bg(c.foreground).text_color(c.surface)
        .text_size(12).font_medium().hover((s) => s.bg(c.muted))
        .on_click((_e, cx) => on.openUrl(cx, p.url))
        .child(adminLabel(p.url))
      : div(),
    help ? div().text_size(11.5).text_color(c.muted).child(help) : div(),
  ]);
}

function stepRow(m, c, st, i, on) {
  const mark = MARK[st.state];
  const last = i === 4;
  return h_flex().id(`step-${st.id}`).items_start().gap(10).children([
    v_flex().w(20).flex_none().items_center().h_full().children([
      div().id(`mark-${st.id}`).w(20).h(20).flex_none().flex().items_center().justify_center().rounded(5).border(1)
        .bg(mark ? mark.bg : c.surface).border_color(mark ? mark.border : c.input).text_color(mark ? mark.fg : c.muted)
        .text_size(10.5).font_bold()
        .child(st.state === 'done' ? svg('mods/herdr-app-remote/check.svg').w(12).h(12) : String(i + 1)),
      last ? div() : div().w(1.5).flex_1().min_h(12).bg(c.input),
    ]),
    v_flex().flex_1().min_w(0).gap(3).pb(14).children([
      div().font_medium().text_color(st.state === 'todo' ? c.muted : c.foreground).child(st.title),
      div().text_size(12).text_color(c.dim).child(st.detail),
      st.state === 'current' && st.problem && st.problem.code !== 'no_device' ? problemBox(m, c, st.problem, on) : div(),
    ]),
  ]);
}

function setupSteps(m, c, on) {
  return v_flex().id('setup-steps').gap(4).children(m.view.setup.steps.map((st, i) => stepRow(m, c, st, i, on)));
}

/** "Check now" and "Start serving". Labels follow this panel's own act in flight, not the periodic checks. */
function setupButtons(m, c, on) {
  const s = m.view.setup;
  const startable = s.can_start && !m.pendingSetup;
  const start = startable
    ? button(c, 'setup-start', 'Start serving', (_e, cx) => on.act(cx, 'setup.start', {}), { grow: true, height: 30 })
    // Disabled: drawn like the board's, and with no click handler at all.
    : div().id('setup-start').flex().flex_1().items_center().justify_center().h(30).px(12).rounded(7).border(1).border_color(c.input)
      .bg(c.surface).text_color(c.dim).text_size(12.5)
      .child(m.pendingSetup === 'setup.start' ? 'Starting…' : 'Start serving');
  return h_flex().gap(8).w_full().children([
    button(c, 'setup-check', m.pendingSetup === 'setup.check' ? 'Checking…' : 'Check now', (_e, cx) => on.act(cx, 'setup.check', {}), { grow: true, height: 30 }),
    start,
  ]);
}

/** The whole panel on first run (no phone yet, the board): the five steps, Check now and Start serving. */
function setupPanel(m, c, on) {
  const s = m.view.setup;
  const shown = Math.min(s.step, 5);
  const header = v_flex().flex_none().gap(4).px(14).py(12).border_b(1).border_color(c.border).children([
    h_flex().gap(8).children([
      div().flex_1().font_semibold().child('Set up remote access'),
      div().id('step-of').text_size(11).text_color(c.dim).child(`step ${shown} of 5`),
    ]),
    div().text_size(12).text_color(c.muted).child('Use herdr from your phone over your private Tailscale network. Each step is checked by itself.'),
  ]);
  const footer = v_flex().flex_none().border_t(1).border_color(c.border).children([
    m.error ? div().id('error').px(14).pt(8).text_size(11.5).text_color(c.ansi1).child(m.error) : div(),
    h_flex().h(48).px(14).child(setupButtons(m, c, on)),
  ]);
  return v_flex().id('remote-panel').size_full().bg(c.surface).text_color(c.foreground).text_size(13).children([
    header,
    div().flex_1().min_h(0).overflow_y_scrollbar().p(14).child(setupSteps(m, c, on)),
    footer,
  ]);
}

/** The notice of the last Start or Stop while served (bridge `SetupTopic.notice`), e.g. Stop's operator error. */
function setupNotice(m, c, on) {
  const n = m.view.setup?.notice;
  return n ? problemBox(m, c, n, on, 'setup-notice') : div();
}

/** Stop serving on the Status tab: only when this bridge created the handler, and only after a second click. */
function stopServing(m, c, on) {
  const s = m.view.setup;
  if (!s || !s.can_stop) return div();
  if (m.pendingSetup === 'setup.stop') {
    return h_flex().children([
      div().id('stop-serving').flex().items_center().h(24).px(10).rounded(6).text_size(12).bg(c.raised).text_color(c.dim).child('Stopping…'),
    ]);
  }
  if (m.confirmStop) {
    return v_flex().id('stop-confirm').gap(8).px(12).py(10).rounded(8).bg(tint(c.foreground, '08')).border(1).border_color(c.border).children([
      div().text_size(12).child('Stop serving herdr on the tailnet? Phones lose access until you start again.'),
      h_flex().gap(6).children([
        button(c, 'stop-yes', 'Stop serving', (_e, cx) => { on.askStop(cx, false); on.act(cx, 'setup.stop', {}); }, { danger: true }),
        button(c, 'stop-no', 'Cancel', (_e, cx) => on.askStop(cx, false)),
      ]),
    ]);
  }
  return h_flex().children([
    button(c, 'stop-serving', 'Stop serving', (_e, cx) => on.askStop(cx, true), { danger: true }),
  ]);
}

// ---- tabs ----

function statusTab(m, c, on) {
  const { view } = m;
  // Not serving, but phones exist (e.g. after Stop serving): the steps sit here, so Devices (revoke) and
  // Activity stay one click away.
  if (view.status === 'setup' && view.setup) {
    return v_flex().gap(12).children([setupSteps(m, c, on), setupButtons(m, c, on)]);
  }
  const url = view.url;
  return v_flex().gap(16).children([
    v_flex().gap(6).children([
      div().text_size(11.5).text_color(c.dim).child('Open on your phone'),
      h_flex().gap(8).pl(10).pr(6).py(6).rounded(8).bg(tint(c.foreground, '08')).border(1).border_color(c.border).children([
        div().flex_1().truncate().font_family('JetBrains Mono').text_size(11.5).text_color(url ? c.foreground : c.dim).child(url ?? 'Not serving yet'),
        url ? button(c, 'copy-url', m.copied ? 'Copied' : 'Copy', (_e, cx) => on.copy(cx, url)) : div(),
      ]),
    ]),
    ...view.checks.map((k) =>
      h_flex().id(`check-${k.id}`).items_start().gap(10).children([
        checkTile(c, k.state),
        v_flex().gap(1).flex_1().children([
          div().child(k.label),
          k.detail ? div().text_size(11.5).text_color(c.dim).child(k.detail) : div(),
        ]),
      ])),
    setupNotice(m, c, on),
    stopServing(m, c, on),
  ]);
}

function capRow(m, c, d, on, [cap, label, about]) {
  const enabled = d.caps[cap];
  const expiring = EXPIRING.has(cap);
  const asking = expiring && m.expiryFor === d.id && (m.expiryCap ?? 'terminal.input') === cap;
  const at = cap === 'terminal.keys' ? d.terminal_keys_until : d.terminal_input_until;
  const until = expiring && enabled && at ? `until ${clock(at)}` : null;
  // Element ids: terminal input keeps the ones it had (`expiry-<id>…`); special keys add `-keys`.
  const eid = cap === 'terminal.keys' ? `expiry-${d.id}-keys` : `expiry-${d.id}`;
  const toggle = div().id(`cap-${d.id}-${cap}`).w(30).h(16).rounded(8).flex_none().flex().items_center()
    .px(2).bg(enabled ? c.ok : c.raised).justify_end()
    .when(!enabled, (e) => e.justify_start())
    .on_click((_e, cx) => on.toggleCap(cx, d, cap))
    .child(div().w(12).h(12).rounded(6).bg(c.foreground));
  return v_flex().gap(6).children([
    h_flex().gap(8).children([
      v_flex().flex_1().gap(1).children([
        div().text_size(12).child(label),
        about || until ? div().text_size(11).text_color(c.dim).child(about && until ? `${about} · ${until}` : (about || until)) : div(),
      ]),
      toggle,
    ]),
    asking
      ? h_flex().id(eid).gap(6).children([
        div().text_size(11).text_color(c.muted).child('Allow for'),
        ...EXPIRY_CHOICES.map((o) => button(c, `${eid}-${o.minutes ?? 'none'}`, o.label, (_e, cx) => on.setTerminalInput(cx, d, o.minutes, cap), { height: 22 })),
        button(c, `${eid}-cancel`, 'Cancel', (_e, cx) => on.askExpiry(cx, null), { height: 22 }),
      ])
      : div(),
  ]);
}

function deviceCard(m, c, d, on) {
  const live = d.state === 'approved' && d.live > 0;
  const pending = d.state === 'pending';
  const dotColor = pending ? c.warn : live ? c.ok : c.dim;
  const open = m.expanded === d.id && !pending;
  return card(c, [
    h_flex().gap(8).children([
      dot(dotColor),
      div().flex_1().truncate().font_medium().child(d.name),
      div().text_size(11).text_color(pending ? c.warn : live ? c.ok : c.dim).child(deviceState(d, m.now)),
    ]),
    div().text_size(11.5).text_color(c.dim).truncate().child(d.login),
    pending ? div() : div().text_size(11.5).text_color(c.muted).child(capsSummary(d)),
    h_flex().gap(6).mt(4).children(
      pending
        ? [
          button(c, `approve-${d.id}`, 'Approve', (_e, cx) => on.act(cx, 'device.approve', { id: d.id }), { primary: true }),
          button(c, `refuse-${d.id}`, 'Refuse', (_e, cx) => on.act(cx, 'device.revoke', { id: d.id })),
        ]
        : [
          button(c, `settings-${d.id}`, open ? 'Hide access' : 'Access', (_e, cx) => on.expand(cx, open ? null : d.id)),
          button(c, `revoke-${d.id}`, 'Revoke', (_e, cx) => on.act(cx, 'device.revoke', { id: d.id }), { danger: true }),
        ],
    ),
    open ? v_flex().id(`caps-${d.id}`).gap(10).mt(6).pt(8).border_t(1).border_color(c.border).children(CAPS.map((row) => capRow(m, c, d, on, row))) : div(),
  ]);
}

function pairingCard(m, c, on) {
  const p = m.view.pairing;
  if (p && p.expires_at > m.now) {
    return h_flex().gap(12).p(12).mt(6).rounded(8).border(1).border_dashed().border_color(c.input).children([
      qrElement(c, p.qr),
      v_flex().gap(4).flex_1().min_w(0).text_size(12).children([
        div().font_medium().text_size(12.5).child('Add a phone'),
        div().text_color(c.muted).child('Scan with the camera, then Share › Add to Home Screen.'),
        div().text_color(c.dim).text_size(11.5).child(`Expires in ${countdown(p.expires_at - m.now)}`),
        h_flex().gap(6).children([
          button(c, 'pair-copy', m.copied ? 'Copied' : 'Copy link', (_e, cx) => on.copy(cx, p.url), { height: 22 }),
          button(c, 'pair-hide', 'Hide', (_e, cx) => on.act(cx, 'pair.hide', {}), { height: 22 }),
        ]),
      ]),
    ]);
  }
  return h_flex().gap(12).p(12).mt(6).rounded(8).border(1).border_dashed().border_color(c.input).children([
    v_flex().gap(4).flex_1().min_w(0).text_size(12).children([
      div().font_medium().text_size(12.5).child('Add a phone'),
      div().text_color(c.muted).child('Scan with the camera, then Share › Add to Home Screen.'),
      h_flex().mt(2).children([button(c, 'pair-show', 'Show QR code', (_e, cx) => on.act(cx, 'pair.code', {}), { height: 22 })]),
    ]),
  ]);
}

function devicesTab(m, c, on) {
  return v_flex().gap(8).children([
    ...m.view.devices.map((d) => deviceCard(m, c, d, on)),
    m.view.devices.length === 0 ? div().text_size(12).text_color(c.dim).child('No phones yet.') : div(),
    pairingCard(m, c, on),
  ]);
}

function pluginsTab(m, c) {
  return v_flex().gap(8).children([
    ...m.view.plugins.map((p) => {
      const color = p.state === 'ready' ? c.ok : p.state === 'broken' ? c.ansi1 : c.warn;
      return card(c, [
        h_flex().gap(8).children([
          dot(color),
          div().flex_1().truncate().font_medium().child(p.name),
          div().text_size(11.5).text_color(color).child(PLUGIN_TEXT[p.state]),
        ]),
        div().text_size(11.5).text_color(c.dim).child(`Powers: ${p.powers}`),
        p.detail ? div().text_size(11.5).text_color(c.muted).child(p.detail) : div(),
      ]).id(`plugin-${p.id}`);
    }),
    div().text_size(11.5).text_color(c.dim).child('Agents (basic) and Chat need only herdr-app.'),
  ]);
}

function activityTab(m, c) {
  if (m.view.activity.length === 0) return div().text_size(12).text_color(c.dim).child('Nothing yet.');
  return v_flex().gap(8).children(m.view.activity.map((a, i) =>
    h_flex().id(`act-${i}`).items_start().gap(8).text_size(12).children([
      div().w(44).flex_none().font_family('JetBrains Mono').text_size(11).text_color(c.dim).child(clock(a.ts)),
      div().flex_1().child(a.text),
    ])));
}

const BADGE = Object.freeze({
  serving: ['Serving', 'ok'], paused: ['Paused', 'warn'], setup: ['Set up needed', 'dim'], blocked: ['Blocked', 'ansi1'],
});

/**
 * The Setup view (the board) replaces the tabs on first run: setup runs, nothing is served (not paused or
 * blocked either), and no phone is known yet. With phones, the steps sit in the Status tab instead.
 */
export const showsSetup = (view) => Boolean(view && view.status === 'setup' && view.setup && view.devices.length === 0);

/**
 * The whole panel. `m`: {view|null, tab, expanded, expiryFor, expiryCap, copied, error, connected, now, theme,
 *   confirmStop, pendingSetup (the setup.* kind in flight, or null)}.
 * `on`: act(cx, kind, args), setTab(cx, id), expand(cx, id|null), askExpiry(cx, id|null),
 *       toggleCap(cx, device, cap), setTerminalInput(cx, device, minutes|null, cap?), copy(cx, text),
 *       openUrl(cx, url), askStop(cx, bool).
 */
export function renderPanel(m, on) {
  const c = palette(m.theme);
  const view = m.view;
  const header = h_flex().h(42).px(14).gap(8).flex_none().border_b(1).border_color(c.border).children([
    div().flex_1().font_semibold().child('Remote'),
    view
      ? h_flex().id('badge').h(18).px(7).gap(4).rounded(5).text_size(10).font_semibold()
        .bg(tint(c[BADGE[view.status][1]], '26')).border(1).border_color(tint(c[BADGE[view.status][1]], '55')).text_color(c[BADGE[view.status][1]])
        .child(BADGE[view.status][0])
      : div(),
  ]);
  const root = v_flex().id('remote-panel').size_full().bg(c.surface).text_color(c.foreground).text_size(13);
  if (!view) {
    return root.child(header).child(
      div().flex_1().p(14).text_size(12).text_color(c.dim)
        .child(m.connected ? 'Waiting for the bridge…' : 'The bridge is not running. It starts with the Remote layout.'),
    );
  }
  if (showsSetup(view)) return setupPanel(m, c, on);
  const pendingCount = view.devices.filter((d) => d.state === 'pending').length;
  const label = (id, name) => (id === 'devices' && view.devices.length ? `${name} ${view.devices.length}` : name);
  const tabs = h_flex().id('tabs').mx(14).mt(10).p(2).gap(2).rounded(7).bg(c.canvas).flex_none().children(
    TABS.map(([id, name]) => {
      const sel = m.tab === id;
      return div().id(`tab-${id}`).flex_1().h(22).flex().items_center().justify_center().rounded(5).text_size(12)
        .bg(sel ? c.raised : c.canvas).border(1).border_color(sel ? c.border : c.canvas)
        .text_color(sel ? c.foreground : id === 'devices' && pendingCount ? c.warn : c.muted)
        .on_click((_e, cx) => on.setTab(cx, id))
        .child(label(id, name));
    }),
  );
  const body = { status: statusTab, devices: devicesTab, plugins: pluginsTab, activity: activityTab }[m.tab] ?? statusTab;
  const paused = view.status === 'paused';
  const footer = v_flex().flex_none().border_t(1).border_color(c.border).children([
    m.error ? div().id('error').px(14).pt(8).text_size(11.5).text_color(c.ansi1).child(m.error) : div(),
    h_flex().h(48).px(14).children([
      button(c, paused ? 'resume' : 'pause', paused ? 'Resume remote access' : 'Pause remote access',
        (_e, cx) => on.act(cx, paused ? 'remote.resume' : 'remote.pause', {}), { grow: true, height: 30, primary: paused }),
    ]),
  ]);
  return root.child(header).child(tabs).child(
    div().id('body').flex_1().min_h(0).overflow_y_scrollbar().p(14).child(body(m, c, on)),
  ).child(footer);
}
