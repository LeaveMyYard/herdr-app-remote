"""PhoneChatView board, rev 2 (operator, 2026-11-13): for Claude Code the chat is the only view (no terminal toggle,
no Keys menu). Native prompts (permission, AskUserQuestion, plan approval) are chat cards answered with buttons; the
composer is text only, with Stop while the agent works. Codex and unknown harnesses keep today's text view.
Plugin items: herdr-inbox questions and alerts inline, panorama strip, agent-usage chip. Fake data only."""
import os
from common import T, STATES, tile, icon, mix, spinner, harness
import desktop as D
from build_rest import ph_page, back, switch_script
from build_copy import block, keybar, composer, expiry, chat_term, keybtn, KB

amber = STATES['wait'][2]
red = T['blocked']
CHAT_GLYPH = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z"/></svg>'

# Design-only state switcher in two rows (ten states); the screens start 14px lower than the other boards to clear it.
SWITCH2 = f"""<div role="tablist" aria-label="Design state, not part of the app" class="abs" style="top:4px;left:8px;right:8px;z-index:5;display:grid;grid-template-columns:repeat(6,1fr);gap:2px;padding:2px;border-radius:8px;border:1px dashed {T["input"]};background:#000000b8">
<sc-for list="{{{{states}}}}" as="t" hint-placeholder-count="11"><button role="tab" aria-selected="{{{{t.selected}}}}" onClick="{{{{t.pick}}}}" class="row" style="justify-content:center;height:24px;border-radius:6px;font-size:10.5px;white-space:nowrap;background:{{{{t.bg}}}};color:{{{{t.fg}}}}">{{{{t.label}}}}</button></sc-for></div>"""


def head(status='working', h='claude', name='Agent 1', acct=True, swarm=True, aa=False):
    row = (f'<header class="row nf" style="padding:64px 16px 6px;gap:6px">{back("PhoneAgents.dc.html")}'
           f'<div class="z row f1" style="gap:8px;font-size:12px">{D.term_header(name, "~/code/alpha", status, h)}</div></header>')
    return row + context_strip(acct, swarm, aa)


def context_strip(acct=True, swarm=True, aa=False):
    """One quiet line under the header: panorama's subagents (taps open Swarm) and agent-usage's account chip."""
    sw = (f'<a href="PhoneSwarm.dc.html" class="row f1" style="min-width:0;height:36px;gap:4px;font-size:12px;color:{T["muted"]}">'
          f'{tile("run", 16, 2)}{tile("done", 16, 3)}{tile("wait", 16, 1)}'
          f'<span class="tr" style="margin-left:4px">6 subagents</span><span style="color:{T["dim"]}">›</span></a>') if swarm else '<span class="f1" style="height:36px"></span>'
    chip = (f'<a href="PhoneUsage.dc.html" class="row nf" style="height:26px;padding:0 9px;gap:6px;border-radius:13px;border:1px solid {T["border"]};background:{T["surface"]};font-size:11.5px;color:{T["muted"]}">'
            f'<span class="nf" style="width:6px;height:6px;border-radius:3px;background:{T["ansi2"]}"></span>Account 2<span style="color:{T["dim"]}">· 38% used</span></a>') if acct else ''
    fit = (f'<button aria-label="Fit width" class="mono row nf" style="width:40px;height:30px;justify-content:center;border-radius:8px;background:{T["raised"]};font-size:12px">Aa</button>') if aa else ''
    return f'<div class="row nf" style="padding:0 16px 6px;gap:8px;border-bottom:1px solid {T["border"]}">{sw}{chip}{fit}</div>'


# ---------------- timeline parts ----------------
def you(text):
    return (f'<div class="row" style="justify-content:flex-end"><div style="max-width:82%;padding:9px 13px;border-radius:16px 16px 4px 16px;'
            f'background:{T["raised"]};font-size:14.5px;line-height:1.45">{text}</div></div>')


def code(s):
    return f'<code class="mono" style="padding:1px 5px;border-radius:4px;background:{T["surface"]};border:1px solid {T["border"]};font-size:12.5px">{s}</code>'


def agent(html, first=True):
    who = (f'<div class="row" style="gap:6px;font-size:12px;color:{T["dim"]}">{harness("claude", 13)}<span>Agent 1</span></div>') if first else ''
    return f'<div class="col" style="gap:5px">{who}<div style="font-size:14.5px;line-height:1.5;color:{T["foreground"]}">{html}</div></div>'


def ul(items):
    return '<ul style="margin:6px 0 0;padding-left:20px">' + ''.join(f'<li style="margin:2px 0">{i}</li>' for i in items) + '</ul>'


def tool(text, glyph='›', status=None):
    mark = spinner(12) if status == 'run' else f'<span style="color:{T["dim"]}">{glyph}</span>'
    return (f'<button class="row" style="height:34px;align-self:flex-start;gap:8px;padding:0 10px;border-radius:8px;border:1px solid {T["border"]};'
            f'background:{T["background"]};font-size:13px;color:{T["muted"]}">'
            f'<span class="mono" style="color:{T["dim"]};font-size:12px">⏺</span><span>{text}</span>{mark}</button>')


def working(text='Working · 1m 12s'):
    return f'<div role="status" class="row" style="gap:8px;font-size:13px;color:{T["working"]}">{spinner(13)}<span>{text}</span></div>'


def day(text):
    return (f'<div class="row" style="gap:10px;font-size:11.5px;color:{T["dim"]}"><span class="f1" style="height:1px;background:{T["border"]}"></span>'
            f'{text}<span class="f1" style="height:1px;background:{T["border"]}"></span></div>')


def q_open():
    """herdr-inbox `group` row for this agent's terminal, inline where it was asked. Same verbs as Inbox: answer, dismiss."""
    opt = lambda n, l, d, sel=False: (f'<button class="row" style="min-height:48px;padding:7px 12px;gap:10px;border-radius:8px;text-align:left;'
                                      f'border:1px solid {T["accent"] if sel else T["border"]};background:{T["raised"]}">'
                                      f'<span class="mono" style="font-size:11.5px;color:{T["dim"]}">{n}</span>'
                                      f'<span class="col f1" style="gap:1px"><span style="font-size:14px">{l}</span><span style="font-size:12px;color:{T["muted"]}">{d}</span></span></button>')
    return (f'<section aria-label="Question Q123" class="rel col" style="padding:12px 12px 12px 14px;gap:10px;border-radius:10px;background:{mix(amber, .055)};border:1px solid {mix(amber, .22)}">'
            f'<span class="abs" style="left:0;top:0;bottom:0;width:2px;border-radius:9px 0 0 9px;background:{amber}"></span>'
            f'<div class="row" style="gap:8px">{tile("wait", 18, 1)}<span class="f1 tr" style="font-size:14px;font-weight:600">Question Title 123</span>'
            f'<span class="mono" style="font-size:11.5px;color:{T["dim"]}">Q123 · 2m</span></div>'
            f'<div style="font-size:14px;line-height:1.45">Question Text 345: pick one option.</div>'
            f'<div class="col" style="gap:6px">{opt(1, "Option A", "First test choice")}{opt(2, "Option B", "Second test choice")}</div>'
            f'<div class="row" style="gap:8px"><a href="PhoneQuestion.dc.html" class="row f1" style="height:44px;justify-content:center;border-radius:7px;border:1px solid {T["input"]};background:{T["raised"]};font-size:14px">More options…</a>'
            f'<button class="row nf" style="height:44px;padding:0 14px;border-radius:7px;color:{T["muted"]};font-size:14px">Dismiss</button></div></section>')


def q_answered():
    return (f'<a href="PhoneInbox.dc.html" class="row" style="min-height:36px;gap:8px;padding:0 10px;border-radius:8px;border:1px solid {T["border"]};font-size:13px;color:{T["muted"]}">'
            f'{tile("done", 16)}<span class="tr f1"><span style="color:{T["foreground"]}">Question Title 119</span> · Option B</span>'
            f'<span class="mono" style="font-size:11.5px;color:{T["dim"]}">Q119</span></a>')


def alert():
    return (f'<section aria-label="Alert" class="row" style="min-height:48px;gap:10px;padding:8px 8px 8px 12px;border-radius:8px;background:{mix(red, .06)};border:1px solid {mix(red, .25)};font-size:13px">'
            f'<span class="nf" style="width:7px;height:7px;border-radius:4px;background:{red}"></span>'
            f'<span class="col f1" style="gap:1px;line-height:1.35"><span style="color:{red}">Alert Title 456</span><span style="color:{T["muted"]}">Needs no answer.</span></span>'
            f'<button class="nf" style="height:36px;padding:0 12px;border-radius:6px;border:1px solid {T["input"]};background:{T["raised"]};font-size:12.5px">Seen</button></section>')


def failed():
    return (f'<section aria-label="Delivery failed" class="row" style="min-height:48px;gap:10px;padding:8px 8px 8px 12px;border-radius:8px;background:{mix(amber, .05)};border:1px solid {mix(amber, .22)};font-size:13px">'
            f'{tile("done", 16)}<span class="col f1" style="gap:1px;line-height:1.35"><span>Question Title 121 · Option A</span><span style="color:{amber}">Not delivered yet: the agent is busy.</span></span>'
            f'<button class="nf" style="height:36px;padding:0 12px;border-radius:6px;border:1px solid {T["input"]};background:{T["raised"]};font-size:12.5px">Retry</button></section>')


def timeline(items, pad_top=14, fade_top=False):
    fade = f'<div class="abs" style="left:0;right:0;top:0;height:28px;background:linear-gradient({T["chrome"]},transparent);z-index:1"></div>' if fade_top else ''
    return (f'<main role="log" aria-label="Conversation" class="rel col f1" style="min-height:0;overflow:hidden;justify-content:flex-end">{fade}'
            f'<div class="col" style="padding:{pad_top}px 16px 12px;gap:14px">{"".join(items)}</div></main>')


# ---------------- composer (Claude: text only, Send or Stop) ----------------
SEND = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"/></svg>'
STOP = '<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2.5" fill="currentColor"/></svg>'


def chat_foot(mode='send', exp='Typing is on until 21:40', hint=None, placeholder='Message Agent 1…'):
    """mode: send (idle), stop (working), locked (a native prompt is open: answer it above), off (typing off)."""
    if mode == 'off':
        stop = (f'<button aria-label="Stop" class="row nf" style="height:44px;padding:0 14px;gap:8px;border-radius:10px;border:1px solid {T["input"]};background:{T["raised"]};font-size:14px">{STOP}Stop</button>')
        return (f'<footer class="row nf" style="gap:12px;padding:12px 16px 34px;border-top:1px solid {T["border"]}">'
                f'<span class="f1" style="font-size:13.5px;line-height:1.4">Read-only here. Typing is off for this phone.</span>{stop}</footer>')
    locked = mode == 'locked'
    btn_style = 'width:44px;height:44px;justify-content:center;border-radius:10px'
    if mode == 'stop':
        btn = f'<button type="button" aria-label="Stop Agent 1" class="row nf" style="{btn_style};border:1px solid {T["input"]};background:{T["raised"]};color:{T["foreground"]}">{STOP}</button>'
    else:
        btn = (f'<button type="button" aria-label="Send"{" disabled" if locked else ""} class="row nf" style="{btn_style};'
               f'background:{T["raised"] if locked else T["solid"]};color:{T["dim"] if locked else T["solid_fg"]}">{SEND}</button>')
    ph = 'Answer the prompt above first' if locked else placeholder
    top = expiry(hint, amber) if hint else expiry(exp)
    return (top + f'<form class="row nf" style="align-items:flex-end;gap:8px;padding:8px 12px 34px">'
            f'<textarea rows="1"{" disabled" if locked else ""} placeholder="{ph}" style="flex:1;min-height:44px;resize:none;padding:11px 14px;border-radius:10px;'
            f'border:1px solid {T["border"] if locked else T["input"]};background:{T["background"]};color:{T["foreground"]};font:inherit;font-size:15px"></textarea>{btn}</form>')


def text_foot():
    """Unsupported harnesses: today's footer, key bar and Keys menu unchanged."""
    return expiry('Typing is on until 21:40') + keybar() + composer()


# ---------------- native prompt cards ----------------
def card(kind_label, title, body, opts, foot='', tone=amber, dim=False, aria='Prompt'):
    edge = T['dim'] if dim else tone
    return (f'<section aria-label="{aria}" class="rel col" style="padding:12px 12px 12px 14px;gap:10px;border-radius:10px;'
            f'background:{T["background"] if dim else mix(tone, .055)};border:1px solid {T["border"] if dim else mix(tone, .22)}{";opacity:.55" if dim else ""}">'
            f'<span class="abs" style="left:0;top:0;bottom:0;width:2px;border-radius:9px 0 0 9px;background:{edge}"></span>'
            f'<div class="row" style="gap:8px"><span class="mono" style="font-size:11px;padding:1px 6px;border-radius:4px;background:{T["raised"]};color:{T["muted"]}">{kind_label}</span>'
            f'<span class="f1"></span></div>'
            f'<div style="font-size:15px;font-weight:600;line-height:1.35">{title}</div>{body}'
            f'<div class="col" style="gap:6px">{opts}</div>{foot}</section>')


def choice(label, sub=None, sel=False, primary=False, mark=None, warn=False):
    bd = T['accent'] if sel else T['border']
    bg = T['solid'] if primary else T['raised']
    fg = T['solid_fg'] if primary else (red if warn else T['foreground'])
    m = f'<span class="nf row" style="width:18px;justify-content:center">{mark}</span>' if mark is not None else ''
    s = f'<span style="font-size:12px;color:{T["solid_fg"] if primary else T["muted"]}">{sub}</span>' if sub else ''
    return (f'<button class="row" style="min-height:46px;padding:7px 12px;gap:10px;border-radius:8px;text-align:left;border:1px solid {bd};background:{bg};color:{fg}">'
            f'{m}<span class="col f1" style="gap:1px"><span style="font-size:14px;font-weight:{500 if primary else 400}">{label}</span>{s}</span></button>')


def cmd_box(text):
    return (f'<div class="mono" style="padding:8px 10px;border-radius:7px;background:{T["chrome"]};border:1px solid {T["border"]};font-size:12.5px;line-height:1.45;white-space:pre-wrap">{text}</div>')


def radio(on):
    return (f'<span class="nf" style="width:16px;height:16px;border-radius:8px;border:1.5px solid {T["accent"] if on else T["input"]};'
            f'display:inline-flex;align-items:center;justify-content:center">{"<span style=\"width:8px;height:8px;border-radius:4px;background:" + T["accent"] + "\"></span>" if on else ""}</span>')


def check(on):
    return (f'<span class="nf" style="width:16px;height:16px;border-radius:4px;border:1.5px solid {T["accent"] if on else T["input"]};background:{T["accent"] if on else "transparent"};'
            f'display:inline-flex;align-items:center;justify-content:center;color:{T["solid_fg"]};font-size:11px;font-weight:700">{"✓" if on else ""}</span>')


def other_field(text=''):
    return (f'<div class="row" style="gap:10px;min-height:46px;padding:0 12px;border-radius:8px;border:1px solid {T["border"]};background:{T["raised"]}">'
            f'<span class="f1" style="font-size:14px;color:{T["muted"] if not text else T["foreground"]}">{text or "Other: type your own answer…"}</span></div>')


def checked_line(text):
    return f'<div class="row" style="gap:6px;font-size:12px;color:{T["dim"]}">{tile("done", 14)}<span>{text}</span></div>'


def perm_card(dim=False):
    body = (f'<div class="col" style="gap:6px"><div class="row" style="gap:6px;font-size:12.5px;color:{T["muted"]}"><span class="mono" style="color:{T["dim"]}">⏺</span>Shell command</div>'
            + cmd_box('cargo test -p parser') + '</div>')
    opts = (choice('Yes', primary=True)
            + choice('Yes, and don’t ask again for: cargo test *')
            + choice('No', sub='Then tell Agent 1 what to do instead'))
    return card('PERMISSION', 'Allow this command?', body, opts, dim=dim, aria='Permission request')


def ask_single():
    opts = (choice('Option A', 'First test choice', sel=True, mark=radio(True)) + choice('Option B', 'Second test choice', mark=radio(False))
            + choice('Option C', 'Third test choice', mark=radio(False)) + other_field())
    foot = (f'<div class="row" style="gap:8px"><button class="row f1" style="height:44px;justify-content:center;border-radius:7px;background:{T["solid"]};color:{T["solid_fg"]};font-size:14px;font-weight:500">Answer</button>'
            f'<button class="row nf" style="height:44px;padding:0 14px;border-radius:7px;color:{T["muted"]};font-size:14px">Skip</button></div>')
    return card('QUESTION', 'Question Text 345: pick one option.', '', opts, foot, tone=T['accent'], aria='Question from Agent 1')


def ask_multi():
    tabs = (f'<div class="row" style="gap:6px;font-size:12px"><span style="padding:3px 8px;border-radius:5px;background:{T["selected"]}">1 · Area</span>'
            f'<span style="padding:3px 8px;border-radius:5px;color:{T["muted"]}">2 · Order</span><span class="f1"></span><span style="color:{T["dim"]}">1 of 2</span></div>')
    opts = (choice('Option A', 'First test choice', sel=True, mark=check(True)) + choice('Option B', 'Second test choice', mark=check(False))
            + choice('Option C', 'Third test choice', sel=True, mark=check(True)) + other_field())
    foot = (f'<div class="row" style="gap:8px"><button class="row f1" style="height:44px;justify-content:center;border-radius:7px;background:{T["solid"]};color:{T["solid_fg"]};font-size:14px;font-weight:500">Next: 2 picked</button>'
            f'<button class="row nf" style="height:44px;padding:0 14px;border-radius:7px;color:{T["muted"]};font-size:14px">Skip</button></div>')
    return card('QUESTION', 'Question Text 346: pick all that apply.', tabs, opts, foot, tone=T['accent'], aria='Question from Agent 1')


def plan_card():
    plan = (f'<div class="rel" style="max-height:132px;overflow:hidden;padding:10px 12px;border-radius:8px;background:{T["chrome"]};border:1px solid {T["border"]};font-size:13.5px;line-height:1.5">'
            f'<div style="font-weight:600">Plan: Parser rewrite</div>'
            f'<ol style="margin:4px 0 0;padding-left:20px"><li>Split {code("parse.rs")} into three passes</li><li>Keep the old entry point as a wrapper</li><li>Add tests for empty input</li><li>Update the docs</li></ol>'
            f'<div class="abs" style="left:0;right:0;bottom:0;height:34px;background:linear-gradient(transparent,{T["chrome"]})"></div></div>'
            f'<button class="row" style="align-self:flex-start;height:32px;font-size:13px;color:{T["accent"]}">Show the whole plan ›</button>')
    opts = (choice('Yes, and use auto mode', primary=True)
            + choice('Yes, manually approve edits')
            + choice('No, keep planning', sub='Tell Agent 1 what to change'))
    return card('PLAN', 'Ready to start?', plan, opts, aria='Plan approval')


def refusal():
    return (f'<div role="alert" class="row" style="align-items:flex-start;gap:10px;padding:10px 12px;border-radius:8px;background:{mix(red, .06)};border:1px solid {mix(red, .28)};font-size:13.5px;line-height:1.45">'
            f'<span class="nf" style="width:7px;height:7px;margin-top:7px;border-radius:4px;background:{red}"></span>'
            f'<span class="col f1" style="gap:2px"><span>The prompt changed. Look again.</span>'
            f'<span style="color:{T["muted"]}">Nothing was pressed.</span></span></div>')


def blocked(text='Waiting for you'):
    return f'<div role="status" class="row" style="gap:8px;font-size:13px;color:{amber}"><span class="nf" style="width:7px;height:7px;border-radius:4px;background:{amber};animation:hd-breathe 1.6s ease-in-out infinite"></span><span>{text}</span></div>'


# ---------------- states ----------------
REPLY = ('I split the parser into three passes and kept the old entry point as a thin wrapper:'
         + ul([f'{code("tokens.rs")} turns text into tokens', f'{code("tree.rs")} builds the tree', 'the old API calls both, so nothing else changes']))
ASK = 'Split the parser into smaller passes and keep the old API working.'


def s_chat():
    items = [day('Today 21:02'), you(ASK), agent(REPLY), tool('Edited 3 files'), tool('Ran 1 shell command'),
             agent('Tests pass: 212 passed, 0 failed. Now updating the docs.', first=False), tool('Reading 2 files', status='run'), working()]
    return head() + timeline(items) + chat_foot('stop')


def s_perm():
    items = [agent('The tokenizer pass is done. Running the parser tests next.'), tool('Edited 2 files'), perm_card()]
    return head(status='blocked') + timeline(items, fade_top=True) + chat_foot('locked')


def s_ask1():
    items = [agent('Before I split the files, one choice:'), ask_single()]
    return head(status='blocked') + timeline(items, fade_top=True) + chat_foot('locked')


def s_askm():
    items = [ask_multi()]
    return head(status='blocked') + timeline(items, fade_top=True) + chat_foot('locked')


def s_plan():
    items = [agent('Here is the plan.'), plan_card()]
    return head(status='blocked') + timeline(items, fade_top=True) + chat_foot('locked')


def s_changed():
    items = [agent('The tokenizer pass is done. Running the parser tests next.'), tool('Edited 2 files'), perm_card(dim=True), refusal()]
    return head(status='working') + timeline(items, fade_top=True) + chat_foot('stop')


def s_stop():
    stopped = (f'<div class="row" style="gap:8px;font-size:13px;color:{T["muted"]}"><span class="nf" style="width:7px;height:7px;border-radius:4px;border:1.5px solid {T["idle"]}"></span>'
               f'Stopped by you · 21:14</div>')
    items = [day('Today 21:02'), you(ASK), agent(REPLY), tool('Edited 3 files'), tool('Ran 1 shell command'),
             agent('Tests pass: 212 passed, 0 failed. Now updating the docs.', first=False), tool('Read 2 files'), stopped]
    return head(status='idle') + timeline(items) + chat_foot('send')


def s_history():
    earlier = (f'<div class="row" style="justify-content:center"><button class="row" style="height:36px;padding:0 14px;gap:6px;border-radius:18px;border:1px solid {T["border"]};'
               f'background:{T["background"]};font-size:12.5px;color:{T["muted"]}">{spinner(12, T["muted"])}Loading earlier messages…</button></div>')
    items = [earlier, day('Yesterday 18:40'), you('Add a test for the empty input case.'),
             agent('Added it. It failed at first because the tokenizer returned ' + code('None') + ' for an empty string; fixed that too.'),
             tool('Edited 2 files'), tool('Ran 2 shell commands'), agent('Both pass now.', first=False),
             q_answered(), alert(), day('Today 21:02'), you(ASK)]
    jump = (f'<button class="abs row" style="right:16px;bottom:118px;z-index:2;height:40px;padding:0 14px;gap:6px;border-radius:20px;'
            f'background:{T["popover"]};border:1px solid #ffffff1f;box-shadow:0 8px 24px #00000080;font-size:13px">'
            f'<span class="nf" style="width:6px;height:6px;border-radius:3px;background:{T["working"]}"></span>4 new<span style="color:{T["muted"]}">↓</span></button>')
    return head() + timeline(items).replace('justify-content:flex-end', 'justify-content:flex-start') + jump + chat_foot('stop')


def s_off():
    items = [day('Today 21:02'), you(ASK), agent(REPLY), tool('Edited 3 files'), tool('Ran 1 shell command'),
             agent('Tests pass: 212 passed, 0 failed.', first=False), q_open()]
    return head(status='working') + timeline(items, fade_top=True) + chat_foot('off')


def notice(title, body):
    return (f'<div role="status" class="row nf" style="align-items:flex-start;gap:8px;margin:8px 12px 0;padding:10px 12px;border-radius:8px;'
            f'background:{T["background"]};border:1px solid {T["border"]};font-size:13px;line-height:1.4">'
            f'<span class="nf" style="margin-top:1px;color:{T["muted"]}">{CHAT_GLYPH}</span>'
            f'<span class="col f1" style="gap:1px"><span>{title}</span><span style="color:{T["muted"]}">{body}</span></span>'
            f'<button aria-label="Close" class="row nf" style="width:32px;height:32px;margin:-6px -6px 0 0;justify-content:center;color:{T["dim"]}">{icon("x", 13)}</button></div>')


def s_codex():
    n = notice('No chat view for Codex yet', 'This is its terminal, as before.')
    return head(h='codex', name='Agent 3', acct=False, aa=True) + n + chat_term() + text_foot()


def s_new():
    empty = (f'<main class="col f1" style="min-height:0;padding:24px;align-items:center;justify-content:center;gap:8px;text-align:center">'
             f'<span style="color:{T["dim"]};zoom:1.8">{CHAT_GLYPH}</span><span style="font-size:15px;font-weight:500">No messages yet</span>'
             f'<span style="max-width:260px;font-size:13.5px;line-height:1.45;color:{T["muted"]}">New session in ~/code/alpha. What you send appears here.</span></main>')
    return head(status='idle', name='Agent 5', swarm=False) + empty + chat_foot('send', placeholder='Message Agent 5…')


STATES_ = [['chat', 'Working'], ['perm', 'Permission'], ['ask1', 'Ask one'], ['askm', 'Ask many'], ['plan', 'Plan'],
           ['changed', 'Changed'], ['stop', 'Stopped'], ['history', 'History'], ['off', 'Typing off'], ['codex', 'Codex'], ['new', 'New']]


def phone_chat_view():
    fns = dict(chat=s_chat, perm=s_perm, ask1=s_ask1, askm=s_askm, plan=s_plan, changed=s_changed, stop=s_stop,
               history=s_history, off=s_off, codex=s_codex, new=s_new)
    inner = SWITCH2 + ''.join(block(k, 'chat', f'<div class="col" style="height:844px;position:relative">{fns[k]()}</div>') for k, _ in STATES_)
    return ph_page('Phone chat view', inner, switch_script(STATES_, 'chat', ''), css='.ph{position:relative}.ph>sc-if>div{flex:none}')


FILES = {'PhoneChatView': phone_chat_view}

if __name__ == '__main__':
    PDIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..') + '/'
    for k, f in FILES.items():
        open(PDIR + k + '.dc.html', 'w').write(f())
