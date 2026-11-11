# herdr-app desktop chrome at logical px (layouts/panorama.json), drawn 1728x1080 and zoomed to 1440x900
# (the live app's own scale in the reference screenshots: 2400 logical px shown at 2000).
from common import T, DOCK, SURFACE, STATES, icon, badge, tile, gi, harness, spinner, USAGE_ICON, CLOSE12

MARK = {'ansi6': '#22a99a', 'ansi3': '#e3814f', 'ansi4': '#5b8def', 'ansi5': '#8b7cf6', 'ansi2': '#3fae6a', 'ansi1': '#d9649a'}


def btn26(inner, color=T['muted']):
    return f'<span class="row nf" style="width:26px;height:26px;justify-content:center;border-radius:6px;color:{color}">{inner}</span>'


def brand():
    return (f'<div class="row nf" style="height:46px;padding:0 10px 0 14px;gap:4px;font-size:13.5px">'
            f'<span class="row f1" style="gap:8px"><img src="icons/herdr.png" alt="" style="width:20px;height:20px;border-radius:5px;flex:none">'
            f'<span style="font-weight:600;color:{T["foreground"]}">Herdr</span></span>'
            f'{btn26(icon("search", 15))}{btn26(icon("sidebar", 15))}</div>')


def space_row(s):
    tail = ''
    if s.get('where'):
        tail += f'<span class="tr" style="min-width:0">{s["where"]}</span>'
    if s.get('ahead'):
        tail += f'<span class="nf" style="color:{T["ansi2"]}">↑{s["ahead"]}</span>'
    if s.get('behind'):
        tail += f'<span class="nf" style="color:{T["ansi1"]}">↓{s["behind"]}</span>'
    tiles = ''.join(tile(c, 18, n) for c, n in s.get('tiles', []))
    tiles = f'<span class="row nf" style="margin-left:8px;gap:3px">{tiles}</span>' if tiles else ''
    bg = f'background:{T["selected"]};' if s.get('active') else ''
    return (f'<div class="col nf srow" style="height:30px;padding:0 8px;justify-content:center;border-radius:8px;{bg}">'
            f'<div class="row" style="gap:9px">'
            f'<span class="row nf" style="width:18px;height:18px;border-radius:5px;justify-content:center;background:{MARK[s["color"]]};font-size:10.5px;font-weight:700;color:#fff">{s["name"][0].upper()}</span>'
            f'<span class="tr" style="flex-shrink:0;max-width:150px;color:{T["foreground"]};font-size:13px">{s["name"]}</span>'
            f'<span class="row f1" style="gap:5px;justify-content:flex-end;font-size:11.5px;color:{T["dim"]}">{tail}</span>{tiles}</div></div>')


def spaces_block(spaces):
    return (f'<div class="col nf" style="height:143px;background:{T["chrome"]};font-size:13px">'
            f'<div class="row nf" style="height:31px;padding:0 10px 0 16px;justify-content:space-between;font-size:11.5px;color:{T["dim"]}">Spaces{btn26(icon("plus", 14), T["dim"])}</div>'
            f'<div class="col" style="padding:0 8px 14px;gap:4px">{"".join(space_row(s) for s in spaces)}</div></div>')


def seg_lines(segs):
    cls = {'│': 'v', '├': 't', '└': 'e', '': ''}
    return ''.join(f'<span class="seg {cls[s]}"></span>' for s in segs)


def glyph_run(statuses, finished=0):
    order = ['fail', 'blk', 'wait', 'rev', 'run', 'bg', 'q', 'lost', 'stale', 'idle', 'inf', 'cxl', 'done']
    live = sorted([s for s in statuses if s != 'done'], key=order.index)
    done = finished + len(statuses) - len(live)
    out = ''.join(glyph_bare(s) for s in live[:6])
    if done:
        out += (f'<span class="row nf" style="margin-left:2px;font-size:10.5px;font-weight:500;color:{SURFACE["faint"]}">+{done}'
                f'<i class="ckf"></i></span>')
    return f'<span class="row nf" style="gap:2px;margin-left:6px">{out}</span>'


def glyph_bare(code, size=11):
    s = STATES[code]
    if s[5]:
        return f'<i class="gm s-{code}" style="width:{size}px;height:{size}px"></i>'
    return f'<span class="nf" style="width:{size}px;font-size:{size}px;font-weight:700;color:{s[2]};text-align:center;line-height:1">{"?" if code == "wait" else s[1]}</span>'


def tree_row(r):
    boxed = len(r['segs']) == 1
    mark = tile(r['st'], 16, r.get('count')) if boxed else glyph_bare(r['st'])
    color = DOCK['hi'] if r['st'] in ('wait', 'blk', 'fail') else (SURFACE['dim'] if r.get('summary') else DOCK['fg'])
    run = glyph_run(r.get('run', []), r.get('fin', 0)) if not r.get('summary') else ''
    return (f'<div class="trow">{seg_lines(r["segs"])}<span class="gl{" box" if boxed else ""}">{mark}</span>'
            f'<span class="f1 tr" style="color:{color}">{r["title"]}</span>{run}</div>')


def root_card(c):
    st = c['st']
    marks = (tile('wait', 16, c['q']) if c.get('q') and st != 'wait' else '') + badge(st, questions=c.get('q'), h=17)
    tiles = ''.join(tile(code, 16, n) for code, n in c.get('tiles', []))
    quiet = c.get('docked') and c.get('rows')
    bare = quiet or not tiles
    tail_tiles = f'<span class="ptiles">{tiles}</span>' if tiles and not quiet else ''
    rows = c.get('rows') or []
    joined = bool(rows)
    num = c.get('n', '')
    card = (f'<div class="pcard s-{st}{" docked" if c.get("docked") else ""}{" joined" if joined else ""}{" hov" if c.get("hover") else ""}">'
            f'<div class="pfill"><div class="phead"><span class="pnum">{num}</span><span class="nf" style="margin-right:8px;display:flex">{harness(c.get("h", "claude"))}</span>'
            f'<span class="ptitle">{c["title"]}</span><span class="pmarks">{marks}</span></div>'
            f'<div class="ptail{" bare" if bare else ""}">{tail_tiles}<span class="pmeta">{c["meta"]}</span></div></div>'
            + ('<span class="abs" style="left:37.25px;top:23px;bottom:0;width:1.5px;background:#ffffff24"></span>' if joined else '') + '</div>')
    sweep = '<div class="psweep"><div class="w"><div class="o"></div></div></div>'
    if not joined:
        return f'<div class="pwrap s-{st}">{card}{sweep if c.get("sweep") else ""}</div>'
    out = f'<div class="pwrap s-{st}" style="height:52px">{card}</div>'
    for i, r in enumerate(rows):
        last = i == len(rows) - 1
        cls = f'prow s-{st}{" docked" if c.get("docked") else ""}{" last" if last else ""}'
        inner = f'<div class="{cls}"><div class="pf">{tree_row(r)}</div></div>'
        out += f'<div class="rel nf">{inner}{sweep if last and c.get("sweep") else ""}</div>' if last else inner
    return out


def agents_panel(groups, totals='', scope='All spaces', grouped=True):
    head = (f'<div class="row nf" style="height:41px;padding:14px 16px 5px;justify-content:space-between">'
            f'<span class="row" style="gap:6px"><span style="font-size:11.5px;font-weight:500;color:{T["dim"]}">Agents</span>'
            f'<span class="row" style="height:18px;padding:0 5px;border-radius:4px;font-size:11px;color:{T["foreground"]}">{scope}</span></span>'
            f'<span class="row" style="gap:8px"><span class="row" style="margin-right:2px;gap:7px;font-size:11px;font-weight:700;color:{DOCK["need"]}">{totals}</span>'
            f'<span style="color:{T["dim"]};display:flex">{icon("layers" if grouped else "clock", 14)}</span></span></div>')
    body = ''
    for gi_, g in enumerate(groups):
        top = gi_ == 0
        body += (f'<div class="row nf" style="height:{20 if top else 26}px;padding:{2 if top else 8}px 2px 0 4px;gap:6px;font-size:11px;font-weight:500">'
                 f'<span class="tr" style="color:{g.get("tone", T["dim"])}">{g["label"]}</span><span style="color:{DOCK["number"]}">{len(g["cards"])}</span></div>')
        body += ''.join(root_card(c) for c in g['cards'])
    body += (f'<div class="row nf" style="margin-top:12px;height:24px;padding:0 10px 0 6px;border-radius:6px">'
             f'<span class="nf" style="width:14px;margin-right:8px;text-align:right;font-size:13px;font-weight:700;color:{SURFACE["key"]}">+</span>'
             f'<span class="f1" style="font-size:12.5px;color:{SURFACE["dim"]}">New agent</span><span style="font-size:11px;color:{DOCK["number"]}">n</span></div>')
    return (f'<div class="col f1" style="min-height:0;background:{T["chrome"]};border-top:1px solid {T["border"]};font-size:13px">{head}'
            f'<div class="col f1" style="min-height:0;overflow:hidden;padding:0 8px">{body}</div></div>')


def sidebar_footer():
    return (f'<div class="col nf" style="height:69px;border-top:1px solid {T["border"]};padding:4px 8px 8px;font-size:13px">'
            f'<div class="row" style="height:28px;padding:0 8px;gap:9px;border-radius:8px;color:{T["muted"]}">{icon("settings", 14)}Settings<span class="nf" style="width:6px;height:6px;border-radius:3px;background:{T["accent"]}"></span></div>'
            f'<div class="row" style="height:28px;padding:0 8px;gap:9px;border-radius:8px;color:{T["dim"]}">{icon("plus", 14)}Add machine</div></div>')


def sidebar(spaces, groups, totals=''):
    return (f'<aside class="col nf" style="width:320px;height:100%;background:{T["chrome"]}">{brand()}'
            f'<div class="col f1" style="min-height:0">{spaces_block(spaces)}{agents_panel(groups, totals)}</div>{sidebar_footer()}</aside>')


def swarm_glyph(needs=True, working=True, done=False):
    sq = lambda c: f'<span style="width:5px;height:5px;border-radius:1.5px;background:{c}"></span>'
    return (f'<span class="col nf" style="gap:2px"><span class="row" style="gap:2px">{sq(T["blocked"] if needs else T["dim"])}{sq(T["working"] if working else T["dim"])}</span>'
            f'<span class="row" style="gap:2px">{sq(T["dim"])}{sq(T["done"] if done else T["dim"])}</span></span>')


def count_chip(n):
    return f'<span class="row nf" style="height:16px;min-width:16px;padding:0 4px;border-radius:4px;justify-content:center;font-size:10.5px;font-weight:700;background:{T["blocked"]}2b;color:{T["blocked"]}">{n}</span>'


def tab(t):
    on = t.get('active')
    lead = swarm_glyph(**t.get('glyph', {})) if t.get('swarm') else harness(t.get('h', 'claude'), 14)
    trail = ''
    if t.get('swarm') and t.get('needs'):
        trail += count_chip(t['needs'])
    if not t.get('swarm') and t.get('status') == 'working':
        trail += spinner(12)
    if not t.get('swarm') and t.get('status') in ('blocked', 'done'):
        trail += f'<span class="nf" style="width:6px;height:6px;border-radius:3px;background:{T[t["status"]]}"></span>'
    if on:
        trail += f'<span class="nf" style="color:{T["dim"]};display:flex">{CLOSE12}</span>'
    return (f'<div class="row nf" style="height:29px;padding:0 10px;gap:7px;border-radius:7px;font-size:12.8px;border:1px solid {T["border"] if on else T["chrome"]};'
            f'background:{T["raised"] if on else T["chrome"]};color:{T["foreground"] if on else T["muted"]}">{lead}<span class="tr" style="max-width:170px">{t["name"]}</span>{trail}</div>')


def panel_button(label, ic, on):
    return (f'<div class="row nf" style="height:26px;padding:0 8px;gap:5px;border-radius:6px;font-size:12px;background:{T["selected"] if on else T["chrome"]};'
            f'color:{T["foreground"] if on else T["muted"]}">{ic}{label}</div>')


def tabbar(tabs, panel='usage', remote=None):
    icons = {'files': icon('file', 14), 'changes': icon('changes', 14), 'usage': USAGE_ICON}
    right = btn26('<span style="font-size:15px">+</span>', T['dim'])
    right += panel_button('Files', icons['files'], panel == 'files') + panel_button('Changes', icons['changes'], panel == 'changes') + panel_button('Usage', icons['usage'], panel == 'usage')
    if remote:
        right += panel_button('Remote', f'<span class="nf" style="width:7px;height:7px;border-radius:4px;background:{remote}"></span>', panel == 'remote')
    right += btn26('<span style="font-size:14px">−</span>', T['dim']) + btn26('<span style="font-size:13px">□</span>', T['dim']) + btn26(icon('x', 13), T['dim'])
    return (f'<div class="row nf" style="height:42px;padding:0 10px;gap:3px;background:{T["chrome"]};border-bottom:1px solid {T["border"]}">'
            f'<div class="row f1" style="gap:3px;height:100%;overflow:hidden">{"".join(tab(t) for t in tabs)}</div>{right}</div>')


def statusbar(branch='main', agents=7, needs=0, right=None):
    lab = lambda ic, text: f'<span class="row" style="gap:6px">{icon(ic, 13)}{text}</span>'
    need = f'<span style="color:{T["blocked"]}">· {needs} needs you</span>' if needs else ''
    return (f'<div class="row nf" style="height:28px;padding:0 14px;gap:16px;background:{T["chrome"]};border-top:1px solid {T["border"]};font-size:11.8px;color:{T["muted"]}">'
            f'{lab("monitor", "This computer")}{lab("branch", branch) if branch else ""}'
            f'<span class="row" style="gap:6px"><span style="width:6px;height:6px;border-radius:3px;background:{T["dim"]}"></span>{agents} agents{need}</span>'
            f'<span class="f1"></span>{right or ""}<span style="color:{T["dim"]}">Ctrl+Shift+P  commands</span></div>')


def pane(header, body, focused=True, extra=''):
    return (f'<section class="col f1" style="min-width:0;min-height:0;border-radius:10px;background:{T["background"]};border:1px solid {T["accent"] if focused else T["border"]};overflow:hidden{extra}">'
            f'<div class="row nf" style="height:30px;padding:0 10px;gap:8px;font-size:12px;background:{T["background"]};border-bottom:1px solid {T["border"]}">{header}</div>{body}</section>')


def term_header(name, folder, status=None, h='claude'):
    tail = spinner(12) if status == 'working' else ''
    if status == 'blocked':
        tail = f'<span class="row nf" style="height:18px;padding:0 6px;border-radius:5px;background:{T["blocked"]}26;font-size:10.5px;font-weight:600;color:{T["blocked"]}">Needs you</span>'
    if status == 'done':
        tail = f'<span class="nf" style="width:7px;height:7px;border-radius:4px;background:{T["done"]}"></span>'
    return (f'{harness(h, 14)}<span class="nf tr" style="max-width:260px;font-weight:500;color:{T["foreground"]}">{name}</span>'
            f'<span class="f1 tr" style="color:{T["dim"]}">{folder}</span>{tail}')


def swarm_header(space, roots, agents, questions=1):
    chip = (f'<span class="row nf" style="margin-left:6px;height:16px;min-width:16px;padding:0 4px;border-radius:4px;justify-content:center;font-size:10.5px;font-weight:700;'
            f'background:{T["blocked"]}2b;color:{T["blocked"]}">?{questions}</span>') if questions else ''
    return (f'{swarm_glyph()}<span style="font-weight:500;color:{T["foreground"]}">Swarm</span>'
            f'<span class="f1 tr" style="color:{T["dim"]}">{space} · {roots} roots · {agents} agents</span>{chip}{spinner(12, extra=";margin-left:8px;margin-right:1px")}')


def frame(side, tabs_html, main_html, panel_html='', status_html=''):
    """The whole window: 1728x1080 logical, zoomed to the 1440x900 artboard."""
    panel = f'<div class="col nf" style="width:368px;min-height:0">{panel_html}</div>' if panel_html else ''
    return (f'<div class="hd" style="width:1440px;height:900px;overflow:hidden;background:{T["canvas"]}">'
            f'<div class="row" style="width:1728px;height:1080px;zoom:0.833333;align-items:stretch;background:{T["canvas"]};font-size:13px">'
            f'{side}<div class="nf" style="width:1px;background:{T["border"]}"></div>'
            f'<div class="col f1" style="min-height:0">{tabs_html}'
            f'<div class="row f1" style="min-height:0;align-items:stretch;padding:8px;gap:8px">{main_html}{panel}</div>{status_html}</div></div></div>')


# ---------- Agent Usage panel ----------
def usage_account(p, grouped):
    bands = {'high': T['ansi2'], 'mid': T['ansi3'], 'low': T['ansi1']}
    stale = p.get('stale')
    rows = ''
    if grouped:
        plan = f'<span style="color:{T["muted"]}">· {p["plan"]}</span>' if p.get('plan') else ''
        rows += (f'<div class="row" style="height:26px;gap:5px;font-size:12.5px"><span style="font-weight:500">{p["name"]}</span>{plan}<span class="f1"></span>'
                 f'<span class="tr" style="max-width:240px;font-size:11px;color:{T["dim"]}">{p["hint"]}</span></div>')
    for w in p['windows']:
        band = bands[w['band']]
        rows += (f'<div class="row" style="height:22px;gap:8px{";opacity:.45" if stale else ""}">'
                 f'<span class="mono nf" style="width:24px;font-size:11.5px;color:{T["muted"]}">{w["tag"]}</span>'
                 f'<span class="ubar" style="background:{band}26"><i style="width:{w["fill"]}%;background:{band}"></i></span>'
                 f'<span class="nf" style="width:62px;text-align:right;font-size:12px;color:{band}">{w["pct"]}% left</span>'
                 f'<span class="nf" style="width:54px;text-align:right;font-size:11.5px;color:{T["dim"]}">{w["reset"]}</span></div>')
        if w.get('runout'):
            rows += f'<div class="row" style="padding-left:32px;height:20px;font-size:11.5px;color:{T["ansi1"]}">⚠️ {w["runout"]}</div>'
    rows += f'<div style="padding:2px 0;font-size:11px;color:{T["ansi3"] if stale else T["dim"]}">{p["meta"]}</div>'
    return f'<div class="col" style="padding-left:25px{";padding-top:4px" if grouped else ""}">{rows}</div>'


def usage_group(g, index):
    grouped = len(g['members']) > 1
    plan = '' if grouped or not g['members'][0].get('plan') else f'<span style="color:{T["muted"]}">· {g["members"][0]["plan"]}</span>'
    right = f'{len(g["members"])} accounts' if grouped else g['members'][0]['hint']
    head = (f'<div class="row" style="height:34px;gap:9px">{harness(g["icon"])}<span style="font-weight:600">{g["name"]}</span>{plan}<span class="f1"></span>'
            f'<span class="tr" style="max-width:240px;font-size:{12 if grouped else 11}px;color:{T["dim"]}">{right}</span></div>')
    border = f';border-top:1px solid {T["border"]}' if index else ''
    return f'<div class="col" style="padding:6px 14px 10px{border}">{head}{"".join(usage_account(p, grouped) for p in g["members"])}</div>'


def usage_panel(groups, updated='Updated 11:15 · every 15s', all_=True):
    count = sum(len(g['members']) for g in groups)
    seg = lambda label, on: (f'<span class="row useg" style="height:22px;padding:0 8px;border-radius:5px;font-size:12px;background:{T["raised"] if on else T["background"]};'
                             f'border:1px solid {T["border"] if on else T["background"]};color:{T["foreground"] if on else T["muted"]}">{label}</span>')
    head = (f'<div class="row nf uhead" style="height:42px;padding:0 14px;gap:8px;border-bottom:1px solid {T["border"]}"><span style="font-weight:600">Agent Usage</span>'
            f'<span style="padding:1px 5px;border-radius:4px;border:1px solid {T["border"]};font-size:10px;color:{T["muted"]}">{count} accounts</span><span class="f1"></span>'
            f'<span class="row" style="padding:2px;gap:2px;border-radius:7px;background:{T["chrome"]}">{seg("Open panes", not all_)}{seg("All", all_)}</span></div>')
    fseg = lambda label, on: f'<span class="row ufseg" style="height:20px;padding:0 6px;border-radius:5px;font-size:11px;color:{T["foreground"] if on else T["dim"]};{"background:" + T["raised"] if on else ""}">{label}</span>'
    foot = (f'<div class="row nf ufoot" style="height:40px;padding:0 14px;gap:8px;border-top:1px solid {T["border"]};font-size:11.5px;color:{T["dim"]}">'
            f'<span class="f1 tr">{updated}</span><span class="row" style="gap:1px">{fseg("Full", True)}{fseg("Compact", False)}</span>'
            f'<span class="row ubtn" style="height:26px;padding:0 10px;gap:6px;border-radius:7px;background:{T["raised"]};font-size:12px;color:{T["foreground"]}">Refresh'
            f'<span class="mono" style="font-size:11px;color:{T["dim"]}">r</span></span></div>')
    body = ''.join(usage_group(g, i) for i, g in enumerate(groups))
    return (f'<section class="col upanel" style="height:100%;border-radius:10px;overflow:hidden;background:{T["background"]};border:1px solid {T["border"]};color:{T["foreground"]};font-size:13px">'
            f'{head}<div class="col f1" style="min-height:0;overflow:hidden">{body}</div>{foot}</section>')


USAGE_GROUPS = [
    {'name': 'Claude', 'icon': 'claude', 'members': [
        {'name': 'claude-1', 'hint': 'user-1@example.com', 'meta': 'claude statusLine cache · updated just now',
         'windows': [{'tag': '7d', 'band': 'low', 'fill': 15, 'pct': 15, 'reset': '2d 12h', 'runout': 'empty in ~18h 56m'}]},
        {'name': 'claude-2', 'hint': 'user-2@example.com · also claude', 'meta': 'claude statusLine cache via claude · updated 1m ago',
         'windows': [{'tag': '7d', 'band': 'high', 'fill': 99, 'pct': 99, 'reset': '6d 20h'}]},
        {'name': 'claude-3', 'hint': 'user-3@example.com', 'stale': True, 'meta': 'stale ~1315m ago · claude statusLine cache',
         'windows': [{'tag': '7d', 'band': 'low', 'fill': 0, 'pct': 0, 'reset': '1d 9h', 'runout': 'empty in ~&lt;1m'}]},
    ]},
    {'name': 'Codex', 'icon': 'codex', 'members': [
        {'name': 'codex', 'plan': 'Pro', 'hint': '~/.codex', 'stale': True, 'meta': 'stale ~840m ago · codex rollout',
         'windows': [{'tag': '7d', 'band': 'high', 'fill': 100, 'pct': 100, 'reset': ''}]},
    ]},
]

# ---------- the shared sample workspace (fake data) ----------
SPACES = [
    {'name': 'Project Alpha', 'color': 'ansi6', 'active': True, 'where': 'alpha-core', 'behind': 12, 'tiles': [('wait', 1), ('run', None)]},
    {'name': 'Project Beta', 'color': 'ansi3', 'where': '(detached)', 'tiles': [('run', None)]},
    {'name': 'Sandbox', 'color': 'ansi4', 'tiles': [('run', None)]},
]


def groups(docked=None):
    """The Panorama agents list, All spaces, grouped by space. `docked` opens that card (focused tab)."""
    a1 = {'n': 2, 'title': 'Agent 1 · Parser rewrite', 'st': 'run', 'q': 1, 'tiles': [('run', None), ('run', None), ('done', None)],
          'meta': 'Project Alpha · tab 2 · 2 active · 3 agents', 'sweep': True}
    if docked == 'a1':
        a1.update(docked=True, rows=[
            {'segs': ['├'], 'st': 'run', 'title': 'Explore · token passes'},
            {'segs': ['├'], 'st': 'done', 'title': 'Plan · split strategy', 'run': ['run', 'run']},
            {'segs': ['└'], 'st': 'done', 'summary': True, 'title': '1 finished · Docs · README pass'},
        ])
    return [
        {'label': 'Project Alpha', 'cards': [
            a1,
            {'n': 3, 'title': 'Agent 2 · Test cleanup', 'st': 'run', 'meta': 'Project Alpha · tab 3 · 0 active · 0 agents'},
            {'n': 4, 'title': 'Agent 3 · Docs pass', 'st': 'idle', 'tiles': [('done', 2)], 'meta': 'Project Alpha · tab 4 · 0 active · 0 agents'},
        ]},
        {'label': 'Project Beta', 'cards': [
            {'n': 3, 'title': 'Agent 4 · Release notes', 'st': 'run', 'tiles': [('run', None), ('run', None), ('done', 5)], 'meta': 'Project Beta · tab 3 · 2 active · 2 agents', 'sweep': True},
            {'n': 2, 'title': 'Agent 5 · API client', 'st': 'run', 'h': 'codex', 'tiles': [('run', None), ('run', None), ('rev', None), ('done', 2)], 'meta': 'Project Beta · tab 2 · 3 active · 4 agents', 'sweep': True},
            {'n': 4, 'title': 'Agent 6 · Changelog', 'st': 'idle', 'meta': 'Project Beta · tab 4 · 0 active · 0 agents'},
        ]},
        {'label': 'Sandbox', 'cards': [
            {'n': 6, 'title': 'Agent 7 · Spike', 'st': 'run', 'tiles': [('rev', None), ('done', 3)], 'meta': 'Sandbox · tab 6 · 1 active · 2 agents', 'sweep': True},
        ]},
    ]


TABS_SWARM = [
    {'swarm': True, 'name': 'Swarm', 'active': True, 'needs': 1},
    {'name': 'Agent 1 · Parser rewrite', 'status': 'working'},
    {'name': 'Agent 2 · Test cleanup', 'status': 'working'},
    {'name': 'Agent 3 · Docs pass'},
]
TABS_AGENT1 = [
    {'swarm': True, 'name': 'Swarm', 'needs': 1},
    {'name': 'Agent 1 · Parser rewrite', 'status': 'working', 'active': True},
    {'name': 'Agent 2 · Test cleanup', 'status': 'working'},
    {'name': 'Agent 3 · Docs pass'},
]
