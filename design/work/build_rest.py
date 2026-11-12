from common import T, DOCK, SURFACE, STATES, page, badge, tile, harness, spinner, icon, mix
import desktop as D

NOSCRIPT = 'class Component extends DCLogic {\n  renderVals() { return {}; }\n}'
MONO = "'JetBrains Mono',ui-monospace,monospace"


def esc(s):
    return s.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')


# ---------------- desktop ----------------
TERM = '''● I split the parser into three passes and kept the old entry point as a thin wrapper.

  ⎿ src/parse/mod.rs      +84 −212
  ⎿ src/parse/tokens.rs   +131
  ⎿ tests/parse.rs        +46

● Tests pass: 212 passed, 0 failed.

● I need one decision before the next step, so I asked it in the inbox: <span style="color:#e5c07b">Q123 · Question Title 123</span>

<span style="color:#98999b">✻ Waiting for your answer · 3 shells running</span>'''


def term_pane(focused=True):
    body = (f'<div class="mono f1" style="min-height:0;padding:12px 14px;font-size:13px;line-height:1.5;color:{T["foreground"]};white-space:pre-wrap">{TERM}</div>'
            f'<div class="mono nf" style="margin:0 14px 14px;padding:8px 0;border-top:1px solid #ffffff24;border-bottom:1px solid #ffffff24;font-size:13px;color:{T["muted"]}">❯ <span style="color:{T["foreground"]}">▌</span></div>')
    return D.pane(D.term_header('Agent 1 · Parser rewrite', '~/code/alpha', 'working'), body, focused)


def remote_dot(color, text):
    return f'<span class="row" style="gap:6px;margin-right:16px"><span style="width:6px;height:6px;border-radius:3px;background:{color}"></span>{text}</span>'


SIDE_DOCKED = None


def side_docked():
    return D.sidebar(D.SPACES, D.groups(docked='a1'), totals='<span>?1</span>')


PANEL = lambda inner: f'<section class="col" style="height:100%;border-radius:10px;overflow:hidden;background:{T["background"]};border:1px solid {T["border"]};font-size:13px">{inner}</section>'
BTN = f'height:30px;padding:0 12px;border-radius:7px;border:1px solid {T["input"]};background:{T["raised"]};font-size:12.5px;color:{T["foreground"]}'
CARD = f'border-radius:8px;background:#ffffff08;border:1px solid {T["border"]}'


def remote_panel():
    seg = (f'<button role="tab" aria-selected="{{{{t.selected}}}}" onClick="{{{{t.pick}}}}" class="row f1" style="justify-content:center;height:22px;padding:0 8px;border-radius:5px;font-size:12px;'
           f'background:{{{{t.bg}}}};border:1px solid {{{{t.bd}}}};color:{{{{t.fg}}}}">{{{{t.label}}}}</button>')
    ok = tile('done', 18)
    inner = f'''
<div class="row nf" style="height:42px;padding:0 14px;gap:8px;border-bottom:1px solid {T["border"]}"><span class="f1" style="font-weight:600">Remote</span>{badge('done', 'Serving')}</div>
<div role="tablist" aria-label="Remote sections" class="row nf" style="margin:10px 14px 0;padding:2px;gap:2px;border-radius:7px;background:{T["chrome"]}">
<sc-for list="{{{{tabs}}}}" as="t" hint-placeholder-count="4">{seg}</sc-for></div>
<div class="col f1" style="min-height:0;overflow:hidden;padding:14px">
<sc-if value="{{{{show.status}}}}" hint-placeholder-val="{{{{ true }}}}">
 <div class="col" style="gap:16px">
  <div class="col" style="gap:6px"><span style="font-size:11.5px;color:{T["dim"]}">Open on your phone</span>
   <div class="row" style="gap:8px;padding:6px 6px 6px 10px;{CARD}"><span class="mono f1 tr" style="font-size:11.5px">https://desk-1.example-tailnet.ts.net</span>
   <button style="height:24px;padding:0 9px;border-radius:6px;background:{T["raised"]};font-size:11.5px">Copy</button></div></div>
  <sc-for list="{{{{checks}}}}" as="c" hint-placeholder-count="4">
   <div class="row" style="align-items:flex-start;gap:10px">{ok}<span class="col" style="gap:1px;line-height:1.4"><span>{{{{c.label}}}}</span><span style="font-size:11.5px;color:{T["dim"]}">{{{{c.detail}}}}</span></span></div>
  </sc-for></div></sc-if>
<sc-if value="{{{{show.devices}}}}" hint-placeholder-val="{{{{ false }}}}">
 <div class="col" style="gap:8px">
  <sc-for list="{{{{devices}}}}" as="d" hint-placeholder-count="2">
   <div class="col" style="gap:4px;padding:10px 12px;line-height:1.4;{CARD}">
    <div class="row" style="gap:8px"><span style="width:7px;height:7px;border-radius:4px;background:{{{{d.dot}}}}"></span><span class="f1" style="font-weight:500">{{{{d.name}}}}</span><span style="font-size:11px;color:{{{{d.stateColor}}}}">{{{{d.state}}}}</span></div>
    <div style="font-size:11.5px;color:{T["dim"]}">{{{{d.meta}}}}</div><div style="font-size:11.5px;color:{T["muted"]}">{{{{d.view}}}}</div></div>
  </sc-for>
  <div class="row" style="gap:12px;padding:12px;margin-top:6px;border-radius:8px;border:1px dashed {T["input"]}">
   <div role="img" aria-label="QR code for the web app link" class="row nf" style="width:76px;height:76px;justify-content:center;border-radius:6px;background:{T["foreground"]};color:{T["solid_fg"]};font-size:10px">QR code</div>
   <div class="col" style="gap:4px;font-size:12px;line-height:1.4"><span style="font-weight:500;font-size:12.5px">Add a phone</span><span style="color:{T["muted"]}">Scan with the camera, then Share › Add to Home Screen.</span></div></div>
 </div></sc-if>
<sc-if value="{{{{show.plugins}}}}" hint-placeholder-val="{{{{ false }}}}">
 <div class="col" style="gap:8px">
  <sc-for list="{{{{plugins}}}}" as="p" hint-placeholder-count="3">
   <div class="col" style="gap:3px;padding:10px 12px;line-height:1.4;{CARD}">
    <div class="row" style="gap:8px"><span style="width:7px;height:7px;border-radius:4px;background:{{{{p.dot}}}}"></span><span class="f1" style="font-weight:500">{{{{p.name}}}}</span><span style="font-size:11.5px;color:{{{{p.color}}}}">{{{{p.state}}}}</span></div>
    <div style="font-size:11.5px;color:{T["dim"]}">Powers: {{{{p.tabs}}}}</div></div>
  </sc-for>
  <div style="font-size:11.5px;color:{T["dim"]}">Agents (basic) and Chat need only herdr-app.</div></div></sc-if>
<sc-if value="{{{{show.activity}}}}" hint-placeholder-val="{{{{ false }}}}">
 <div class="col" style="gap:8px">
  <sc-for list="{{{{log}}}}" as="l" hint-placeholder-count="5">
   <div class="row" style="gap:8px;font-size:12px"><span class="mono nf" style="width:44px;font-size:11px;color:{T["dim"]}">{{{{l.t}}}}</span><span>{{{{l.text}}}}</span></div>
  </sc-for></div></sc-if>
</div>
<div class="row nf" style="height:48px;padding:0 14px;border-top:1px solid {T["border"]}"><button class="f1" style="{BTN}">Pause remote access</button></div>'''
    return PANEL(inner)


REMOTE_SCRIPT = f'''class Component extends DCLogic {{
  constructor(props) {{ super(props); this.state = {{ tab: 'status' }}; }}
  renderVals() {{
    const cur = this.state.tab;
    const names = [['status', 'Status'], ['devices', 'Devices 2'], ['plugins', 'Plugins'], ['activity', 'Activity']];
    const ok = '{T["ansi2"]}', warn = '{T["ansi3"]}', dim = '{T["dim"]}';
    return {{
      tabs: names.map(([id, label]) => ({{ label, selected: String(cur === id), bg: cur === id ? '{T["raised"]}' : '{T["chrome"]}', bd: cur === id ? '{T["border"]}' : '{T["chrome"]}', fg: cur === id ? '{T["foreground"]}' : '{T["muted"]}', pick: () => this.setState({{ tab: id }}) }})),
      show: {{ status: cur === 'status', devices: cur === 'devices', plugins: cur === 'plugins', activity: cur === 'activity' }},
      checks: [
        {{ label: 'Tailscale connected', detail: 'example-tailnet · desk-1 · 100.64.0.10' }},
        {{ label: 'HTTPS certificate', detail: 'valid for 61 days, renews by itself' }},
        {{ label: 'Serving on the tailnet', detail: 'tailscale serve · port 443 → bridge' }},
        {{ label: 'Bridge running', detail: 'up 2h 14m · push on' }}
      ],
      devices: [
        {{ name: 'Phone 1', state: 'Live', stateColor: ok, dot: ok, meta: 'iOS · Home Screen app · user-1@example', view: 'Viewing Inbox · Q123' }},
        {{ name: 'Laptop 1', state: 'Away · 3h', stateColor: dim, dot: dim, meta: 'Safari · user-1@example', view: 'Push on' }}
      ],
      plugins: [
        {{ name: 'herdr-panorama', tabs: 'Agents (rich), Swarm, Peek', state: 'ready', color: ok, dot: ok }},
        {{ name: 'herdr-inbox', tabs: 'Inbox', state: 'ready', color: ok, dot: ok }},
        {{ name: 'agent-usage', tabs: 'Usage', state: 'too old: update', color: warn, dot: warn }}
      ],
      log: [
        {{ t: '20:41', text: 'Phone 1 answered Q119 (Option B)' }},
        {{ t: '20:37', text: 'Push sent to Phone 1: group 123' }},
        {{ t: '20:12', text: 'Phone 1 connected' }},
        {{ t: '19:02', text: 'Laptop 1 disconnected' }},
        {{ t: '18:27', text: 'Bridge started' }}
      ]
    }};
  }}
}}'''


def desktop_remote():
    body = D.frame(side_docked(), D.tabbar(D.TABS_AGENT1, 'remote', T['ansi2']), term_pane(), remote_panel(),
                   D.statusbar('main', 7, right=remote_dot(T['ansi2'], 'Remote · 1 phone live')))
    return page('Desktop remote panel', (1440, 900), body, REMOTE_SCRIPT)


def setup_panel():
    inner = f'''
<div class="col nf" style="padding:12px 14px;gap:4px;border-bottom:1px solid {T["border"]};line-height:1.4">
 <div class="row" style="gap:8px"><span class="f1" style="font-weight:600">Set up remote access</span><span style="font-size:11px;color:{T["dim"]}">step 3 of 5</span></div>
 <span style="font-size:12px;color:{T["muted"]}">Use herdr from your phone over your private Tailscale network. Each step is checked by itself.</span></div>
<div class="col f1" style="min-height:0;overflow:hidden;padding:14px;gap:4px">
<sc-for list="{{{{steps}}}}" as="s" hint-placeholder-count="5">
 <div class="row" style="align-items:stretch;gap:10px">
  <div class="col nf" style="width:20px;align-items:center">
   <span class="row nf" style="width:20px;height:20px;border-radius:5px;justify-content:center;font-size:10.5px;font-weight:700;background:{{{{s.markBg}}}};color:{{{{s.markFg}}}};border:1px solid {{{{s.markBorder}}}}">{{{{s.mark}}}}</span>
   <span style="width:1.5px;flex:1;min-height:12px;background:{T["input"]}"></span></div>
  <div class="col f1" style="padding-bottom:14px;gap:3px;line-height:1.4">
   <span style="font-weight:500;color:{{{{s.titleColor}}}}">{{{{s.title}}}}</span>
   <span style="font-size:12px;color:{T["dim"]}">{{{{s.detail}}}}</span>
   <sc-if value="{{{{s.current}}}}" hint-placeholder-val="{{{{ false }}}}">
    <div class="col" style="gap:8px;margin-top:6px;padding:10px 12px;border-radius:8px;background:{mix(T["working"], .07)};border:1px solid {mix(T["working"], .25)}">
     <span style="font-size:12px;color:{T["working"]}">HTTPS certificates are off for this tailnet. The phone app needs them to install and get notifications.</span>
     <button style="height:28px;border-radius:7px;background:{T["solid"]};color:{T["solid_fg"]};font-size:12px;font-weight:500">Open Tailscale admin › DNS</button>
     <span style="font-size:11.5px;color:{T["muted"]}">Turn on MagicDNS and HTTPS Certificates there. Checking again every 5 s…</span></div>
   </sc-if></div></div>
</sc-for></div>
<div class="row nf" style="height:48px;padding:0 14px;gap:8px;border-top:1px solid {T["border"]}">
 <button class="f1" style="{BTN}">Check now</button>
 <button disabled class="f1" style="{BTN};color:{T["dim"]};background:{T["background"]};cursor:default">Start serving</button></div>'''
    return PANEL(inner)


SETUP_SCRIPT = f'''class Component extends DCLogic {{
  renderVals() {{
    const done = {{ mark: '✓', markBg: '#2c6b4c', markFg: '#e3f2e9', markBorder: '#6c967350', titleColor: '{T["foreground"]}', current: false }};
    const now = {{ mark: '3', markBg: '#f2a93b', markFg: '#1b1203', markBorder: '#ffb54750', titleColor: '{T["foreground"]}', current: true }};
    const later = {{ markBg: 'transparent', markFg: '{T["muted"]}', markBorder: '{T["input"]}', titleColor: '{T["muted"]}', current: false }};
    return {{
      steps: [
        {{ title: 'Tailscale installed', detail: 'Found tailscale 1.x on this computer', ...done }},
        {{ title: 'Signed in to a tailnet', detail: 'example-tailnet · this computer is desk-1', ...done }},
        {{ title: 'HTTPS on the tailnet', detail: 'Needed for the Home Screen app and push', ...now }},
        {{ title: 'Share herdr on the tailnet', detail: 'Runs tailscale serve for the bridge. Only devices on your tailnet can reach it.', mark: '4', ...later }},
        {{ title: 'Add your phone', detail: 'Install Tailscale on the phone and sign in to the same tailnet, then scan the QR code.', mark: '5', ...later }}
      ]
    }};
  }}
}}'''


def desktop_setup():
    body = D.frame(side_docked(), D.tabbar(D.TABS_AGENT1, 'remote', T['working']), term_pane(), setup_panel(),
                   D.statusbar('main', 7, right=remote_dot(T['working'], 'Remote · setup 3/5')))
    return page('Desktop remote setup', (1440, 900), body, SETUP_SCRIPT)


def inbox_option(o_on, n, label, desc):
    a = T['accent']
    return (f'<div class="row" style="align-items:flex-start;gap:8px;padding:9px 12px;border-radius:9px;border:1px solid {a if o_on else T["border"]};background:{T["selected"] if o_on else T["raised"]}">'
            f'<span class="mono nf" style="width:22px;font-size:12px;line-height:1.5;color:{a if o_on else T["muted"]}">{n}</span>'
            f'<span class="col f1" style="gap:2px;line-height:1.4"><span style="font-size:13.5px">{label}</span><span style="font-size:12.5px;color:{T["muted"]}">{desc}</span></span></div>')


def keys(pairs):
    return ''.join(f'<span class="row" style="gap:4px"><span style="color:{T["accent"]}">{k}</span><span>{w}</span></span>' for k, w in pairs)


def inbox_button(label, primary):
    return (f'<span class="row nf" style="height:30px;padding:0 12px;border-radius:7px;font-size:12.5px;border:1px solid {T["solid"] if primary else T["input"]};'
            f'background:{T["solid"] if primary else T["raised"]};color:{T["solid_fg"] if primary else T["foreground"]}">{label}</span>')


OPTS = [('Option A', 'First test choice'), ('Option B', 'Second test choice'), ('Option C', 'Third test choice'),
        ('Something else…', 'Type your own answer.'), ('Chat about this', 'Go to the agent')]


def desktop_inbox():
    a, m = T['accent'], T['muted']
    tabs = (f'<span style="padding:9px 12px;font-size:13px;color:{T["foreground"]};border-bottom:2px solid {a}">Single</span>'
            f'<span style="padding:9px 12px;font-size:13px;color:{T["ansi2"]};border-bottom:2px solid {T["popover"]}">Multi</span>'
            f'<span style="padding:9px 12px;font-size:13px;color:{m};border-bottom:2px solid {T["popover"]}">Free text</span><span class="f1"></span>'
            f'<span class="row nf" style="margin:5px 0;padding:4px 12px;gap:8px;border-radius:7px;border:2px solid {T["solid"]};background:{T["solid"]};color:{T["solid_fg"]}">'
            f'<span style="font-size:13px;font-weight:600">Submit ✓</span><span class="mono" style="font-size:11.5px">1/3 answered</span></span>')
    opts = ''.join(inbox_option(i == 0, i + 1, l, d) for i, (l, d) in enumerate(OPTS))
    dialog = f'''<div role="dialog" aria-label="Inbox" class="col abs" style="left:434px;top:190px;width:860px;height:700px;background:{T["popover"]};border:1px solid {T["border"]};border-radius:10px;box-shadow:0 24px 60px #00000080;overflow:hidden;font-size:13px">
 <div class="col nf" style="padding:18px 22px 12px;gap:6px"><div style="font-size:18px;font-weight:600;line-height:1.3">Question Title 123</div>
  <div class="row mono" style="gap:10px;font-size:11.5px;color:{m}"><span style="color:{a}">Q123</span><span>Agent 1 · Project Alpha</span><span>2m ago</span></div></div>
 <div class="row nf" style="gap:4px;padding:0 22px;border-bottom:1px solid {T["border"]};align-items:center">{tabs}</div>
 <div class="col f1" style="min-height:0;padding:18px 22px;gap:12px">
  <div class="row" style="gap:8px"><span class="mono" style="padding:4px 6px;border-radius:4px;background:{T["surface"]};color:{T["ansi4"]};font-size:10.5px;font-weight:600;line-height:1">SINGLE</span><span class="mono" style="font-size:11.5px;color:{m}">pick one</span></div>
  <div style="font-size:15px">Question Text 345: pick one option.</div>
  <div class="col" style="gap:6px">{opts}</div>
  <div class="row nf" style="min-height:34px;padding:0 12px;border-radius:8px;border:1px solid {T["input"]};color:{T["dim"]}">Add a note for the agent…</div></div>
 <div class="row nf" style="gap:14px;padding:12px 22px;border-top:1px solid {T["border"]};font-size:11.5px;color:{m}">
  <span class="row mono" style="gap:14px">{keys([("1-5", "pick"), ("n", "note"), ("tab", "next question"), ("g", "go to agent"), ("d", "dismiss"), ("esc", "back")])}</span><span class="f1"></span>{inbox_button("Later", False)}{inbox_button("Next ⏎", True)}</div>
</div>'''
    app = D.frame(side_docked(), D.tabbar(D.TABS_AGENT1, 'usage'), term_pane(False), D.usage_panel(D.USAGE_GROUPS), D.statusbar('main', 7))
    overlay = f'<div class="abs" style="inset:0;background:#05060899"></div>'
    body = (f'<div class="hd rel" style="width:1440px;height:900px;overflow:hidden">{app}<div class="abs" style="inset:0;background:#05060899"></div>'
            f'<div class="abs" style="left:0;top:0;width:1728px;height:1080px;zoom:0.833333">{dialog}</div></div>')
    return page('Desktop inbox dialog', (1440, 900), body, NOSCRIPT)


# ---------------- phone ----------------
PH_CSS = '''
.ph{width:390px;height:844px;display:flex;flex-direction:column;background:#101114;overflow:hidden;font-size:14px;line-height:1.4}
.z{zoom:1.2}
.ph .srow{height:37px!important}
.ph .sblock{height:auto!important}
.ph .gbtn{height:37px;padding:0 12px}
.ph .gacts{height:auto;padding:4px 0 10px;gap:6px}
.ph .useg{height:30px!important;padding:0 10px!important}
.ph .ubtn{height:37px!important}
.ph .ufseg{height:30px!important;padding:0 9px!important}
.ph .uhead{height:50px!important}
.ph .ufoot{height:50px!important}
.ph .upanel{border:0!important;border-radius:0!important;background:#101114!important}
.ph .uhead *{white-space:nowrap;flex-shrink:0}
.ph .uhead .f1{flex-shrink:1}
.flow{position:relative!important;width:auto!important;top:auto!important}
'''


def nav(active, inbox=2):
    items = [('PhoneAgents', 'Agents', '<rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/>'),
             ('PhoneSwarm', 'Swarm', '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="12" cy="18" r="2.5"/><path d="M7.5 8l3.5 8M16.5 8L13 16"/>'),
             ('PhoneInbox', 'Inbox', '<path d="M3 13l3-8h12l3 8v6H3z"/><path d="M3 13h5l1 2h6l1-2h5"/>'),
             ('PhoneChat', 'Chat', '<path d="M4 5h16v11H9l-5 4z"/>'),
             ('PhoneUsage', 'Usage', '<path d="M5 20V10M12 20V4M19 20v-7"/>')]
    out = ''
    for f, label, path in items:
        c = T['foreground'] if label == active else T['muted']
        b = (f'<span class="row" style="position:absolute;top:3px;left:54%;min-width:18px;height:18px;padding:0 4px;border-radius:5px;justify-content:center;'
             f'background:#f2a93b;border:1px solid #ffb54750;color:#1b1203;font-size:11px;font-weight:700;line-height:1">?{inbox}</span>') if label == 'Inbox' and inbox else ''
        out += (f'<a href="{f}.dc.html" class="col" style="flex:1;height:50px;align-items:center;justify-content:center;gap:3px;font-size:11px;color:{c};position:relative">'
                f'<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">{path}</svg>{label}{b}</a>')
    return f'<nav aria-label="Sections" class="row nf" style="padding:8px 8px 30px;background:{T["chrome"]};border-top:1px solid {T["border"]}">{out}</nav>'


def ph_page(title, inner, script=NOSCRIPT, css=''):
    return page(title, (390, 844), f'<div class="hd ph">{inner}</div>', script, PH_CSS + css)


def ph_brand():
    return (f'<header class="row nf" style="padding:50px 8px 0 16px;gap:8px;height:94px"><img src="icons/remote.png" alt="" style="width:24px;height:24px;border-radius:6px">'
            f'<span class="f1" style="font-size:17px;font-weight:600">Herdr</span>'
            f'<button aria-label="Search" class="row" style="width:44px;height:44px;justify-content:center;color:{T["muted"]}">{icon("search", 19)}</button></header>')


def phone_agents():
    sp = D.spaces_block(D.SPACES).replace('class="col nf" style="height:143px', 'class="col nf sblock" style="height:143px')
    ag = '<a href="PhoneChat.dc.html" class="col f1" style="min-height:0" title="A card with a live agent opens its Chat; a feed-only root opens the Swarm (PhoneSwarm.dc.html)">' + D.agents_panel(D.groups(), totals='<span>?1</span>') + '</a>'
    inner = ph_brand() + f'<main class="col f1" style="min-height:0;overflow:hidden"><div class="z col" style="width:325px">{sp}{ag}</div></main>' + nav('Agents')
    return ph_page('Phone agents', inner)


def phone_agents_basic():
    # herdr-app's stock agents mod (mods/agents/main.js): rows with the app icon, name, age and the stock status mark
    def mark(st):
        if st == 'working':
            return spinner(12, extra=';margin:0 1px')
        if st == 'blocked':
            return f'<span class="row nf" style="height:18px;padding:0 6px;border-radius:5px;background:{T["blocked"]}26;font-size:10.5px;font-weight:600;color:{T["blocked"]}">Needs you</span>'
        if st == 'idle':
            return f'<span class="nf" style="width:7px;height:7px;margin:0 3px;border-radius:4px;border:1.5px solid {T["idle"]}"></span>'
        return f'<span class="nf" style="width:7px;height:7px;margin:0 3px;border-radius:4px;background:{T["done"]}"></span>'
    rows = lambda items: ''.join(
        f'<a href="PhoneChat.dc.html" class="row" style="height:37px;padding:0 8px;gap:0;border-radius:8px;font-size:12.5px">'
        f'<span style="margin-right:8px;display:flex">{harness(h, 14)}</span><span class="row f1" style="gap:5px"><span class="tr" style="max-width:150px;color:{T["muted"] if st == "idle" else T["foreground"]}">{n}</span>'
        f'<span class="tr f1" style="color:{T["dim"]}">· {tab}</span></span><span style="margin-right:8px;font-size:11px;color:{T["dim"]}">{age}</span>{mark(st)}</a>' for n, tab, h, st, age in items)
    sec = lambda label, n: f'<div class="row" style="height:30px;padding:0 8px;gap:6px;font-size:11px;font-weight:500"><span style="color:{T["dim"]}">{label}</span><span style="color:{T["dim"]}">{n}</span></div>'
    spaces = [dict(s, tiles=[]) for s in D.SPACES]
    sp = D.spaces_block(spaces).replace('class="col nf" style="height:143px', 'class="col nf sblock" style="height:143px')
    head = (f'<div class="row nf" style="height:41px;padding:14px 16px 5px;gap:6px"><span style="font-size:11.5px;font-weight:500;color:{T["dim"]}">Agents</span>'
            f'<span style="font-size:11px;color:{T["foreground"]}">All spaces</span></div>')
    lst = (sec('Project Alpha', 2) + rows([('Agent 1', 'tab 2', 'claude', 'blocked', '26m'), ('Agent 2', 'tab 3', 'claude', 'working', '9m')])
           + sec('Project Beta', 2) + rows([('Agent 3', 'tab 1', 'codex', 'working', '4m'), ('Agent 4', 'tab 3', 'claude', 'done', '1h')]))
    card = (f'<div class="col" style="margin:14px 8px 0;padding:10px 12px;gap:3px;border-radius:8px;border:1px dashed {T["input"]}">'
            f'<span style="font-size:12.5px">Subagent trees and the Swarm view need herdr-panorama</span>'
            f'<span style="font-size:11.5px;color:{T["muted"]}">Install it in herdr-app on desk-1. This list keeps working without it.</span></div>')
    body = f'<div class="col" style="border-top:1px solid {T["border"]}">{head}<div class="col" style="padding:0 8px">{lst}</div>{card}</div>'
    inner = ph_brand() + f'<main class="col f1" style="min-height:0;overflow:hidden"><div class="z col" style="width:325px">{sp}{body}</div></main>' + nav('Agents')
    return ph_page('Phone agents basic', inner)


def back(href):
    return (f'<a href="{href}" aria-label="Back" class="row nf" style="width:44px;height:44px;margin-left:-10px;justify-content:center;color:{T["foreground"]}">'
            f'<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg></a>')


SWARM_TPL = f'''
<sc-for list="{{{{rows}}}}" as="r" hint-placeholder-count="6">
 <div class="row" style="align-items:stretch">
  <sc-for list="{{{{r.guides}}}}" as="g" hint-placeholder-count="0"><span aria-hidden="true" class="tg {{{{g.c}}}}"></span></sc-for>
  <div class="gcard flow f1 s-{{{{r.st}}}} {{{{r.cls}}}}" onClick="{{{{r.toggle}}}}" aria-expanded="{{{{r.ariaExpanded}}}}" style="cursor:pointer;min-height:{{{{r.minh}}}}">
   <sc-if value="{{{{r.sel}}}}" hint-placeholder-val="{{{{ false }}}}"><span class="ring"></span></sc-if>
   <span class="edge"></span>
   <sc-if value="{{{{r.fold}}}}" hint-placeholder-val="{{{{ false }}}}">
    <div class="gfold" style="height:40px"><span class="tile still s-done"><i class="gi"></i></span><span class="l">{{{{r.title}}}}</span></div>
   </sc-if>
   <sc-if value="{{{{r.card}}}}" hint-placeholder-val="{{{{ true }}}}">
    <div class="gbody" style="padding-bottom:{{{{r.pb}}}}">
     <div class="gtop"><img class="hn" src="icons/{{{{r.h}}}}.svg" alt=""><span class="gtitle">{{{{r.title}}}}</span>
      <span class="row nf" style="gap:3px"><sc-if value="{{{{r.q}}}}" hint-placeholder-val="{{{{ false }}}}"><span class="tile t18 wide s-wait">?{{{{r.q}}}}</span></sc-if>
      <span class="badge s-{{{{r.st}}}}"><i class="gi"></i><b class="lead">{{{{r.lead}}}}</b>{{{{r.label}}}}</span></span>
      <span class="nf" style="width:12px;text-align:center;font-size:12px;line-height:1;color:{T["muted"]}">{{{{r.caret}}}}</span></div>
     <sc-if value="{{{{r.line}}}}" hint-placeholder-val="{{{{ true }}}}">
      <div class="gline"><span class="gact">{{{{r.act}}}}</span><span class="gright">{{{{r.right}}}}</span></div>
     </sc-if>
     <sc-if value="{{{{r.sel}}}}" hint-placeholder-val="{{{{ false }}}}">
      <div class="gdet"><div class="gd"><span class="k">agent</span><span class="v">{{{{r.agentLine}}}}</span></div><div class="gd"><span class="k">now</span><span class="v">{{{{r.now}}}}</span></div></div>
      <div class="gacts"><a href="PhonePeek.dc.html" class="gbtn pri">Peek ⏎</a><a href="PhonePeek.dc.html" class="gbtn">Transcript t</a><span class="gbtn {{{{r.answerCls}}}}">Answer a</span></div>
     </sc-if>
    </div>
   </sc-if>
   <sc-if value="{{{{r.pulse}}}}" hint-placeholder-val="{{{{ false }}}}"><span class="gpulse"></span></sc-if>
   <sc-if value="{{{{r.sweep}}}}" hint-placeholder-val="{{{{ false }}}}"><span class="gsweep"><i></i></span></sc-if>
  </div>
 </div>
</sc-for>'''

SWARM_SCRIPT = '''class Component extends DCLogic {
  constructor(props) {
    super(props);
    this.state = { open: { a1: true, k2: true }, sel: 'k1' };
  }
  renderVals() {
    const label = { run: 'Running', wait: 'Answer', blk: 'Permission', done: 'Done', idle: 'Idle', rev: 'Review' };
    const tree = [
      { id: 'a1', title: 'Agent 1 · Parser rewrite', st: 'run', q: 1, act: 'running', right: 'tab 2 · <1m', root: true, kids: [
        { id: 'k1', title: 'Explore · token passes', st: 'run', act: 'Read src/parse/tokens.rs', right: 'opus · <1m', agentLine: 'Explore a1b2c3d4e5f6 · opus · <1m · 42 calls', kids: [] },
        { id: 'k2', title: 'Plan · split strategy', st: 'done', act: 'finished', right: 'sonnet · 5m', kids: [
          { id: 'k2a', title: 'Explore · lexer edge cases', st: 'run', act: 'Bash(cargo test lexer::edge…)', right: 'opus · <1m', kids: [
            { id: 'k2a1', fold: true, title: '1 finished · Shell · cargo fmt', st: 'done', kids: [] }
          ] },
          { id: 'k2b', title: 'Explore · old fixtures', st: 'run', act: 'Grep(fixture_*)', right: 'opus · <1m', kids: [] }
        ] },
        { id: 'k3', fold: true, title: '1 finished · Docs · README pass', st: 'done', kids: [] },
        { id: 'k4', title: 'Review · parse/mod.rs', st: 'blk', act: 'needs permission · cargo fmt', right: 'opus · 1m', kids: [] }
      ] },
      { id: 'a2', title: 'Agent 2 · Test cleanup', st: 'run', act: 'running', right: 'tab 3 · 14m', root: true, kids: [] },
      { id: 'a3', title: 'Agent 3 · Docs pass', st: 'idle', act: 'idle', right: 'tab 4 · 14m', root: true, kids: [] }
    ];
    const { open, sel } = this.state;
    const rows = [];
    const onPath = id => id === 'a1';
    const walk = (nodes, depth, trail) => {
      nodes.forEach((n, i) => {
        const last = i === nodes.length - 1;
        const guides = depth ? [...trail.map(more => ({ c: more ? 'pass' : 'blank' })), { c: last ? 'end' : 'tee' }] : [];
        const has = n.kids.length > 0, isOpen = has && open[n.id] === true, selected = n.id === sel;
        const needs = ['wait', 'blk', 'fail'].includes(n.st);
        rows.push({
          st: n.st, title: n.title, act: n.act, right: n.right, h: 'claude', q: n.q || 0,
          label: label[n.st], lead: n.st === 'blk' ? '!' : n.st === 'wait' ? '?' : '',
          fold: !!n.fold, card: !n.fold, sel: selected && !n.fold, line: !(selected && !n.root),
          agentLine: n.agentLine || (n.title + ' · opus · <1m'), now: n.act, answerCls: needs ? '' : 'off',
          cls: (selected ? 'sel' : '') + (onPath(n.id) && !selected ? ' path' : ''),
          caret: has ? (isOpen ? '▾' : '▸') : '', ariaExpanded: has ? String(isOpen) : undefined,
          pulse: needs || (n.root && n.q > 0), sweep: n.st === 'run' && !n.fold,
          guides, minh: n.fold ? '40px' : '54px', pb: selected && !n.root ? '0px' : '9px',
          toggle: () => this.setState({ sel: n.fold ? sel : n.id, open: has ? { ...open, [n.id]: !isOpen } : open })
        });
        if (isOpen) walk(n.kids, depth + 1, depth ? [...trail, !last] : []);
      });
    };
    walk(tree, 0, []);
    return { rows };
  }
}'''


def phone_swarm():
    hdr = (f'<header class="row nf" style="padding:50px 16px 6px;gap:8px">{back("PhoneAgents.dc.html")}'
           f'<div class="z row f1" style="gap:8px;font-size:12px">{D.swarm_header("Project Alpha", 3, 7)}</div></header>')
    main = (f'<main class="col f1" style="min-height:0;overflow:hidden;padding:4px 8px 16px"><div class="z col" style="width:311px;gap:10px;padding:4px 6px">'
            f'{SWARM_TPL}</div></main>')
    return ph_page('Phone swarm tree', hdr + main + nav('Swarm'), SWARM_SCRIPT)


def pk_button(label, key, solid, href):
    return (f'<a href="{href}" class="row f1" style="height:37px;padding:0 10px;gap:5px;border-radius:7px;justify-content:center;font-size:12px;'
            f'background:{T["solid"] if solid else T["raised"]};color:{T["solid_fg"] if solid else T["foreground"]}"><span style="{"font-weight:500" if solid else ""}">{label}</span>'
            f'<span class="mono" style="font-size:11px;opacity:.6">{key}</span></a>')


def phone_peek():
    hue = STATES['blk'][2]
    behind = (f'<div class="abs col" style="inset:0;padding:56px 16px;gap:10px;opacity:.35"><div style="font-size:20px;font-weight:600">Swarm</div>'
              f'<div style="height:64px;border-radius:9px;background:{mix(STATES["run"][2], .055)};border:1px solid {mix(STATES["run"][2], .22)}"></div>'
              f'<div style="height:54px;margin-left:22px;border-radius:9px;background:{mix(hue, .055)};border:1px solid {mix(hue, .22)}"></div></div>'
              f'<div class="abs" style="inset:0;background:#05060899"></div>')
    trans = '''<span style="color:#696a6d">user</span>
Review src/parse/mod.rs for the three-pass split.

<span style="color:#696a6d">assistant</span>
Reading the file. The second pass keeps a copy of the token list it never reads.

<span style="color:#696a6d">tool · Read</span>
src/parse/mod.rs (lines 1-120)

<span style="color:#696a6d">assistant</span>
I want to run cargo fmt before suggesting edits.'''
    peek = f'''
<div class="rel col" style="padding:12px;gap:9px;font-size:12.5px;line-height:1.45">
 <span class="abs" style="left:-1px;top:10px;bottom:10px;width:3px;border-radius:2px;background:{hue}"></span>
 <div class="row" style="gap:7px">{harness("claude")}<span class="tr" style="flex-shrink:1;font-weight:600">Review · parse/mod.rs</span><span class="f1 tr" style="color:{T["dim"]}">opus</span>{badge("blk", h=20)}
  <a href="PhoneSwarm.dc.html" aria-label="Close" class="row nf" style="width:37px;height:37px;margin:-10px -10px -10px 0;justify-content:center;color:{T["dim"]}">{icon("x", 12)}</a></div>
 <div class="col" style="font-size:11.5px;color:{T["dim"]}"><span>Review a9f8e7d6 · opus · 1m · 3 calls</span><span>Subagent of Project Alpha · Agent 1 · Parser rewrite. It has no pane of its own.</span></div>
 <div style="font-size:12px;color:{hue}">Blocked: needs permission to run cargo fmt.</div>
 <div class="col" style="gap:7px"><span style="font-size:11px;color:{T["dim"]}">Last message</span><span style="color:{T["muted"]}">I want to run cargo fmt before suggesting edits.</span></div>
 <div class="row" style="gap:6px">{pk_button("Open root pane", "⏎", True, "PhoneChat.dc.html")}{pk_button("Transcript", "t", False, "PhonePeek.dc.html")}</div>
</div>'''
    viewer = f'''
<div class="col f1" style="min-height:0;margin-top:10px;padding:12px;gap:9px;border-top:1px solid {T["border"]}">
 <div class="row" style="gap:8px"><span style="font-weight:600;font-size:12.5px">Transcript</span><span class="f1" style="font-size:11.5px;color:{T["dim"]}">41–80 / 80</span>
  <button aria-label="Previous page" class="row" style="width:37px;height:37px;justify-content:center;border-radius:7px;background:{T["raised"]};font-size:12px">←</button>
  <button aria-label="Next page" disabled class="row" style="width:37px;height:37px;justify-content:center;border-radius:7px;background:{T["raised"]};font-size:12px;opacity:.4">→</button></div>
 <div class="mono f1" style="min-height:0;overflow:hidden;font-size:11px;line-height:1.55;color:{T["foreground"]};white-space:pre-wrap">{trans}</div>
</div>'''
    sheet = (f'<section aria-label="Peek" class="abs col" style="left:0;right:0;top:110px;bottom:0;background:{T["popover"]};border:1px solid #ffffff1f;border-bottom:0;border-radius:16px 16px 0 0">'
             f'<div class="row nf" style="justify-content:center;padding:8px"><span style="width:36px;height:5px;border-radius:3px;background:{T["input"]}"></span></div>'
             f'<div class="z col f1" style="min-height:0;padding:0 4px 28px">{peek}{viewer}</div></section>')
    return ph_page('Phone peek', f'<div class="rel f1">{behind}{sheet}</div>')


def phone_usage():
    panel = D.usage_panel(D.USAGE_GROUPS)
    inner = (f'<div class="nf" style="height:44px"></div><main class="col f1" style="min-height:0"><div class="z col" style="width:325px;height:100%">{panel}</div></main>' + nav('Usage'))
    return ph_page('Phone agent usage', inner)


def phone_missing():
    plug = lambda n, s, c: f'<div class="row" style="gap:8px;font-size:13px"><span style="width:7px;height:7px;border-radius:4px;background:{c}"></span><span class="f1">{n}</span><span style="font-size:12px;color:{c}">{s}</span></div>'
    head = f'<div class="row nf" style="height:50px;padding:0 14px;border-bottom:1px solid {T["border"]}"><span style="font-weight:600">Agent Usage</span></div>'
    body = f'''
<main class="col f1" style="min-height:0;padding:24px;align-items:center;justify-content:center;gap:14px;text-align:center">
 <div aria-hidden="true" class="row" style="width:64px;height:64px;justify-content:center;border-radius:14px;background:{T["background"]};border:1px solid {T["border"]};color:{T["muted"]}"><svg width="28" height="28" viewBox="0 0 16 16" fill="currentColor"><rect x="2.5" y="8" width="2.5" height="5.5" rx="0.8"/><rect x="6.75" y="2.5" width="2.5" height="11" rx="0.8"/><rect x="11" y="5.5" width="2.5" height="8" rx="0.8"/></svg></div>
 <div style="font-size:17px;font-weight:600">agent-usage isn't installed</div>
 <div style="font-size:14px;color:{T["muted"]};line-height:1.5;max-width:300px">This tab shows how much of each Claude and Codex account is left. It needs the agent-usage plugin in herdr-app on desk-1.</div>
 <div class="col" style="width:100%;gap:6px;text-align:left"><span style="font-size:12px;color:{T["dim"]}">On the computer, run:</span>
  <div class="row" style="gap:8px;padding:6px 6px 6px 12px;border-radius:9px;background:{T["background"]};border:1px solid {T["border"]}"><span class="mono f1" style="font-size:12px">[AGENT-USAGE INSTALL COMMAND]</span>
   <button style="height:44px;padding:0 14px;border-radius:7px;background:{T["raised"]};font-size:13px">Copy</button></div></div>
 <div style="font-size:12.5px;color:{T["dim"]}">The tab turns on by itself once it's installed.</div>
</main>
<div class="col nf" style="margin:0 16px 10px;padding:12px 14px;gap:8px;border-radius:10px;background:{T["background"]};border:1px solid {T["border"]}">
 <span style="font-size:11.5px;color:{T["dim"]}">Plugins on desk-1</span>{plug("herdr-panorama", "ready · 0.4", T["ansi2"])}{plug("herdr-inbox", "ready · 0.10", T["ansi2"])}{plug("agent-usage", "not installed", T["dim"])}</div>'''
    return ph_page('Phone tab without plugin', f'<div class="nf" style="height:44px"></div>{head}{body}{nav("Usage")}')


def phone_chat():
    hue = STATES['wait'][2]
    keyset = ['Esc', 'Tab', '⇧Tab', 'Ctrl-C', '↑', '↓', '⏎', '/']
    hdr = (f'<header class="row nf" style="padding:50px 16px 6px;gap:6px;border-bottom:1px solid {T["border"]}">{back("PhoneAgents.dc.html")}'
           f'<div class="z row f1" style="gap:8px;font-size:12px">{D.term_header("Agent 1 · Parser rewrite", "~/code/alpha", "working")}</div>'
           f'<button aria-label="Fit width" class="mono row nf" style="width:44px;height:44px;justify-content:center;border-radius:9px;background:{T["raised"]};font-size:12px">Aa</button></header>')
    term = TERM.replace('so I asked it in the inbox', 'so I asked it in the inbox').replace('#98999b', T['muted'])
    termhtml = (f'<div class="mono f1" style="min-height:0;overflow:hidden;padding:12px;background:{T["background"]};font-size:11.5px;line-height:1.55;color:{T["foreground"]};white-space:pre-wrap">{term}\n\n'
                f'<span style="color:#ffffff24">────────────────────────────────</span>\n❯ <span style="color:{T["foreground"]}">▌</span>\n<span style="color:#ffffff24">────────────────────────────────</span>\n'
                f'<span style="color:{T["working"]}">⏵⏵ auto mode on</span> <span style="color:{T["muted"]}">· 3 shells</span></div>')
    banner = (f'<a href="PhoneQuestion.dc.html" class="rel row nf" style="margin:8px 12px 0;min-height:44px;padding:0 12px 0 14px;gap:8px;border-radius:8px;background:{mix(hue, .055)};border:1px solid {mix(hue, .22)};font-size:13px">'
              f'<span class="abs" style="left:0;top:0;bottom:0;width:2px;border-radius:7px 0 0 7px;background:{hue}"></span>{tile("wait", 18, 1)}'
              f'<span class="f1">Q123 waits for you</span><span style="color:{hue}">Answer ›</span></a>')
    keys_ = ''.join(f'<button class="nf" style="min-width:44px;height:40px;padding:0 10px;border-radius:7px;border:1px solid {T["border"]};background:{T["raised"]};font-size:12.5px">{k}</button>' for k in keyset)
    comp = (f'<form class="row nf" style="align-items:flex-end;gap:8px;padding:4px 12px 34px">'
            f'<label for="msg" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">Message to the agent</label>'
            f'<textarea id="msg" rows="1" placeholder="Type to the terminal…" style="flex:1;min-height:44px;resize:none;padding:11px 14px;border-radius:10px;border:1px solid {T["input"]};background:{T["background"]};color:{T["foreground"]};font:inherit;font-size:15px"></textarea>'
            f'<button type="button" aria-label="Send" class="row nf" style="width:44px;height:44px;justify-content:center;border-radius:10px;background:{T["solid"]};color:{T["solid_fg"]}">'
            f'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"/></svg></button></form>')
    inner = hdr + termhtml + banner + f'<div role="toolbar" aria-label="Keys" class="mono row nf" style="gap:6px;padding:8px 12px;overflow:hidden">{keys_}</div>' + comp
    return ph_page('Phone chat', inner)


def phone_inbox():
    a, m = T['accent'], T['muted']
    row = lambda sel, n, title, meta, sub, href, extra='', color=T['foreground']: (
        f'<a href="{href}" class="col" style="gap:4px;padding:12px 16px;border-top:1px solid {T["border"]};{"background:" + T["selected"] if sel else ""}">'
        f'<span class="row" style="gap:8px;font-size:15px;color:{color}"><span class="mono nf" style="width:12px;font-size:12px;color:{a}">{"❯" if sel else ""}</span>'
        f'<span class="mono nf" style="font-size:12px;color:{m}">{n}</span><span class="f1 tr">{title}</span>{extra}<span class="mono nf" style="font-size:11.5px;color:{m}">{meta}</span></span>'
        f'<span class="tr" style="padding-left:20px;font-size:13px;color:{m}">{sub}</span></a>')
    new = f'<span class="nf" style="font-size:11.5px;color:{a}">new</span>'
    rows = (row(True, '1.', 'Question Title 123', '2m', 'Agent 1 · Project Alpha · 3 questions · 1 answered', 'PhoneQuestion.dc.html', new)
            + row(False, '2.', 'Question Title 127', '14m', 'Agent 3 · Project Beta · 1 question', 'PhoneQuestion.dc.html')
            + row(False, '⚠', 'Alert Title 456', '9m', 'Agent 3 · Project Beta', 'PhoneInbox.dc.html', '', T['blocked'])
            + row(False, '', '✓ Question Title 119 · delivered', '1h', 'Option B · Agent 2', 'PhoneInbox.dc.html', '', T['dim']))
    head = (f'<header class="col nf" style="padding:56px 16px 8px;gap:2px"><span style="font-size:26px;font-weight:600">Inbox</span>'
            f'<span style="font-size:13px;color:{m}">2 waiting · 1 alert</span></header>')
    lst = (f'<main class="col f1" style="min-height:0;overflow:hidden;background:{T["popover"]};border-top:1px solid {T["border"]}">'
           f'<div class="row nf" style="padding:14px 16px 10px;font-size:15px;font-weight:600"><span class="f1">Open questions</span><span class="mono" style="font-size:12px;font-weight:400;color:{m}">2 groups</span></div>'
           f'{rows}<div style="border-top:1px solid {T["border"]}"></div>'
           f'<div class="row" style="gap:10px;padding:12px 16px"><span class="f1" style="font-size:12.5px;color:{m}">Alert Title 456 needs no answer.</span>'
           f'<button style="height:44px;padding:0 14px;border-radius:7px;border:1px solid {T["input"]};background:{T["raised"]};font-size:13px">Seen</button></div></main>')
    return ph_page('Phone inbox', head + lst + nav('Inbox'))


def q_tabs(cur, drafts, answered):
    a, m = T['accent'], T['muted']
    names = ['Single', 'Multi', 'Free text']
    out = ''
    for n in names:
        color = T['foreground'] if n == cur else T['ansi2'] if n in drafts else m
        out += (f'<a href="PhoneQuestion.dc.html" role="tab" class="row nf" style="height:44px;padding:0 11px;font-size:14px;color:{color};border-bottom:2px solid {a if n == cur else T["popover"]}">{n}</a>')
    on = cur == 'submit'
    out += (f'<span class="f1"></span><a href="PhoneReview.dc.html" role="tab" class="row nf" style="height:36px;padding:0 10px;gap:6px;border-radius:7px;border:2px solid {a if on else T["solid"]};'
            f'background:{T["solid"]};color:{T["solid_fg"]}"><span style="font-size:13px;font-weight:600">Submit ✓</span><span class="mono" style="font-size:11.5px">{answered}</span></a>')
    return f'<div role="tablist" aria-label="Questions" class="row nf" style="gap:2px;padding:0 12px;border-bottom:1px solid {T["border"]}">{out}</div>'


def phone_question():
    a, m = T['accent'], T['muted']
    hdr = (f'<header class="col nf" style="padding:50px 16px 10px;gap:4px"><div class="row" style="gap:8px">{back("PhoneInbox.dc.html")}<span class="f1 tr" style="font-size:18px;font-weight:600">Question Title 123</span></div>'
           f'<div class="row mono" style="gap:10px;font-size:11.5px;color:{m}"><span style="color:{a}">Q123</span><span>Agent 1 · Project Alpha</span><span>2m ago</span></div></header>')
    opt = lambda on, n, l, d: (f'<button class="row" style="min-height:56px;align-items:flex-start;gap:8px;text-align:left;padding:11px 12px;border-radius:9px;border:1px solid {a if on else T["border"]};background:{T["selected"] if on else T["raised"]}">'
                               f'<span class="mono nf" style="width:22px;font-size:13px;line-height:1.5;color:{a if on else m}">{n}</span>'
                               f'<span class="col" style="gap:2px"><span style="font-size:15px">{l}</span><span style="font-size:13px;color:{m}">{d}</span></span></button>')
    opts = ''.join(opt(i == 0, i + 1, l, d) for i, (l, d) in enumerate(OPTS))
    main = (f'<main class="col f1" style="min-height:0;overflow:hidden;padding:16px;gap:10px">'
            f'<div class="row" style="gap:8px"><span class="mono" style="padding:4px 6px;border-radius:4px;background:{T["surface"]};color:{T["ansi4"]};font-size:10.5px;font-weight:600;line-height:1">SINGLE</span><span class="mono" style="font-size:11.5px;color:{m}">pick one</span></div>'
            f'<div style="font-size:17px">Question Text 345: pick one option.</div><div class="col" style="gap:6px">{opts}</div>'
            f'<label for="note" style="font-size:12.5px;color:{m};margin-top:4px">Note for the agent</label>'
            f'<input id="note" placeholder="Add a note for the agent…" style="height:44px;padding:0 12px;border-radius:8px;border:1px solid {T["input"]};background:transparent;color:{T["foreground"]};font:inherit;font-size:15px"></main>')
    foot = (f'<div class="row nf" style="gap:8px;padding:10px 16px 34px;border-top:1px solid {T["border"]}">'
            f'<a href="PhoneInbox.dc.html" class="row f1" style="height:48px;justify-content:center;border-radius:7px;border:1px solid {T["input"]};background:{T["raised"]}">Later</a>'
            f'<button class="row" style="flex:2;height:48px;justify-content:center;border-radius:7px;border:1px solid {T["solid"]};background:{T["solid"]};color:{T["solid_fg"]};font-weight:500">Next ⏎</button></div>')
    return ph_page('Phone question', hdr + q_tabs('Single', ['Multi'], '1/3') + main + foot, css=f'.ph{{background:{T["popover"]}}}')


def phone_review():
    a, m = T['accent'], T['muted']
    hdr = (f'<header class="col nf" style="padding:50px 16px 10px;gap:4px"><div class="row" style="gap:8px">{back("PhoneQuestion.dc.html")}<span class="f1 tr" style="font-size:18px;font-weight:600">Question Title 123</span></div></header>')
    item = lambda q, ans, on, has: (f'<a href="PhoneQuestion.dc.html" class="row" style="gap:8px;padding:11px 12px;border-radius:9px;border:1px solid {a if on else T["border"]};background:{T["selected"] if on else T["raised"]}">'
                                    f'<span class="col f1" style="gap:2px"><span style="font-size:14px">{q}</span><span style="font-size:13px;color:{T["foreground"] if has else m}">{ans}</span></span><span style="color:{m}">›</span></a>')
    items = item('Q123 · Single', 'Option A', False, True) + item('Q124 · Multi', 'Option X, Option Z', False, True) + item('Q125 · Free text', 'No answer yet: it stays open', False, False)
    main = f'<main class="col f1" style="min-height:0;overflow:hidden;padding:16px;gap:6px"><div style="font-size:16px;padding-bottom:6px">Review your answers</div>{items}</main>'
    foot = (f'<div class="col nf" style="gap:8px;padding:12px 16px 34px;border-top:1px solid {T["border"]}">'
            f'<button class="row" style="min-height:56px;padding:10px 14px;gap:10px;border-radius:9px;border:2px solid {a};background:{T["solid"]};color:{T["solid_fg"]};text-align:left">'
            f'<span class="mono nf" style="width:14px;font-size:12px">1</span><span class="col f1" style="gap:2px"><span style="font-size:15px;font-weight:600">Submit answers ✓</span><span style="font-size:12.5px;opacity:.8">Sends 2 of 3 · Free text stays open</span></span></button>'
            f'<a href="PhoneInbox.dc.html" class="row" style="min-height:48px;padding:0 14px;gap:10px;border-radius:9px;border:2px solid {T["input"]};background:{T["raised"]}">'
            f'<span class="mono nf" style="width:14px;font-size:12px">2</span><span style="font-size:14px;font-weight:600">Cancel</span><span style="font-size:12.5px;opacity:.8">Sends nothing</span></a></div>')
    return ph_page('Phone review', hdr + q_tabs('submit', ['Single', 'Multi'], '2/3') + main + foot, css=f'.ph{{background:{T["popover"]}}}')



# ---------------- pairing and connection banners ----------------
# A design-only state switcher (not part of the app). The first state can also come from the URL hash (#wait) for renders.
SWITCH = f"""<div role="tablist" aria-label="Design state, not part of the app" class="abs row" style="top:8px;left:8px;right:8px;z-index:5;gap:2px;padding:2px;border-radius:8px;border:1px dashed {T["input"]};background:#000000b8">
<sc-for list="{{{{states}}}}" as="t" hint-placeholder-count="5"><button role="tab" aria-selected="{{{{t.selected}}}}" onClick="{{{{t.pick}}}}" class="row f1" style="justify-content:center;height:28px;padding:0 2px;border-radius:6px;font-size:11px;white-space:nowrap;background:{{{{t.bg}}}};color:{{{{t.fg}}}}">{{{{t.label}}}}</button></sc-for></div>"""


def switch_script(names, first, vals):
    return f"""class Component extends DCLogic {{
  constructor(props) {{ super(props); let h = ''; try {{ h = location.hash.slice(1); }} catch (e) {{}}
    this.state = {{ s: {names!r}.some(n => n[0] === h) ? h : '{first}' }}; }}
  renderVals() {{
    const cur = this.state.s;
    const names = {names!r};
    return {{
      states: names.map(([id, label]) => ({{ label, selected: String(cur === id), bg: cur === id ? '{T["raised"]}' : 'transparent', fg: cur === id ? '{T["foreground"]}' : '{T["muted"]}', pick: () => this.setState({{ s: id }}) }})),
      show: Object.fromEntries(names.map(([id]) => [id, cur === id])),
      {vals}
    }};
  }}
}}"""


PAIR_STATES = [['check', 'Checking'], ['wait', 'Waiting'], ['ok', 'Approved'], ['bad', 'Expired'], ['safari', 'In Safari'], ['first', '1st launch']]
MARK = '<img src="icons/remote.svg" alt="" style="width:64px;height:64px;border-radius:14px">'
PCARD = f'border-radius:10px;background:{T["background"]};border:1px solid {T["border"]}'
SOLID_BTN = f'height:48px;width:100%;justify-content:center;border-radius:7px;border:1px solid {T["solid"]};background:{T["solid"]};color:{T["solid_fg"]};font-size:15px;font-weight:500'


def kv(k, v):
    return f'<div class="row" style="gap:8px;font-size:13px"><span class="f1" style="color:{T["dim"]}">{k}</span><span style="font-weight:500">{v}</span></div>'


def steps(items):
    rows = ''.join(f'<div class="row" style="align-items:flex-start;gap:10px;font-size:13.5px;line-height:1.45"><span class="mono nf row" style="width:20px;height:20px;justify-content:center;border-radius:5px;background:{T["raised"]};font-size:11px;color:{T["muted"]}">{i + 1}</span><span class="f1">{s}</span></div>' for i, s in enumerate(items))
    return f'<div class="col" style="width:100%;padding:14px;gap:12px;text-align:left;{PCARD}">{rows}</div>'


def pair_block(key, chip, title, body, extra='', foot=''):
    return (f'<sc-if value="{{{{show.{key}}}}}" hint-placeholder-val="{{{{ {"true" if key == "wait" else "false"} }}}}">'
            f'<div class="nf" style="height:44px"></div><main class="col f1" style="min-height:0;padding:24px;align-items:center;justify-content:center;gap:14px;text-align:center">'
            f'<div class="rel">{MARK}<span class="abs row" style="right:-8px;bottom:-8px;width:28px;height:28px;justify-content:center;border-radius:9px;background:#101114">{chip}</span></div>'
            f'<div style="font-size:17px;font-weight:600">{title}</div>'
            f'<div style="font-size:14px;color:{T["muted"]};line-height:1.5;max-width:300px">{body}</div>{extra}</main>{foot}</sc-if>')


def phone_pair():
    dot = lambda c, anim='': f'<span class="nf" style="width:8px;height:8px;border-radius:4px;background:{c}{anim}"></span>'
    amber = STATES['wait'][2]
    foot = lambda inner: f'<div class="col nf" style="gap:8px;padding:12px 16px 34px;border-top:1px solid {T["border"]}">{inner}</div>'
    check = pair_block('check', spinner(16), 'Checking the code…', 'Pairing this phone with desk-1.')
    wait = pair_block('wait', dot(amber, ';animation:hd-breathe 1.6s ease-in-out infinite'), 'Approve on your computer',
                      'desk-1 is asking whether to let this phone in. Approve it there to finish.',
                      f'<div class="col" style="width:100%;padding:12px 14px;gap:10px;text-align:left;{PCARD}">{kv("Shows as", "Phone 1")}{kv("Computer", "desk-1")}'
                      f'<div class="row" style="gap:8px;padding-top:10px;border-top:1px solid {T["border"]};font-size:13px;color:{amber}">{dot(amber, ";animation:hd-breathe 1.6s ease-in-out infinite")}Waiting for approval…</div></div>'
                      f'<div style="font-size:12.5px;color:{T["dim"]}">The request ends after 10 minutes if no one approves it.</div>')
    ok = pair_block('ok', tile('done', 18), 'Phone 1 is paired',
                    'desk-1 approved this phone. You can remove it any time in Remote on the computer.',
                    f'<div style="font-size:12.5px;color:{T["dim"]}">Opening Herdr…</div>',
                    foot(f'<a href="PhoneAgents.dc.html" class="row" style="{SOLID_BTN}">Continue</a>'))
    bad = pair_block('bad', tile('fail', 18), 'This code no longer works',
                     'Each code works once, for 5 minutes.',
                     steps(['On desk-1, open Remote › Devices for a fresh code.', 'Scan it with the iPhone Camera.']))
    share = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-label="Share" style="vertical-align:-2px"><path d="M12 3v12M7.5 7.5 12 3l4.5 4.5"/><path d="M6 11H5v10h14V11h-1"/></svg>'
    safari_bar = (f'<div class="col nf" style="padding:8px 12px 30px;gap:8px;background:#1c1d20;border-top:1px solid {T["border"]}">'
                  f'<div class="row" style="height:40px;justify-content:center;border-radius:10px;background:{T["raised"]};font-size:13px;color:{T["muted"]}">desk-1.example-tailnet.ts.net</div>'
                  f'<div class="row" style="justify-content:space-around;color:{T["dim"]};font-size:15px"><span>‹</span><span>›</span><span style="color:{T["accent"]}">{share}</span><span>▢</span><span>⧉</span></div></div>')
    bell = ('<button aria-label="Notifications" class="row" style="width:44px;height:44px;margin-right:-8px;justify-content:center;color:' + T['muted'] + '">'
            '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/></svg></button>')
    brand = ph_brand().replace('icons/remote.png', 'icons/remote.svg').replace('<button aria-label="Search"', bell + '<button aria-label="Search"')
    prompt = (f'<section aria-label="Get notifications" class="abs col" style="left:8px;right:8px;bottom:154px;z-index:2;padding:14px;gap:10px;border-radius:12px;background:{T["popover"]};border:1px solid #ffffff1f;box-shadow:0 12px 32px #00000080">'
              f'<div class="row" style="align-items:flex-start;gap:10px"><img src="icons/remote.svg" alt="" class="nf" style="width:36px;height:36px;border-radius:9px">'
              f'<div class="col f1" style="gap:2px;line-height:1.4"><span style="font-size:15px;font-weight:600">Get notifications on this phone</span>'
              f'<span style="font-size:13px;color:{T["muted"]}">Add Herdr to your Home Screen. It opens already set up.</span></div>'
              f'<button aria-label="Close" class="row nf" style="width:44px;height:44px;margin:-12px -12px 0 0;justify-content:center;color:{T["dim"]}">{icon("x", 14)}</button></div>'
              + steps([f'Tap Share {share} below.', 'Tap Add to Home Screen.', 'Open Herdr from your Home Screen.']).replace(PCARD, f'border-radius:10px;background:{T["background"]};border:1px solid {T["border"]};padding:12px') +
              f'<div class="row" style="gap:10px"><span class="f1" style="font-size:12px;color:{T["dim"]}">To see this again, tap the bell at the top.</span>'
              f'<button style="height:44px;padding:0 16px;border-radius:7px;border:1px solid {T["input"]};background:{T["raised"]};font-size:13px">Not now</button></div></section>')
    safari_bar = (f'<div class="col nf" style="padding:6px 12px 22px;gap:6px;background:#1c1d20;border-top:1px solid {T["border"]}">'
                  f'<div class="row" style="height:36px;justify-content:center;border-radius:10px;background:{T["raised"]};font-size:13px;color:{T["muted"]}">desk-1.example-tailnet.ts.net</div>'
                  f'<div class="row" style="justify-content:space-around;color:{T["dim"]};font-size:15px"><span>‹</span><span>›</span><span style="color:{T["accent"]}">{share}</span><span>▢</span><span>⧉</span></div></div>')
    sp = D.spaces_block(D.SPACES).replace('class="col nf" style="height:143px', 'class="col nf sblock" style="height:143px')
    ag = D.agents_panel(D.groups(), totals='<span>?1</span>')
    navbar = nav('Agents').replace('padding:8px 8px 30px', 'padding:4px 8px 4px')
    safari = (f'<sc-if value="{{{{show.safari}}}}" hint-placeholder-val="{{{{ false }}}}">{brand}'
              f'<main class="col f1" style="min-height:0;overflow:hidden"><div class="z col" style="width:325px">{sp}{ag}</div></main>'
              f'{prompt}{navbar}{safari_bar}</sc-if>')
    first = pair_block('first', spinner(16), 'Finishing setup on this phone…',
                       'Using the pairing from Safari. No need to approve again.')
    inner = SWITCH + check + wait + ok + bad + safari + first
    return ph_page('Phone pairing', inner, switch_script(PAIR_STATES, 'wait', ''), css='.ph{position:relative}')


BANNER_STATES = [['unpaired', 'Unpaired'], ['refused', 'Refused'], ['paused', 'Paused'], ['unavailable', 'Unavailable']]
BANNERS = {  # cls is the state hue the PWA's Banner uses (s-wait amber, s-fail red, s-q grey)
    'unpaired': ('wait', "This phone isn't paired yet.", 'Scan a fresh code from Remote › Devices on desk-1 with the iPhone Camera.', ''),
    'refused': ('fail', 'desk-1 no longer accepts this phone.', 'It was removed, or this phone uses another account. Scan a fresh code from Remote › Devices with the iPhone Camera.', ''),
    'paused': ('q', 'Remote access is paused on desk-1.', 'Resume it in Remote on the computer. This reconnects by itself.', ''),
    'unavailable': ('wait', "Can't reach desk-1.", "It may be asleep or offline. Trying again every 10 s.", 'Retry now'),
}
BANNER = f"""<div role="status" class="banner s-{{{{b.cls}}}}" style="position:absolute;left:8px;right:8px;bottom:96px;z-index:2;display:flex;align-items:center;gap:10px;min-height:48px;padding:8px 8px 8px 12px;border-radius:8px;background:var(--cf);border:1px solid var(--cb);font-size:12.5px">
 <span aria-hidden="true" class="nf" style="width:7px;height:7px;border-radius:4px;background:var(--hue)"></span>
 <span class="col f1" style="gap:1px;line-height:1.35"><span style="color:var(--hue)">{{{{b.title}}}}</span><span style="color:{T["muted"]}">{{{{b.sub}}}}</span></span>
 <sc-if value="{{{{b.action}}}}" hint-placeholder-val="{{{{ true }}}}"><button class="nf" style="height:36px;padding:0 12px;border-radius:6px;border:1px solid var(--cb);background:#00000033;color:var(--hue);font-size:12.5px;font-weight:500;white-space:nowrap">{{{{b.action}}}}</button></sc-if>
</div>"""


def phone_banners():
    import json
    data = json.dumps({k: dict(cls=c, title=t, sub=s, action=a) for k, (c, t, s, a) in BANNERS.items()})
    script = switch_script(BANNER_STATES, 'unavailable', f'b: {data}[cur]')
    sp = D.spaces_block(D.SPACES).replace('class="col nf" style="height:143px', 'class="col nf sblock" style="height:143px')
    ag = '<a href="PhoneChat.dc.html" class="col f1" style="min-height:0" title="A card with a live agent opens its Chat; a feed-only root opens the Swarm (PhoneSwarm.dc.html)">' + D.agents_panel(D.groups(), totals='<span>?1</span>') + '</a>'
    brand = ph_brand().replace('icons/remote.png', 'icons/remote.svg')
    inner = (SWITCH + brand + f'<main class="col f1" style="min-height:0;overflow:hidden"><div class="z col" style="width:325px">{sp}{ag}</div></main>'
             + BANNER + nav('Agents'))
    return ph_page('Phone connection banners', inner, script, css='.ph{position:relative}')


FILES = {
    'DesktopRemote': desktop_remote, 'DesktopSetup': desktop_setup, 'DesktopInbox': desktop_inbox,
    'PhoneAgents': phone_agents, 'PhoneAgentsBasic': phone_agents_basic, 'PhoneSwarm': phone_swarm, 'PhonePeek': phone_peek,
    'PhoneUsage': phone_usage, 'PhoneMissing': phone_missing, 'PhoneChat': phone_chat, 'PhoneInbox': phone_inbox,
    'PhoneQuestion': phone_question, 'PhoneReview': phone_review,
    'PhonePair': phone_pair, 'PhoneBanners': phone_banners,
}
