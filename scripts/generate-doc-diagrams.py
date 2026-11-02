#!/usr/bin/env python3
"""Generate the shared documentation/article SVGs. No third-party dependencies."""
from html import escape
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'apps/docs/static/img/diagrams'
OUT.mkdir(parents=True, exist_ok=True)


def diagram(name, title, description, height, content):
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="{height}" viewBox="0 0 1200 {height}" role="img" aria-labelledby="title description">
<title id="title">{escape(title)}</title><desc id="description">{escape(description)}</desc>
<defs><marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#2b5f92"/></marker></defs>
<style>text{{font-family:system-ui,-apple-system,Segoe UI,sans-serif;fill:#122033}}.title{{font-size:32px;font-weight:700}}.label{{font-size:24px;font-weight:650}}.copy{{font-size:21px}}.small{{font-size:19px;fill:#506274}}.eyebrow{{font-size:17px;letter-spacing:2px;font-weight:650;fill:#2b5f92}}.edge{{fill:none;stroke:#2b5f92;stroke-width:3;marker-end:url(#arrow)}}.planned{{stroke-dasharray:9 7}}</style>
<rect width="1200" height="{height}" rx="22" fill="#f3f6f8"/>
<text x="44" y="58" class="title">{escape(title)}</text>
{content}
<text x="44" y="{height - 23}" class="small">Paseo Rooms · Pyratz Labs</text>
</svg>'''
    (OUT / f'{name}.svg').write_text(svg + '\n')


def box(x, y, w, h, title, lines=(), fill='#fbfcfd', dashed=False):
    dash = ' stroke-dasharray="9 7"' if dashed else ''
    text = f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="14" fill="{fill}" stroke="#b9cbd9" stroke-width="2"{dash}/>'
    text += f'<text x="{x+22}" y="{y+38}" class="label">{escape(title)}</text>'
    for i, line in enumerate(lines):
        text += f'<text x="{x+22}" y="{y+72+i*28}" class="copy">{escape(line)}</text>'
    return text


def edge(path, planned=False, two_way=False):
    start = ' marker-start="url(#arrow)"' if two_way else ''
    return f'<path d="{path}" class="edge{" planned" if planned else ""}"{start}/>'


diagram('shared-conversation', 'Bring the team into the conversation',
        'Without a room, a host copies an agent conversation to a teammate and relays their reply. With Rooms, the host and teammate both join the same agent conversation.', 590,
        '<text x="44" y="108" class="eyebrow">THE COPY-AND-PASTE HANDOFF</text>'
        + box(44, 135, 280, 130, 'Agent session', ['Context stays local'])
        + box(460, 135, 280, 130, 'Host', ['Copy, explain, relay'])
        + box(876, 135, 280, 130, 'Teammate', ['Partial context'])
        + edge('M 330 200 H 450') + edge('M 746 200 H 866')
        + '<text x="44" y="324" class="eyebrow">WITH PASEO ROOMS</text>'
        + box(44, 357, 280, 145, 'Host in Paseo', ['Same working session'])
        + box(460, 357, 280, 145, 'Shared room', ['One conversation', 'Live history and replies'], '#e3edf5')
        + box(876, 357, 280, 145, 'Teammate', ['Join from a browser', 'Contribute in context'])
        + edge('M 330 418 H 450') + edge('M 450 449 H 330')
        + edge('M 746 418 H 866') + edge('M 866 449 H 746'))

diagram('room-architecture', 'The host keeps the agent connection',
        'A trusted static browser client is delivered separately. Browser participants establish encrypted channels through a public relay to the host plugin runtime. The runtime connects to one shared agent through the local Paseo daemon. The host opens its connection to the relay outbound; browser clients receive no daemon credentials.', 790,
        '<rect x="34" y="99" width="1132" height="177" rx="18" fill="#e3edf5"/>'
        + '<text x="56" y="130" class="eyebrow">HOST MACHINE · PASEO DAEMON AND PLUGIN</text>'
        + box(56, 151, 310, 100, 'Paseo daemon', ['Agent, workspace, tools'])
        + box(670, 151, 470, 100, 'Rooms plugin runtime', ['Room → agent mapping and room keys'])
        + edge('M 374 190 H 660') + edge('M 660 224 H 374')
        + '<text x="409" y="171" class="small">Local SDK connection</text>'
        + box(670, 365, 470, 130, 'Public relay', ['Routes encrypted room records', 'No conversation database'])
        + edge('M 810 262 V 353') + edge('M 920 353 V 262')
        + '<text x="44" y="322" class="copy">Host connects outward; no public laptop port.</text>'
        + box(44, 591, 355, 125, 'Browser participant A', ['Reads, messages, answers'])
        + box(444, 591, 355, 125, 'Browser participant B', ['Same room, separate channel'])
        + edge('M 230 581 V 542 H 810 V 508', two_way=True)
        + edge('M 900 508 V 558 H 620 V 581', two_way=True)
        + box(44, 365, 500, 130, 'Static room client', ['Default: independently on GitHub Pages', 'Client origin must be trusted'])
        + '<path d="M 100 503 V 578" stroke="#8899a8" stroke-width="2" stroke-dasharray="6 6"/>'
        + '<text x="856" y="632" class="small">Encrypted payloads</text>'
        + '<text x="856" y="662" class="small">Routing metadata visible</text>')

diagram('collaboration-roadmap', 'From shared context to agent collaboration',
        'Today: humans collaborate with one agent in a shared room. Experiment: an agent sent a message through a second browser and the same agent received it. Future exploration: distinct agents collaborating with explicit authority, turn-taking, budgets and human oversight; this is not shipped orchestration.', 675,
        box(44, 110, 1112, 145, 'TODAY · People and one shared agent',
            ['Join by link, follow the timeline, send messages and images, answer questions.',
             'One host remains responsible for the agent and its tools.'], '#e3edf5')
        + edge('M 600 267 V 309')
        + box(44, 322, 1112, 115, 'EXPERIMENT · A browser can be a participant',
              ['One agent sent a message through Rooms and received it in its own session.'])
        + edge('M 600 450 V 492', True)
        + box(44, 505, 1112, 115, 'NEXT TO EXPLORE · Distinct agents working together',
              ['Explicit roles, scoped access, turn-taking, budgets, and human oversight.'], dashed=True))
print(f'Generated 3 diagrams in {OUT}')
