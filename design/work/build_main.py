from common import T, page, badge, tile, harness
import desktop as D

W, GAP = 272, 36


def gcard(c):
    st, cls = c['st'], 'gcard s-' + c['st'] + (' sel' if c.get('sel') else '') + (' path' if c.get('path') else '')
    over = ''
    if c.get('pulse'):
        over += '<span class="gpulse"></span>'
    if c.get('sweep'):
        over += '<span class="gsweep"><i></i></span>'
    ring = '<span class="ring"></span>' if c.get('sel') else ''
    if c.get('fold'):
        body = f'<div class="gfold">{tile("done", 16, still=True)}<span class="l">{c["title"]}</span></div>'
        return f'<div class="{cls}" style="top:{c["y"]}px;height:40px"><span class="edge"></span>{body}{over}</div>'
    marks = (tile('wait', 18, c['q']) if c.get('q') and st != 'wait' else '') + badge(st, questions=c.get('q'))
    body = (f'<div class="gbody"><div class="gtop">{harness(c.get("h", "claude"))}<span class="gtitle">{c["title"]}</span>'
            f'<span class="row nf" style="gap:3px">{marks}</span></div>')
    if c.get('details'):
        body += '<div class="gdet">' + ''.join(f'<div class="gd"><span class="k">{k}</span><span class="v">{v}</span></div>' for k, v in c['details']) + '</div>'
        body += ('<div class="gacts"><span class="gbtn pri">Peek ⏎</span><span class="gbtn">Transcript t</span>'
                 f'<span class="gbtn{"" if c.get("answer") else " off"}">Answer a</span></div>')
    else:
        body += f'<div class="gline"><span class="gact">{c["act"]}</span><span class="gright">{c["right"]}</span></div>'
    body += '</div>'
    return f'<div class="{cls}" style="top:{c["y"]}px;height:{c.get("h_", 54)}px">{ring}<span class="edge"></span>{body}{over}</div>'


COLS = [
    [  # depth 0: the space's root sessions
        {'y': 0, 'st': 'run', 'title': 'Agent 1 · Parser rewrite', 'q': 1, 'path': True, 'pulse': True, 'sweep': True, 'act': 'running', 'right': 'tab 2 · &lt;1m'},
        {'y': 64, 'st': 'run', 'title': 'Agent 2 · Test cleanup', 'act': 'running', 'right': 'tab 3 · 14m'},
        {'y': 128, 'st': 'idle', 'title': 'Agent 3 · Docs pass', 'act': 'idle', 'right': 'tab 4 · 14m'},
    ],
    [  # depth 1: Agent 1's subagents
        {'y': 0, 'h_': 125, 'st': 'run', 'title': 'Explore · token passes', 'sel': True, 'sweep': True,
         'details': [('agent', 'Explore a1b2c3d4e5f6 · opus · &lt;1m · 42 calls'), ('now', 'Read src/parse/tokens.rs')]},
        {'y': 135, 'st': 'done', 'title': 'Plan · split strategy', 'act': 'finished', 'right': 'sonnet · 5m'},
        {'y': 199, 'fold': True, 'st': 'done', 'title': '1 finished · Docs · README pass'},
    ],
    [  # depth 2
        {'y': 135, 'st': 'run', 'title': 'Explore · lexer edge cases', 'sweep': True, 'act': 'Bash(cargo test lexer::edge…)', 'right': '› 1'},
        {'y': 199, 'st': 'run', 'title': 'Explore · old fixtures', 'sweep': True, 'act': 'Grep(fixture_*)', 'right': 'opus · &lt;1m'},
    ],
]


def line(x, y, w, h, hi=False):
    return f'<span class="gline-c{" hi" if hi else ""}" style="left:{x}px;top:{y}px;width:{max(1.5, w)}px;height:{max(1.5, h)}px"></span>'


def connectors():
    out = ''
    # depth 1 group under Agent 1 (parent mid 27); the selected card is on the path
    from_, spine, child = W, W + GAP - 18, W + GAP
    ys = [27, 135 + 27, 199 + 20]
    out += line(from_, 27, spine - from_, 1.5, True) + line(spine, min(ys + [27]), 1.5, max(ys) - 27)
    out += ''.join(line(spine, y, child - spine, 1.5, i == 0) for i, y in enumerate(ys))
    # depth 2 group under Plan · split strategy (y 135, mid 27)
    x1 = W + GAP
    from_, spine, child = x1 + W, x1 + W + GAP - 18, 2 * (W + GAP)
    ys = [162, 199 + 27]
    out += line(from_, 162, spine - from_, 1.5) + line(spine, 162, 1.5, max(ys) - 162)
    out += ''.join(line(spine, y, child - spine, 1.5) for y in ys)
    return out


def graph():
    dim, fg = T['dim'], T['foreground']
    labels = ''.join(f'<span class="row abs" style="left:{i * (W + GAP)}px;width:{W}px;height:24px;gap:6px;font-size:11.5px">'
                     f'<span style="font-weight:500;color:{dim}">Depth {i}</span><span style="color:{dim}">{n}</span></span>'
                     for i, n in enumerate([3, 3, 2]))
    cols = ''.join(f'<div class="abs" style="left:{i * (W + GAP)}px;top:0;bottom:0;width:{W}px">{"".join(gcard(c) for c in col)}</div>' for i, col in enumerate(COLS))
    fade = f'<span class="abs" style="right:0;top:0;bottom:0;width:26px;background:linear-gradient(to left,{T["background"]},{T["background"]}00)"></span>'
    hints = ''.join(f'<span>{h}</span>' for h in ['↑↓ move', '→ open', '← back', 'shift+wheel scroll', '⏎ pane / peek', 'a answer', 'i inbox'])
    return (f'<div class="col f1" style="min-height:0;padding:10px 16px 8px;background:{T["background"]}">'
            f'<div class="row nf" style="height:22px;font-size:11.5px"><span class="f1"></span><span style="color:{dim}">depth 3 · 1 column right ›</span></div>'
            f'<div class="rel nf" style="height:24px">{labels}</div>'
            f'<div class="rel f1" style="min-height:0;overflow:hidden">{connectors()}{cols}{fade}</div>'
            f'<div class="rel nf" style="height:6px;margin:6px 0;border-radius:3px;background:{fg}0a"><span class="abs" style="left:0;top:0;bottom:0;width:74.25%;border-radius:3px;background:{fg}33"></span></div>'
            f'<div class="row nf" style="height:22px;gap:16px;font-size:11.5px;color:{dim}">{hints}</div></div>')


def build():
    side = D.sidebar(D.SPACES, D.groups(), totals='<span>?1</span>')
    main = D.pane(D.swarm_header('Project Alpha', 3, 7), graph())
    body = D.frame(side, D.tabbar(D.TABS_SWARM), main, D.usage_panel(D.USAGE_GROUPS), D.statusbar('main', 7))
    script = 'class Component extends DCLogic {\n  renderVals() { return {}; }\n}'
    return page('Desktop Panorama layout', (1440, 900), body, script)
