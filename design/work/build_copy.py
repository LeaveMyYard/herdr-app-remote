"""Approval board, 2026-11-11: key menu (S16b), typing expiry (S16), and every provisional string, current vs proposed."""
import os
from common import T, STATES, page, tile, icon, mix
import desktop as D
from build_rest import (ph_page, back, nav, ph_brand, TERM, SWITCH, switch_script, q_tabs, OPTS, esc)

amber = STATES['wait'][2]
red = T['blocked']
BTN = f'height:44px;padding:0 14px;border-radius:7px;border:1px solid {T["input"]};background:{T["raised"]};font-size:14px'
SOLID = f'height:44px;padding:0 16px;border-radius:7px;border:1px solid {T["solid"]};background:{T["solid"]};color:{T["solid_fg"]};font-size:14px;font-weight:500'


def block(key, first, html):
    return f'<sc-if value="{{{{show.{key}}}}}" hint-placeholder-val="{{{{ {"true" if key == first else "false"} }}}}">{html}</sc-if>'


# ---------------- chat parts ----------------
def chat_head():
    return (f'<header class="row nf" style="padding:50px 16px 6px;gap:6px;border-bottom:1px solid {T["border"]}">{back("PhoneAgents.dc.html")}'
            f'<div class="z row f1" style="gap:8px;font-size:12px">{D.term_header("Agent 1 · Parser rewrite", "~/code/alpha", "working")}</div>'
            f'<button aria-label="Fit width" class="mono row nf" style="width:44px;height:44px;justify-content:center;border-radius:9px;background:{T["raised"]};font-size:12px">Aa</button></header>')


def chat_term(short=False):
    t = TERM.replace('#98999b', T['muted'])
    return (f'<div class="mono f1" style="min-height:0;overflow:hidden;padding:12px;background:{T["background"]};font-size:11.5px;line-height:1.55;color:{T["foreground"]};white-space:pre-wrap">{t}\n\n'
            f'<span style="color:#ffffff24">────────────────────────────────</span>\n❯ <span style="color:{T["foreground"]}">▌</span>\n<span style="color:#ffffff24">────────────────────────────────</span></div>')


def keybtn(label, aria=None, extra=''):
    a = f' aria-label="{aria}"' if aria else ''
    return f'<button{a} class="nf row" style="min-width:44px;height:40px;padding:0 12px;justify-content:center;gap:6px;border-radius:7px;border:1px solid {T["border"]};background:{T["raised"]};font-size:12.5px{extra}">{label}</button>'


KB = ('<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">'
      '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 10h1M9.5 10h1M13 10h1M16.5 10h1M7 14h10"/></svg>')


def keybar(keys_on=True):
    keys = keybtn(f'{KB}<span style="font-family:Inter,system-ui">Keys</span><span style="color:{T["muted"]}">▴</span>', 'Keys: open the special keys menu',
                  '' if keys_on else f';color:{T["dim"]}')
    return (f'<div role="toolbar" aria-label="Keys" class="mono row nf" style="gap:6px;padding:8px 12px">'
            f'{keybtn("⏎", "Enter")}{keybtn("/", "Type a slash")}<span class="f1"></span>{keys}</div>')


def composer():
    return (f'<form class="row nf" style="align-items:flex-end;gap:8px;padding:4px 12px 34px">'
            f'<textarea rows="1" placeholder="Type to the terminal…" style="flex:1;min-height:44px;resize:none;padding:11px 14px;border-radius:10px;border:1px solid {T["input"]};background:{T["background"]};color:{T["foreground"]};font:inherit;font-size:15px"></textarea>'
            f'<button type="button" aria-label="Send" class="row nf" style="width:44px;height:44px;justify-content:center;border-radius:10px;background:{T["solid"]};color:{T["solid_fg"]}">'
            f'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"/></svg></button></form>')


CLOCK = ('<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" style="flex:none">'
         '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>')


def expiry(text, color=None):
    c = color or T['muted']
    return f'<div role="status" class="row nf" style="gap:6px;padding:8px 14px 0;font-size:12px;color:{c}">{CLOCK}<span>{text}</span></div>'


def sheet(inner):
    return (f'<div class="abs" style="inset:0;z-index:3;background:#00000080"></div>'
            f'<section role="dialog" aria-label="Special keys" class="abs col" style="left:0;right:0;bottom:0;z-index:4;padding:8px 16px 34px;gap:12px;'
            f'border-radius:16px 16px 0 0;background:{T["popover"]};border-top:1px solid #ffffff1f;box-shadow:0 -12px 32px #00000080">'
            f'<span class="nf" style="align-self:center;width:36px;height:5px;border-radius:3px;background:{T["input"]}"></span>{inner}</section>')


def sheet_head(sub):
    return (f'<div class="row" style="gap:8px"><div class="col f1" style="gap:2px"><span style="font-size:17px;font-weight:600">Keys</span>'
            f'<span style="font-size:12.5px;color:{T["muted"]}">{sub}</span></div>'
            f'<button aria-label="Close" class="row nf" style="width:44px;height:44px;margin-right:-10px;justify-content:center;color:{T["muted"]}">{icon("x", 14)}</button></div>')


DEFAULT_KEYS = [('Esc', 'esc'), ('Tab', 'tab'), ('Shift-Tab', 'shift+tab'), ('Ctrl-C', 'ctrl+c'), ('↑', 'up'), ('↓', 'down'), ('←', 'left'), ('→', 'right')]
CUSTOM_KEYS = [('Accept ✓', 'alt+1'), ('Clear line', 'ctrl+u')]


def keycell(label, token, warn=False, dim=False, pressed=False):
    c = T['dim'] if dim else (red if warn else T['foreground'])
    bd = T['accent'] if pressed else (mix(red, .35) if warn and not dim else T['border'])
    bg = T['selected'] if pressed else T['raised']
    return (f'<button class="col" style="height:56px;justify-content:center;align-items:center;gap:2px;border-radius:9px;border:1px solid {bd};background:{bg};color:{c}">'
            f'<span style="font-size:15px;font-weight:500">{label}</span><span class="mono" style="font-size:10.5px;color:{T["dim"]}">{token}</span></button>')


def key_grid(dim=False, pressed=None):
    cells = ''.join(keycell(l, t, l == 'Ctrl-C', dim, pressed == l) for l, t in DEFAULT_KEYS)
    custom = ''.join(keycell(l, t, False, dim, pressed == l) for l, t in CUSTOM_KEYS)
    grid = 'display:grid;grid-template-columns:repeat(4,1fr);gap:8px'
    return (f'<div style="{grid}">{cells}</div>'
            f'<div class="row" style="gap:8px;font-size:11.5px;color:{T["dim"]};padding-top:2px"><span>Your keys</span><span class="f1" style="height:1px;background:{T["border"]}"></span></div>'
            f'<div style="{grid}">{custom}</div>')


def phone_keys():
    kb_rest = lambda exp, keys_on=True: exp + keybar(keys_on) + composer()
    # 1. Typing on, no expiry soon: the line says until when.
    bar = chat_head() + chat_term() + kb_rest(expiry('Typing is on until 21:40'))
    # 2. Menu open.
    menu_inner = (sheet_head("Pressed at once in Agent 1's terminal.") + key_grid(pressed='Ctrl-C')
                  + f'<div role="status" class="row" style="gap:6px;font-size:12.5px;color:{T["muted"]}">{tile("done", 14)}Pressed Ctrl-C.</div>'
                  + f'<div style="font-size:12px;color:{T["dim"]};line-height:1.45">Change this list in keys.json on desk-1.</div>')
    menu = chat_head() + chat_term() + kb_rest(expiry('Typing is on until 21:40')) + sheet(menu_inner)
    # 3. Keys capability off (typing still on).
    off_inner = (sheet_head("Agent 1's terminal") + key_grid(dim=True)
                 + f'<div class="row" style="align-items:flex-start;gap:8px;padding:10px 12px;border-radius:8px;background:{mix(amber, .06)};border:1px solid {mix(amber, .25)};font-size:13px;line-height:1.45">'
                 f'<span class="nf" style="width:7px;height:7px;margin-top:6px;border-radius:4px;background:{amber}"></span>'
                 f'<span class="f1">Special keys are off for this phone. Turn them on in Remote on desk-1.</span></div>')
    off = chat_head() + chat_term() + kb_rest(expiry('Typing is on until 21:40'), keys_on=False) + sheet(off_inner)
    # 4. Under 10 minutes left: amber.
    soon = chat_head() + chat_term() + kb_rest(expiry('Typing turns off in 4 min, at 21:40', amber))
    # 5. Ran out: read-only footer.
    ro = (f'<div class="col nf" style="gap:4px;padding:14px 16px 38px;border-top:1px solid {T["border"]}">'
          f'<span style="font-size:14px">Typing turned off at 21:40.</span>'
          f'<span style="font-size:13px;color:{T["muted"]}">Turn it on again in Remote on desk-1.</span></div>')
    gone = chat_head() + chat_term() + ro
    states = [['bar', 'Typing on'], ['menu', 'Keys menu'], ['off', 'Keys off'], ['soon', '4 min left'], ['gone', 'Ran out']]
    inner = SWITCH + ''.join(block(k, 'menu', f'<div class="col" style="height:844px;position:relative">{h}</div>')
                             for k, h in [('bar', bar), ('menu', menu), ('off', off), ('soon', soon), ('gone', gone)])
    return ph_page('Phone keys and typing time', inner, switch_script(states, 'menu', ''), css='.ph{position:relative}.ph>sc-if>div{flex:none}')


# ---------------- provisional copy in context ----------------
def lock_note(title, body, ago='now'):
    return (f'<div class="row" style="align-items:flex-start;gap:10px;padding:12px;border-radius:18px;background:#2a2b30d9;backdrop-filter:blur(20px)">'
            f'<img src="icons/remote.svg" alt="" class="nf" style="width:36px;height:36px;border-radius:8px">'
            f'<div class="col f1" style="gap:1px;min-width:0;line-height:1.35"><div class="row" style="gap:6px"><span class="f1 tr" style="font-size:14px;font-weight:600">{title}</span>'
            f'<span style="font-size:12px;color:{T["muted"]}">{ago}</span></div><span style="font-size:14px">{body}</span></div></div>')


def phone_copy():
    m = T['muted']
    push = (f'<div class="col f1" style="padding:60px 10px 0;gap:8px;background:linear-gradient(#1c2a3a,#0d1117)">'
            f'<div class="col" style="align-items:center;padding:20px 0 30px;color:#fff"><span style="font-size:17px">Wednesday 11 November</span>'
            f'<span style="font-size:80px;font-weight:600;line-height:1">20:37</span></div>'
            + lock_note('Agent 1: Question Title 123', 'New question')
            + lock_note('Agent 3: Question Title 127', '3 new questions', '2m ago')
            + lock_note('Agent 3: Alert Title 456', 'Urgent alert', '9m ago')
            + lock_note('Agent 2 is blocked', 'Needs you', '14m ago')
            + lock_note('Agent 1: Question Title 128', 'and 2 more', '20m ago')
            + '</div>')
    confirm = (chat_head() + chat_term()
               + f'<div role="alertdialog" class="col nf" style="margin:8px 12px 0;padding:12px;gap:10px;border-radius:10px;background:{T["popover"]};border:1px solid {T["input"]}">'
               f'<span style="font-size:14px">Type this into Agent 1\'s terminal?</span>'
               f'<span style="font-size:12.5px;color:{m}">Asked once for each terminal while the app is open.</span>'
               f'<div class="row" style="gap:8px;justify-content:flex-end"><button style="{BTN}">Cancel</button><button style="{SOLID}">Send</button></div></div>'
               + keybar() + composer().replace('placeholder="Type to the terminal…"', 'placeholder="" ').replace('></textarea>', '>run the tests again</textarea>'))
    a = T['accent']
    qhead = (f'<header class="col nf" style="padding:50px 16px 10px;gap:4px"><div class="row" style="gap:8px">{back("PhoneInbox.dc.html")}<span class="f1 tr" style="font-size:18px;font-weight:600">Question Title 123</span>'
             f'<button style="height:36px;padding:0 10px;border-radius:7px;font-size:13px;color:{m}">Dismiss</button></div>'
             f'<div class="row mono" style="gap:10px;font-size:11.5px;color:{m}"><span style="color:{a}">Q123</span><span>Agent 1 · Project Alpha</span><span>2m ago</span></div></header>')
    opt = lambda on, n, l, d: (f'<button class="row" style="min-height:56px;align-items:flex-start;gap:8px;text-align:left;padding:11px 12px;border-radius:9px;border:1px solid {a if on else T["border"]};background:{T["selected"] if on else T["raised"]}">'
                               f'<span class="mono nf" style="width:22px;font-size:13px;line-height:1.5;color:{a if on else m}">{n}</span>'
                               f'<span class="col" style="gap:2px"><span style="font-size:15px">{l}</span><span style="font-size:13px;color:{m}">{d}</span></span></button>')
    qmain = (f'<main class="col f1" style="min-height:0;overflow:hidden;padding:16px;gap:10px"><div style="font-size:17px">Question Text 345: pick one option.</div>'
             f'<div class="col" style="gap:6px">{"".join(opt(i == 0, i + 1, l, d) for i, (l, d) in enumerate(OPTS))}</div></main>')
    dbar = (f'<div role="alertdialog" class="col nf" style="gap:10px;padding:12px 16px 34px;border-top:1px solid {mix(red, .35)};background:{mix(red, .06, T["popover"])}">'
            f'<span style="font-size:14px;color:{red}">Dismiss Q123–Q125 (3 questions) without answering?</span>'
            f'<div class="row" style="gap:8px"><button class="f1" style="{BTN}">Keep</button>'
            f'<button class="f1" style="{BTN};border-color:{mix(red, .5)};color:{red}">Dismiss</button></div></div>')
    dismiss = f'<div class="col f1" style="background:{T["popover"]}">' + qhead + q_tabs('Single', ['Multi'], '1/3') + qmain + dbar + '</div>'
    row = lambda text, btn, tone=T['border']: (f'<div class="row" style="gap:10px;margin:0 12px 8px;padding:10px 12px;border-radius:8px;border:1px solid {tone};background:{T["background"]};font-size:13px;line-height:1.4">'
                                              f'<span class="f1">{text}</span>{f"<button style={chr(34)}{BTN}{chr(34)}>{btn}</button>" if btn else ""}</div>')
    notes = (f'<header class="col nf" style="padding:56px 16px 8px;gap:2px"><span style="font-size:26px;font-weight:600">Inbox</span>'
             f'<span style="font-size:13px;color:{m}">2 waiting · 1 alert</span></header>'
             f'<div class="col" style="padding-top:6px;gap:0"><span style="padding:4px 16px 8px;font-size:11.5px;color:{T["dim"]}">The notifications row, one state at a time:</span>'
             + row('Get a notification when an agent asks a question or is blocked.', 'Turn on')
             + row('Notifications are on for this phone.', 'Turn off')
             + row('Notifications are off for this phone. Turn them on in Remote on desk-1.', '')
             + row('Notifications are blocked for this app. Allow them in Settings, then come back.', '')
             + row("Notifications couldn't be turned on. Try again.", 'Turn on', mix(amber, .35))
             + '</div><span class="f1"></span>' + nav('Inbox'))
    states = [['push', 'Pushes'], ['confirm', 'First send'], ['dismiss', 'Dismiss'], ['notes', 'Notify row']]
    inner = SWITCH + ''.join(block(k, 'push', f'<div class="col" style="height:844px;position:relative">{h}</div>')
                             for k, h in [('push', push), ('confirm', confirm), ('dismiss', dismiss), ('notes', notes)])
    return ph_page('Phone provisional copy', inner, switch_script(states, 'push', ''), css='.ph{position:relative}.ph>sc-if>div{flex:none}')


# ---------------- the copy table ----------------
# (area, where in the code, current, proposed or "keep", source of the proposal)
ROWS = [
    ('Push: question', 'bridge push/triggers.ts:70-71', 'Agent 1: Question Title 123 / New question · 3 new questions', 'keep', 'PLAN §7.3'),
    ('Push: alert', 'triggers.ts:82-83', 'Agent 3: Alert Title 456 / Alert · Urgent alert · Blocked', 'keep', ''),
    ('Push: blocked agent', 'triggers.ts:154-155', 'Agent 2 is blocked / Needs you', 'keep', '"Needs you" is the app\'s own pill'),
    ('Push: several at once', 'push/service.ts:274', 'first title / and 2 more', 'keep', ''),
    ('First send (text)', 'pwa ChatComposer.tsx', "Type this into Agent 1's terminal?  [Cancel] [Send]", "same, plus: Asked once for each terminal while the app is open.", 'new line'),
    ('First send (Enter)', 'ChatComposer.tsx', "Press Enter in Agent 1's terminal?", 'keep', ''),
    ('Typing time', 'not shown today', '(nothing)', 'Typing is on until 21:40 · under 10 min, amber: Typing turns off in 4 min, at 21:40', 'desktop panel says "until 21:40"'),
    ('Typing ran out', 'Chat.tsx:176', 'Read-only here. Typing to the terminal is off for this device.', 'Typing turned off at 21:40. / Turn it on again in Remote on desk-1.', 'when it expired; else keep'),
    ('Send refused: off', 'ChatComposer.tsx sendWords', "Typing to the terminal is off for this device. Turn it on in the desktop's Remote panel.", 'Typing to the terminal is off for this phone. Turn it on in Remote on desk-1.', 'same host name as banners'),
    ('Key menu: button', 'new (S16b)', '', 'Keys ▴', ''),
    ('Key menu: sheet', 'new (S16b)', '', "Keys / Pressed at once in Agent 1's terminal. / Your keys / Change this list in keys.json on desk-1.", ''),
    ('Key menu: pressed', 'new (S16b)', '', 'Pressed Ctrl-C.', ''),
    ('Key menu: off', 'new (S16b)', '', 'Special keys are off for this phone. Turn them on in Remote on desk-1.', ''),
    ('Key menu: list changed', 'new (S16b, keys_changed)', '', 'The key list changed on desk-1. Look again.', 'plugin: "Look again"'),
    ('Key menu: dialog open', 'new (S16b, terminal_blocked)', '', 'The agent is waiting on a dialog at the desktop. Nothing was pressed.', 'reuses the send wording'),
    ('Banner: connecting', 'pwa Banner.tsx', 'Connecting to your computer…', 'Connecting to desk-1…', ''),
    ('Banner: offline', 'Banner.tsx', 'No connection. Retrying…', 'keep', ''),
    ('Banner: unpaired', 'Banner.tsx', "This phone isn't paired yet. Pair it from Remote on your computer.", "This phone isn't paired yet. / Scan a fresh code from Remote › Devices on desk-1 with the iPhone Camera.", 'PhoneBanners board'),
    ('Banner: refused', 'Banner.tsx', 'Your computer no longer accepts this phone.', 'desk-1 no longer accepts this phone. / It was removed, or this phone uses another account. Scan a fresh code from Remote › Devices with the iPhone Camera.', 'PhoneBanners board'),
    ('Banner: paused', 'Banner.tsx', 'Remote access is paused on your computer.', 'Remote access is paused on desk-1. / Resume it in Remote on the computer. This reconnects by itself.', 'PhoneBanners board'),
    ('Banner: unavailable', 'Banner.tsx', "Your computer isn't serving right now. Retrying…", "Can't reach desk-1. / It may be asleep or offline. Trying again every 10 s.  [Retry now]", 'PhoneBanners board'),
    ('Dismiss: button', 'pwa inbox/words.ts:65', 'Dismiss', 'keep', ''),
    ('Dismiss: armed', 'words.ts:66-67', 'Dismiss all?  (second tap on the same button)', 'Dismiss Q123–Q125 (3 questions) without answering?  [Keep] [Dismiss]', 'herdr-inbox view.js:96, model/actions.js:129'),
    ('Notify row: off', 'pwa push/PushRow.tsx', 'Get a notification when an agent asks a question or is blocked.  [Turn on]', 'keep', ''),
    ('Notify row: on', 'PushRow.tsx', 'Notifications are on for this phone.  [Turn off]', 'keep', ''),
    ('Notify row: not allowed', 'PushRow.tsx', 'Notifications are off for this phone. Turn them on in the Remote panel on the desktop.', 'Notifications are off for this phone. Turn them on in Remote on desk-1.', 'same host name as banners'),
    ('Notify row: denied', 'PushRow.tsx', 'Notifications are blocked for this app. Allow them in Settings, then come back.', 'keep', ''),
    ('Notify row: failed', 'PushRow.tsx', "Notifications couldn't be turned on. Try again.", 'keep', ''),
    ('Activity: push', 'push/service.ts:244', 'Push sent to Phone 1: group 123', 'keep (board fixed to match)', 'decision 4: identifiers only'),
    ('Approve toast', 'PR #21', 'Approve a new phone?', 'keep', 'decision 5'),
    ('Missing tab: too old', 'pwa screens/Missing.tsx', 'Usage needs an update / The agent-usage plugin in herdr-app on desk-1 is too old for this app.', 'keep', ''),
    ('Missing tab: broken', 'Missing.tsx', "Usage isn't responding / … didn't answer as expected. / To reinstall it, run:", 'keep', ''),
]


def copy_table():
    m = T['muted']
    th = lambda s, w='': f'<th style="text-align:left;padding:8px 10px;font-size:11.5px;font-weight:600;color:{m};border-bottom:1px solid {T["input"]};{w}">{s}</th>'
    out = ''
    for area, where, cur, prop, src in ROWS:
        keep = prop.startswith('keep')
        pc = T['dim'] if keep else T['foreground']
        new = not cur
        out += (f'<tr style="border-bottom:1px solid {T["border"]}">'
                f'<td style="padding:8px 10px;vertical-align:top;font-size:13px;font-weight:500">{esc(area)}</td>'
                f'<td class="mono" style="padding:8px 10px;vertical-align:top;font-size:11px;color:{T["dim"]}">{esc(where)}</td>'
                f'<td style="padding:8px 10px;vertical-align:top;font-size:13px;color:{T["dim"] if new else m}">{esc(cur) or "—"}</td>'
                f'<td style="padding:8px 10px;vertical-align:top;font-size:13px;color:{pc}">{"" if keep else f"<span style={chr(34)}color:{amber}{chr(34)}>● </span>"}{esc(prop)}</td>'
                f'<td style="padding:8px 10px;vertical-align:top;font-size:12px;color:{m}">{esc(src)}</td></tr>')
    changed = sum(1 for r in ROWS if not r[3].startswith('keep'))
    body = (f'<div class="hd" style="width:1280px;padding:28px 32px;background:{T["background"]};color:{T["foreground"]}">'
            f'<div class="row" style="gap:12px;align-items:baseline"><span style="font-size:22px;font-weight:600">Provisional copy: current vs proposed</span>'
            f'<span style="font-size:13px;color:{m}">{len(ROWS)} strings · {changed} to change (●) · the rest keep the current words</span></div>'
            f'<p style="font-size:13px;color:{m};margin:6px 0 16px">"desk-1" stands for the computer\'s Tailscale name, as on the pairing boards. "/" separates the title line from the second line.</p>'
            f'<table style="width:100%;border-collapse:collapse"><thead><tr>{th("Where", "width:150px")}{th("Code", "width:170px")}{th("Current")}{th("Proposed")}{th("Source", "width:170px")}</tr></thead>'
            f'<tbody>{out}</tbody></table></div>')
    return page('Copy table', (1280, 1400), body, 'class Component extends DCLogic {\n  renderVals() { return {}; }\n}')


FILES = {'PhoneKeys': phone_keys, 'PhoneCopy': phone_copy, 'CopyTable': copy_table}

if __name__ == '__main__':
    P = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..') + '/'
    for k, f in FILES.items():
        open(P + k + '.dc.html', 'w').write(f())
    import build_rest
    open(P + 'DesktopRemote.dc.html', 'w').write(build_rest.desktop_remote())
