# Shared look for the herdr-app-remote design files, taken from the installed herdr-app mods
# (panorama/state.js, panorama/main.js, panorama-graph/cards.js, agent-usage/main.js, ...).
import urllib.parse

T = dict(  # theme() of the default dark theme, sampled from the live app
    chrome='#101114', canvas='#131518', background='#17191d', border='#ffffff14', hover='#ffffff0e',
    selected='#ffffff17', raised='#2c2e31', popover='#1c1d20', input='#ffffff24', foreground='#eeeeef',
    muted='#98999b', dim='#696a6d', accent='#96b2d7', working='#e5c07b', blocked='#f0705f', done='#76a8ff',
    idle='#65696f', ansi1='#e0888f', ansi2='#a6bd91', ansi3='#d1bd80', ansi4='#82a6e0', ansi5='#b9a0e2',
    solid='#eeeeef', solid_fg='#17191d', surface='#ffffff0a')
DOCK = dict(fg='#c3c7cd', hi='#eceef1', number='#4d535c', need='#ffb547', fail='#ff6b6b', hover='#1c1e23')
SURFACE = dict(card='#17191d', selectedCard='#1c2026', selected='#b4c8e4', key='#e2cf9c', faint='#666c75', dim='#80868f')

# code: label, text glyph, hue, fill, ink, svg glyph, mute (panorama/state.js STATES)
STATES = {
    'run': ('Running', '↻', '#68c2b5', '#1f625c', '#d8f2ee', 'spin', None),
    'rev': ('Review', '»', '#8eaee6', '#2e4f86', '#dfe8f8', 'review', None),
    'wait': ('Answer', '?', '#ffb547', '#f2a93b', '#1b1203', None, None),
    'blk': ('Permission', '!', '#ffb547', '#f2a93b', '#1b1203', None, None),
    'fail': ('Failed', '×', '#ff6b6b', '#d8363e', '#ffffff', 'x', None),
    'done': ('Done', '✓', '#6c9673', '#2c6b4c', '#e3f2e9', 'check', None),
    'q': ('Queued', '◷', '#8d939d', '#2a2e35', '#d2d6dd', 'ring', None),
    'bg': ('Waiting', '⋯', '#b39ddb', '#3b3159', '#e6def8', 'orbit', None),
    'cxl': ('Cancelled', '−', '#89909b', '#24272c', '#c2c7cf', 'minus', '#80868f'),
    'inf': ('Inferred', '≈', '#8a9a8d', '#26312a', '#c4d3c8', 'check-q', None),
    'lost': ('Lost', '~', '#c08a8a', '#3a2526', '#e0b4b4', 'tilde', None),
    'stale': ('Stale', '◴', '#89909b', '#1b1e23', '#c2c7cf', 'dashed', '#80868f'),
    'idle': ('Idle', '○', '#8d939d', '#23272e', '#c2c7cf', 'ring', None),
}
GLYPHS = {  # mods/panorama/state-*.svg
    'spin': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="C" stroke-width="2.3" stroke-linecap="round"><circle cx="8" cy="8" r="4.6" stroke-opacity=".22"/><path d="M8 3.4a4.6 4.6 0 1 1-4.6 4.6"/></svg>',
    'review': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="C" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 4.5l3.5 3.5-3.5 3.5M8.5 4.5l3.5 3.5-3.5 3.5"/></svg>',
    'x': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="C" stroke-width="2.2" stroke-linecap="round"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>',
    'check': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="C" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.4l3 3 6-6.6"/></svg>',
    'ring': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="C" stroke-width="1.8"><circle cx="8" cy="8" r="3.9"/></svg>',
    'orbit': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="C" stroke-width="1.5"><circle cx="8" cy="8" r="4.3" stroke-opacity=".38"/><circle cx="8" cy="3.7" r="1.9" fill="C" stroke="none"/></svg>',
    'minus': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="C" stroke-width="2.2" stroke-linecap="round"><path d="M4.5 8h7"/></svg>',
    'check-q': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="C" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M2.6 8.6l2.4 2.4 4.4-5"/><path d="M10.6 5.4a1.7 1.7 0 1 1 2.3 1.6c-.5.2-.7.6-.7 1.1" stroke-width="1.5"/><circle cx="12.2" cy="10.6" r=".55" fill="C" stroke-width="1"/></svg>',
    'tilde': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="C" stroke-width="2" stroke-linecap="round"><path d="M3.6 9.2c1.2-2 2.6-2.3 4.4-1.2s3.2.8 4.4-1.2"/></svg>',
    'dashed': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="C" stroke-width="1.7" stroke-dasharray="2.1 1.9"><circle cx="8" cy="8" r="4.1"/></svg>',
    # mods/workspace-chrome/spinner.svg (tab bar, pane header, stock agents list)
    'spinner': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="C" stroke-width="3.2" stroke-linecap="round"><circle cx="12" cy="12" r="9.4" stroke-opacity="0.24"/><path d="M12 2.6a9.4 9.4 0 0 1 9.4 9.4"/></svg>',
}


def uri(svg, color):
    return "url('data:image/svg+xml," + urllib.parse.quote(svg.replace('"C"', '"' + color + '"'), safe=' =:/,.-') + "')"


def mix(hexc, alpha, base=SURFACE['card']):
    ch = lambda v, i: int(v[1 + 2 * i:3 + 2 * i], 16)
    return '#' + ''.join('%02x' % round(ch(hexc, i) * alpha + ch(base, i) * (1 - alpha)) for i in range(3))


def state_css():
    out = []
    for code, (label, text, hue, fill, ink, glyph, mute) in STATES.items():
        mute = mute or hue
        v = [f'--hue:{hue}', f'--fill:{fill}', f'--ink:{ink}', f'--hb:{hue}50',
             f'--cf:{mix(hue, 0x0e / 255)}', f'--cb:{mix(hue, 0x38 / 255)}', f'--cfs:{mix(hue, 0x0e / 255, SURFACE["selectedCard"])}',
             f'--cfh:{mix(hue, 0x0e / 255, DOCK["hover"])}', f'--mute:{mute}']
        if glyph:
            v += [f'--gi:{uri(GLYPHS[glyph], ink)}', f'--gm:{uri(GLYPHS[glyph], mute)}']
        else:
            v += ['--gi:none', '--gm:none']
        out.append(f'.s-{code}{{{";".join(v)}}}')
    return '\n'.join(out)


ICON = {  # mods/workspace-chrome, files, changes, agent-usage, pane (24px viewBox unless noted)
    'search': '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4-4"/>',
    'sidebar': '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9.5 4v16"/>',
    'plus': '<path d="M5 12h14"/><path d="M12 5v14"/>',
    'settings': '<path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"/><circle cx="12" cy="12" r="3"/>',
    'layers': '<path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z"/><path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12"/><path d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17"/>',
    'clock': '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    'monitor': '<rect x="3" y="4" width="18" height="12" rx="2.5"/><path d="M8.5 20h7M12 16v4"/>',
    'branch': '<circle cx="6" cy="5.5" r="2"/><circle cx="6" cy="18.5" r="2"/><circle cx="18" cy="7.5" r="2"/><path d="M6 7.5v9M18 9.5c0 4.5-6.5 3.5-11 7.5"/>',
    'file': '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
    'changes': '<circle cx="6" cy="6" r="2.2"/><circle cx="18" cy="18" r="2.2"/><path d="M6 8.2V14a4 4 0 0 0 4 4h5.8M13 15l2.8 3-2.8 3"/>',
    'x': '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    'chev-r': '<path d="m9 18 6-6-6-6"/>',
    'chev-d': '<path d="m6 9 6 6 6-6"/>',
    'chev-l': '<path d="m15 18-6-6 6-6"/>',
    'check': '<path d="M20 6 9 17l-5-5"/>',
    'server': '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
}
WIDTH = {'search': 1.5, 'sidebar': 1.5, 'monitor': 1.5, 'branch': 1.5, 'changes': 1.5}


def icon(name, size, color='currentColor', extra=''):
    sw = WIDTH.get(name, 2)
    return (f'<svg width="{size}" height="{size}" viewBox="0 0 24 24" fill="none" stroke="{color}" stroke-width="{sw}" '
            f'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex:none{extra}">{ICON[name]}</svg>')


USAGE_ICON = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" style="flex:none"><rect x="2.5" y="8" width="2.5" height="5.5" rx="0.8"/><rect x="6.75" y="2.5" width="2.5" height="11" rx="0.8"/><rect x="11" y="5.5" width="2.5" height="8" rx="0.8"/></svg>'
CLOSE12 = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true" style="flex:none"><path d="M4 4l8 8M12 4l-8 8"/></svg>'

FONTS = '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&amp;family=JetBrains+Mono:wght@400;500&amp;display=swap" rel="stylesheet">'

CSS = r'''
*{box-sizing:border-box}
body{margin:0;background:#131518}
.hd{line-height:1.618;font-family:Inter,system-ui,sans-serif;color:#eeeeef;-webkit-font-smoothing:antialiased;font-feature-settings:"cv11","ss01" 0}
.hd a{color:inherit;text-decoration:none}
.hd button{font:inherit;color:inherit;cursor:pointer;background:none;border:0;padding:0;margin:0}
.mono{font-family:'JetBrains Mono',ui-monospace,monospace}
.row{display:flex;align-items:center;min-width:0}
.col{display:flex;flex-direction:column;min-width:0}
.f1{flex:1;min-width:0}
.nf{flex:none}
.tr{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rel{position:relative}
.abs{position:absolute}
/* ---- animations (gpui .spin(900), loop('opacity') 1600, sweep 2400 easeInOutQuad, edge pulse 1600) ---- */
@keyframes hd-spin{to{transform:rotate(360deg)}}
@keyframes hd-breathe{0%,100%{opacity:.7}50%{opacity:1}}
@keyframes hd-pulse{0%,100%{opacity:.3}50%{opacity:1}}
@keyframes hd-win{from{left:-28%}to{left:100%}}
@keyframes hd-pin{from{left:100%}to{left:-357.142857%}}
.spin{animation:hd-spin .9s linear infinite}
.breathe{animation:hd-breathe 1.6s ease-in-out infinite}
/* ---- state glyph, badge, tile (panorama/state.js) ---- */
.gi{display:inline-block;flex:none;width:11px;height:11px;background:var(--gi) center/contain no-repeat}
.gm{display:inline-block;flex:none;width:11px;height:11px;background:var(--gm) center/contain no-repeat}
.s-run>.gi,.s-run.gi,.s-run>.gm,.s-run.gm{animation:hd-spin .9s linear infinite}
.s-wait>.gi,.s-blk>.gi,.s-wait.gi,.s-blk.gi{display:none}
.lead{font-weight:700}
.lead:empty{display:none}
.badge{display:inline-flex;align-items:center;gap:4px;flex:none;height:18px;padding:0 7px 0 6px;border-radius:5px;background:var(--fill);border:1px solid var(--hb);color:var(--ink);font-size:10px;font-weight:600;white-space:nowrap;line-height:1}
.badge.h17{height:17px}
.badge.h20{height:20px;padding:0 8px 0 7px;font-size:10.5px}
.badge.h22{height:22px;padding:0 9px 0 8px;font-size:11px}
.badge.h22 .gi{width:13px;height:13px}
.badge.h24{height:24px;padding:0 9px 0 8px;font-size:11.5px}
.badge.h24 .gi{width:13px;height:13px}
.tile{display:inline-flex;align-items:center;justify-content:center;flex:none;width:16px;height:16px;border-radius:4px;background:var(--fill);border:1px solid var(--hb);color:var(--ink);font-size:10px;font-weight:700;line-height:1;gap:1px}
.tile .gi{width:12px;height:12px}
.tile.t18{width:18px;height:18px;border-radius:5px}
.tile.t18 .gi{width:13px;height:13px}
.tile.t20{width:20px;height:20px;border-radius:5px;font-size:11px}
.tile.t20 .gi{width:14px;height:14px}
.tile.t14{width:14px;height:14px;border-radius:3.5px;font-size:9.5px}
.tile.t14 .gi{width:11px;height:11px}
.tile.wide{width:auto;min-width:16px;padding:0 4px}
.tile.t18.wide{min-width:18px}
.tile.t20.wide{min-width:20px;padding:0 5px}
.s-wait.tile,.s-blk.tile,.s-fail.tile{animation:hd-breathe 1.6s ease-in-out infinite}
.tile.still{animation:none}
.hn{display:inline-block;flex:none;width:16px;height:16px}
.ckf{display:inline-block;flex:none;width:10px;height:10px;background:CKF center/contain no-repeat}
/* ---- sidebar root card (panorama/main.js rootRow) ---- */
.pwrap{position:relative;padding-top:4px;height:52px;flex:none}
.pcard{position:relative;height:48px;border:1px solid var(--cb);border-radius:8px;background:var(--hue);cursor:pointer}
.pcard.docked{border-color:#b4c8e4}
.pcard.joined{border-bottom:0;border-radius:8px 8px 0 0}
.pfill{position:absolute;left:2px;right:0;top:0;bottom:0;border-radius:0 7px 7px 0;background:var(--cf);display:flex;flex-direction:column}
.pcard.docked .pfill{background:var(--cfs)}
.pcard.joined .pfill{border-radius:0 7px 0 0}
.pcard.hov .pfill{background:var(--cfh)}
.phead{height:25px;display:flex;align-items:center;padding:0 10px 0 6px}
.pnum{width:14px;margin-right:8px;flex:none;text-align:right;font-size:11px;color:#4d535c}
.ptitle{flex:1;min-width:0;font-size:12.5px;color:#c3c7cd;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pcard.docked .ptitle{color:#eceef1;font-weight:600}
.s-done .ptitle{color:#80868f}
.pmarks{margin-left:6px;display:flex;align-items:center;gap:4px;flex:none}
.ptail{height:21px;display:flex;align-items:center;padding:0 10px 0 28px}
.ptail.bare{padding-left:52px}
.ptiles{display:flex;align-items:center;gap:2px;flex:none;margin-right:6px}
.pmeta{flex:1;min-width:0;font-size:11.5px;color:#666c75;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pcard.docked .pmeta{color:#80868f}
.psweep{position:absolute;left:0;right:0;bottom:0;height:8px;pointer-events:none}
.psweep .w{position:absolute;top:0;bottom:0;width:28%;overflow:hidden;animation:hd-win 2.4s cubic-bezier(.455,.03,.515,.955) infinite}
.psweep .o{position:absolute;width:357.142857%;top:-8px;height:16px;border:1px solid #68c2b5;border-top:0;border-radius:0 0 8px 8px;opacity:.85;animation:hd-pin 2.4s cubic-bezier(.455,.03,.515,.955) infinite}
/* card continuing into its rows (inCard) */
.prow{position:relative;height:20px;flex:none;background:var(--hue);border-left:1px solid var(--cb);border-right:1px solid var(--cb)}
.pcard.docked~.prow,.prow.docked{border-color:#b4c8e4}
.prow.last{height:25px;border-bottom:1px solid var(--cb);border-radius:0 0 8px 8px}
.prow.docked.last{border-bottom-color:#b4c8e4}
.prow .pf{position:absolute;left:2px;right:0;top:0;bottom:0;background:var(--cf)}
.prow.docked .pf{background:var(--cfs)}
.prow.last .pf{border-radius:0 0 7px 0}
.trow{position:relative;height:20px;display:flex;align-items:center;padding:0 10px 0 29px;border-radius:4px;font-size:12.5px;color:#c3c7cd}
.trow .seg{position:relative;width:13px;height:100%;flex:none}
.seg.v::before,.seg.t::before{content:"";position:absolute;left:6.25px;top:0;bottom:0;width:1.5px;background:#ffffff24}
.seg.t::after{content:"";position:absolute;left:7px;top:9.25px;width:6px;height:1.5px;background:#ffffff24}
.seg.e::before{content:"";position:absolute;left:6.25px;top:0;height:10.75px;width:6.75px;border-left:1.5px solid #ffffff24;border-bottom:1.5px solid #ffffff24;border-bottom-left-radius:5px}
.trow .gl{margin-right:7px;flex:none;display:flex}
.trow .gl.box{margin-left:-1px}
.trow .gl:not(.box){margin-left:4px}
/* ---- graph card (panorama-graph/cards.js) ---- */
.tg{position:relative;width:16px;flex:none;align-self:stretch}
.tg.pass::before,.tg.tee::before{content:"";position:absolute;left:6px;top:-10px;bottom:0;border-left:1.5px solid #ffffff47}
.tg.tee::after{content:"";position:absolute;left:6px;top:27px;width:10px;border-top:1.5px solid #ffffff47}
.tg.end::before{content:"";position:absolute;left:6px;top:-10px;height:37px;width:10px;border-left:1.5px solid #ffffff47;border-bottom:1.5px solid #ffffff47;border-bottom-left-radius:6px}
.gcard{position:absolute;left:0;width:272px;border:1px solid var(--cb);border-radius:8px;background:var(--cf)}
.gcard.path{border-color:#ffffff55}
.gcard.sel{border-color:#b4c8e4;background:var(--cfs)}
.gcard .edge{position:absolute;inset:0;border-radius:7px;border-left:2px solid var(--hue);pointer-events:none}
.gcard .ring{position:absolute;left:-4px;right:-4px;top:-4px;bottom:-4px;border-radius:11px;border:1px solid #b4c8e444;pointer-events:none}
.gbody{padding:9px 10px 0 12px;display:flex;flex-direction:column;gap:6px}
.gtop{height:18px;display:flex;align-items:center;gap:9px}
.gtitle{flex:1;min-width:0;font-size:12.5px;font-weight:500;color:#98999b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gcard.sel .gtitle,.gcard.path .gtitle{color:#eeeeef}
.gline{height:15px;display:flex;align-items:center;gap:8px}
.gact{flex:1;min-width:0;font-size:11.5px;color:#696a6d;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.s-wait .gact,.s-blk .gact,.s-fail .gact{color:var(--hue)}
.gright{flex:none;font-size:11px;color:#696a6d;white-space:nowrap}
.gdet{padding-top:2px;display:flex;flex-direction:column;gap:3px}
.gd{display:flex;align-items:flex-start;gap:7px;font-size:12px}
.gd .k{width:30px;flex:none;font-size:11px;line-height:17px;color:#696a6d}
.gd .v{flex:1;min-width:0;line-height:17px;color:#98999b}
.gacts{height:26px;padding-top:2px;display:flex;align-items:center;gap:6px}
.gbtn{height:24px;padding:0 9px;border-radius:6px;flex:none;display:flex;align-items:center;font-size:11.5px;color:#eeeeef;background:#ffffff0d;white-space:nowrap}
.gbtn.pri{color:#17191d;background:#eeeeef}
.gbtn.off{color:#696a6d}
.gfold{height:100%;padding:0 10px 0 12px;display:flex;align-items:center;gap:4px}
.gfold .l{margin-left:4px;flex:1;min-width:0;font-size:12px;color:#a8cbb2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gpulse{position:absolute;left:-1.5px;top:8px;bottom:8px;width:2px;border-radius:1px;background:var(--hue);animation:hd-pulse 1.6s ease-in-out infinite}
.gsweep{position:absolute;left:10px;right:10px;bottom:-1.5px;height:2px;overflow:hidden}
.gsweep i{position:absolute;top:0;bottom:0;width:28%;background:#68c2b5;opacity:.85;animation:hd-win 2.4s cubic-bezier(.455,.03,.515,.955) infinite}
.gsweep.rev i{background:#8eaee6}
.gline-c{position:absolute;background:#ffffff24}
.gline-c.hi{background:#eeeeef4d}
/* ---- usage (agent-usage/main.js) ---- */
.ubar{flex:1;min-width:0;height:6px;border-radius:3px;overflow:hidden}
.ubar i{display:block;height:100%;border-radius:3px}
'''


CSS = CSS.replace('CKF', uri(GLYPHS['check'], SURFACE['faint']))


def page(title, preview, body, script, extra_css=''):
    w, h = preview
    return f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>{title}</title>
<script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
{FONTS}
<style>{CSS}{state_css()}
{extra_css}</style>
</helmet>
{body}
</x-dc>
<script type="text/x-dc" data-dc-script data-props='{{"$preview":{{"width":{w},"height":{h}}}}}'>
{script}
</script>
</body>
</html>
'''


# ---------- small builders (static markup) ----------
def gi(code, mute=False, size=None, cls=''):
    st = f' style="width:{size}px;height:{size}px"' if size else ''
    return f'<i class="{"gm" if mute else "gi"} s-{code} {cls}"{st}></i>'


def badge(code, label=None, questions=None, h=18, extra=''):
    lab, text = STATES[code][0], STATES[code][1]
    lead = f'?{questions}' if code == 'wait' and questions else (text if code in ('wait', 'blk') else '')
    return f'<span class="badge h{h} s-{code}"{extra}><i class="gi"></i><b class="lead">{lead}</b>{label or lab}</span>'


def tile(code, size=16, count=None, still=False):
    text = STATES[code][1]
    wide = isinstance(count, int) and count > 0 and not (code == 'done' and count == 1)
    cls = f'tile s-{code}' + (f' t{size}' if size != 16 else '') + (' wide' if wide else '') + (' still' if still else '')
    if code in ('wait', 'blk'):
        inner = f'?{count if wide else ""}' if code == 'wait' else (f'!{count}' if wide else '!')
    else:
        inner = '<i class="gi"></i>' + (f'<span>{count}</span>' if wide else '')
    return f'<span class="{cls}">{inner}</span>'


def harness(name, size=16):
    return f'<img class="hn" src="icons/{name}.svg" alt="" style="width:{size}px;height:{size}px">'


def spinner(size=12, color=T['working'], extra=''):
    return f'<i class="spin" style="display:inline-block;flex:none;width:{size}px;height:{size}px;background:{uri(GLYPHS["spinner"], color)} center/contain no-repeat{extra}"></i>'
