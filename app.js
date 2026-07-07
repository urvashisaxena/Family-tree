'use strict';

/* =========================================================================
   Family Tree Builder — no storage, no dependencies.
   Data model:
     person: { id, name, gender ('f'|'m'|'x'), birth, death, note, parentUnion }
     union:  { id, partners: [pid, pid?] (0..2), children: [pid...] }
   A union with 0 partners is a "sibling group" with unknown parents.
   ========================================================================= */

const SVGNS = 'http://www.w3.org/2000/svg';

const CARD_W = 172, CARD_H = 66;
const SPOUSE_GAP = 46;          // gap between cards inside a couple chain
const CHAIN_GAP = 60;           // min gap between separate chains in a row
const ROW_H = 176;              // vertical distance between generations
const COMP_GAP = 150;           // gap between disconnected family groups

const REL_COLORS = {
  self:   '#6366f1',
  parent: '#0284c7',
  spouse: '#e11d48',
  sibling:'#d97706',
  child:  '#059669',
};
const REL_LABELS = { parent: 'PARENT', spouse: 'SPOUSE', sibling: 'SIBLING', child: 'CHILD' };
const GENDER_COLORS = { f: '#f472b6', m: '#60a5fa', x: '#a78bfa' };
const FONT = "'Segoe UI', Helvetica, Arial, sans-serif";

let state = { title: 'My Family Tree', seq: 0, persons: {}, unions: {} };
let selected = null;
let undoStack = [];
let view = { x: 60, y: 60, k: 1 };
let layoutCache = null;

const $ = id => document.getElementById(id);
const canvas = $('canvas'), viewport = $('viewport'), scene = $('scene'), overlay = $('overlay');

function uid(prefix) { state.seq += 1; return prefix + state.seq; }
const persons = () => Object.values(state.persons);
const unions = () => Object.values(state.unions);
const partnerUnionsOf = pid => unions().filter(u => u.partners.includes(pid));

/* ============================== mutations ============================== */

function pushUndo() {
  undoStack.push(JSON.stringify(state));
  if (undoStack.length > 80) undoStack.shift();
  $('btnUndo').disabled = false;
}

function undo() {
  if (!undoStack.length) return;
  state = JSON.parse(undoStack.pop());
  if (selected && !state.persons[selected]) selected = null;
  $('btnUndo').disabled = undoStack.length === 0;
  $('treeTitle').value = state.title;
  render();
}

function createPerson(fields) {
  const p = {
    id: uid('p'),
    name: (fields.name || '').trim() || 'Unnamed',
    gender: fields.gender || 'x',
    birth: (fields.birth || '').trim(),
    death: (fields.death || '').trim(),
    note: (fields.note || '').trim(),
    parentUnion: null,
  };
  state.persons[p.id] = p;
  return p;
}

function createUnion(partners, children) {
  const u = { id: uid('u'), partners: partners || [], children: children || [] };
  state.unions[u.id] = u;
  u.children.forEach(c => { state.persons[c].parentUnion = u.id; });
  return u;
}

function addRelative(mode, targetId, fields, unionId) {
  pushUndo();
  const p = createPerson(fields);
  const t = state.persons[targetId];
  if (mode === 'spouse') {
    createUnion([targetId, p.id]);
  } else if (mode === 'parent') {
    if (t.parentUnion && state.unions[t.parentUnion].partners.length < 2) {
      state.unions[t.parentUnion].partners.push(p.id);
    } else if (!t.parentUnion) {
      createUnion([p.id], [targetId]);
    }
  } else if (mode === 'sibling') {
    if (!t.parentUnion) createUnion([], [targetId]);
    const u = state.unions[t.parentUnion];
    u.children.push(p.id);
    p.parentUnion = u.id;
  } else if (mode === 'child') {
    let u = unionId ? state.unions[unionId] : null;
    if (!u) {
      const us = partnerUnionsOf(targetId);
      u = us.length ? us[us.length - 1] : createUnion([targetId]);
    }
    u.children.push(p.id);
    p.parentUnion = u.id;
  }
  selected = p.id;
  afterMutation();
  return p;
}

function updatePerson(pid, fields) {
  pushUndo();
  const p = state.persons[pid];
  p.name = (fields.name || '').trim() || 'Unnamed';
  p.gender = fields.gender || 'x';
  p.birth = (fields.birth || '').trim();
  p.death = (fields.death || '').trim();
  p.note = (fields.note || '').trim();
  afterMutation();
}

function deletePerson(pid) {
  pushUndo();
  delete state.persons[pid];
  for (const u of unions()) {
    u.partners = u.partners.filter(x => x !== pid);
    u.children = u.children.filter(x => x !== pid);
  }
  // dissolve unions that no longer connect anything
  for (const u of unions()) {
    const total = u.partners.length + u.children.length;
    if (total <= 1 || (u.partners.length === 1 && u.children.length === 0)) {
      u.children.forEach(c => { if (state.persons[c]) state.persons[c].parentUnion = null; });
      delete state.unions[u.id];
    }
  }
  if (selected === pid) selected = null;
  afterMutation();
}

function afterMutation() {
  render();
  autoFit(false);
}

/* ============================== layout ============================== */

function computeLayout() {
  const ids = Object.keys(state.persons);
  if (!ids.length) return { pos: {}, unionGeo: [], bbox: null };
  const us = unions();

  // 1. generations + connected components via BFS
  const gen = {}, comp = {};
  let nComp = 0;
  for (const start of ids) {
    if (gen[start] !== undefined) continue;
    gen[start] = 0; comp[start] = nComp;
    const q = [start];
    while (q.length) {
      const id = q.shift(), g = gen[id];
      const visit = (pid, g2) => {
        if (gen[pid] === undefined) { gen[pid] = g2; comp[pid] = nComp; q.push(pid); }
      };
      for (const u of us) {
        if (u.partners.includes(id)) {
          u.partners.forEach(x => { if (x !== id) visit(x, g); });
          u.children.forEach(c => visit(c, g + 1));
        }
        if (u.children.includes(id)) {
          u.partners.forEach(x => visit(x, g - 1));
          u.children.forEach(c => { if (c !== id) visit(c, g); });
        }
      }
    }
    nComp++;
  }

  const pos = {};
  let xCursor = 0;

  for (let ci = 0; ci < nComp; ci++) {
    const cids = ids.filter(id => comp[id] === ci);
    const minG = Math.min(...cids.map(id => gen[id]));
    const cgen = {};
    cids.forEach(id => { cgen[id] = gen[id] - minG; });
    const compUnions = us.filter(u =>
      u.partners.concat(u.children).some(id => comp[id] === ci));

    // DFS ordering so siblings/spouses land near each other initially
    const order = {};
    let counter = 0;
    const visitP = (id) => {
      if (order[id] !== undefined) return;
      order[id] = counter++;
      for (const u of compUnions) {
        if (u.partners.includes(id)) {
          u.partners.forEach(visitP);
          u.children.forEach(visitP);
        }
      }
    };
    const roots = cids.slice().sort((a, b) => cgen[a] - cgen[b] || a.localeCompare(b));
    roots.forEach(visitP);

    // chains: partner-connected groups within a generation, laid out rigidly
    const chainOf = {};
    const rows = new Map();  // gen -> [chain]
    const adj = {};
    cids.forEach(id => { adj[id] = []; });
    for (const u of compUnions) {
      if (u.partners.length === 2) {
        adj[u.partners[0]].push(u.partners[1]);
        adj[u.partners[1]].push(u.partners[0]);
      }
    }
    const seen = new Set();
    for (const id of cids.slice().sort((a, b) => order[a] - order[b])) {
      if (seen.has(id)) continue;
      // collect the partner component
      const members = [];
      const stack = [id];
      const inGroup = new Set();
      while (stack.length) {
        const x = stack.pop();
        if (inGroup.has(x)) continue;
        inGroup.add(x); members.push(x);
        adj[x].forEach(y => { if (!inGroup.has(y)) stack.push(y); });
      }
      // order as a path when possible, else by DFS order
      let ordered;
      const maxDeg = Math.max(...members.map(m => adj[m].filter(y => inGroup.has(y)).length));
      if (members.length > 1 && maxDeg <= 2) {
        let start2 = members.find(m => adj[m].filter(y => inGroup.has(y)).length <= 1) || members[0];
        ordered = [start2];
        const used = new Set([start2]);
        let cur = start2;
        while (ordered.length < members.length) {
          const next = adj[cur].find(y => inGroup.has(y) && !used.has(y));
          if (!next) break;
          ordered.push(next); used.add(next); cur = next;
        }
        members.forEach(m => { if (!used.has(m)) ordered.push(m); });
        if (order[ordered[ordered.length - 1]] < order[ordered[0]]) ordered.reverse();
      } else {
        ordered = members.slice().sort((a, b) => order[a] - order[b]);
      }
      members.forEach(m => seen.add(m));
      const chain = {
        members: ordered,
        gen: cgen[id],
        x: 0,
        w: CARD_W + (ordered.length - 1) * (CARD_W + SPOUSE_GAP),
        ord: Math.min(...ordered.map(m => order[m])),
      };
      ordered.forEach((m, i) => { chainOf[m] = { chain, idx: i }; });
      if (!rows.has(chain.gen)) rows.set(chain.gen, []);
      rows.get(chain.gen).push(chain);
    }

    // initial placement per row in DFS order
    for (const [, row] of rows) {
      row.sort((a, b) => a.ord - b.ord);
      let cur = 0;
      for (const ch of row) { ch.x = cur; cur += ch.w + CHAIN_GAP; }
    }

    const centerOf = pid => {
      const { chain, idx } = chainOf[pid];
      return chain.x + CARD_W / 2 + idx * (CARD_W + SPOUSE_GAP);
    };

    // force iterations: parents centered over children, siblings cohesive
    for (let it = 0; it < 320; it++) {
      const force = new Map();
      const addF = (ch, f) => {
        const rec = force.get(ch) || { sum: 0, n: 0 };
        rec.sum += f; rec.n += 1; force.set(ch, rec);
      };
      for (const u of compUnions) {
        if (!u.children.length) continue;
        const centers = u.children.map(centerOf);
        const cm = centers.reduce((a, b) => a + b, 0) / centers.length;
        // sibling cohesion (also for unknown-parent groups)
        u.children.forEach((c, i) => addF(chainOf[c].chain, (cm - centers[i]) * 0.3));
        if (!u.partners.length) continue;
        const um = u.partners.map(centerOf).reduce((a, b) => a + b, 0) / u.partners.length;
        const d = um - cm;
        u.children.forEach(c => addF(chainOf[c].chain, d));
        u.partners.forEach(p => addF(chainOf[p].chain, -d));
      }
      let maxMove = 0;
      force.forEach((rec, ch) => {
        const m = (rec.sum / rec.n) * 0.5;
        ch.x += m;
        maxMove = Math.max(maxMove, Math.abs(m));
      });
      // collision resolution per row, alternating sweep direction
      for (const [, row] of rows) {
        row.sort((a, b) => a.x - b.x);
        if (it % 2 === 0) {
          for (let i = 1; i < row.length; i++) {
            const min = row[i - 1].x + row[i - 1].w + CHAIN_GAP;
            if (row[i].x < min) row[i].x = min;
          }
        } else {
          for (let i = row.length - 2; i >= 0; i--) {
            const max = row[i + 1].x - CHAIN_GAP - row[i].w;
            if (row[i].x > max) row[i].x = max;
          }
        }
      }
      if (maxMove < 0.4 && it > 60) break;
    }

    // materialize positions, offset the whole component
    let minX = Infinity, maxX = -Infinity;
    cids.forEach(id => {
      const cx = centerOf(id);
      minX = Math.min(minX, cx - CARD_W / 2);
      maxX = Math.max(maxX, cx + CARD_W / 2);
    });
    const dx = xCursor - minX;
    cids.forEach(id => {
      pos[id] = { cx: centerOf(id) + dx, y: cgen[id] * ROW_H };
    });
    xCursor += (maxX - minX) + COMP_GAP;
  }

  // union geometry for drawing
  const unionGeo = [];
  for (const u of us) {
    const geo = { u, partnerLine: null, mid: null, rail: null };
    if (u.partners.length === 2) {
      const a = pos[u.partners[0]], b = pos[u.partners[1]];
      const [l, r] = a.cx <= b.cx ? [a, b] : [b, a];
      const cy = a.y + CARD_H / 2;
      const x1 = Math.min(l.cx + CARD_W / 2, r.cx - CARD_W / 2);
      const x2 = Math.max(l.cx + CARD_W / 2, r.cx - CARD_W / 2);
      geo.partnerLine = { x1, x2, y: cy };
      geo.mid = { x: (l.cx + r.cx) / 2, y: cy };
    } else if (u.partners.length === 1) {
      const p = pos[u.partners[0]];
      geo.mid = { x: p.cx, y: p.y + CARD_H };
    }
    if (u.children.length) {
      const childY = pos[u.children[0]].y;
      const railY = childY - (ROW_H - CARD_H) / 2;
      const xs = u.children.map(c => pos[c].cx);
      let lo = Math.min(...xs), hi = Math.max(...xs);
      if (geo.mid) { lo = Math.min(lo, geo.mid.x); hi = Math.max(hi, geo.mid.x); }
      geo.rail = { y: railY, x1: lo, x2: hi, childY, xs };
    }
    unionGeo.push(geo);
  }

  // bounding box
  let bx1 = Infinity, by1 = Infinity, bx2 = -Infinity, by2 = -Infinity;
  ids.forEach(id => {
    bx1 = Math.min(bx1, pos[id].cx - CARD_W / 2);
    bx2 = Math.max(bx2, pos[id].cx + CARD_W / 2);
    by1 = Math.min(by1, pos[id].y);
    by2 = Math.max(by2, pos[id].y + CARD_H);
  });
  return { pos, unionGeo, bbox: { x: bx1, y: by1, w: bx2 - bx1, h: by2 - by1 } };
}

/* ============================== relationships ============================== */

function relationMap(pid) {
  const rel = {};
  if (!pid || !state.persons[pid]) return rel;
  rel[pid] = 'self';
  const p = state.persons[pid];
  for (const u of partnerUnionsOf(pid)) {
    u.partners.forEach(x => { if (x !== pid && !rel[x]) rel[x] = 'spouse'; });
    u.children.forEach(c => { if (!rel[c]) rel[c] = 'child'; });
  }
  if (p.parentUnion && state.unions[p.parentUnion]) {
    const u = state.unions[p.parentUnion];
    u.partners.forEach(x => { if (!rel[x]) rel[x] = 'parent'; });
    u.children.forEach(c => { if (c !== pid && !rel[c]) rel[c] = 'sibling'; });
  }
  return rel;
}

/* ============================== SVG helpers ============================== */

function el(name, attrs, parent) {
  const node = document.createElementNS(SVGNS, name);
  for (const k in attrs) node.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(node);
  return node;
}

function txt(parent, x, y, str, attrs) {
  const t = el('text', Object.assign({
    x, y, 'font-family': FONT,
  }, attrs), parent);
  t.textContent = str;
  return t;
}

function truncate(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }

function lifeLine(p) {
  if (p.birth && p.death) return `${p.birth} – ${p.death}`;
  if (p.birth) return `b. ${p.birth}`;
  if (p.death) return `d. ${p.death}`;
  return '';
}

/* ============================== drawing ============================== */

function drawScene(group, L, opts) {
  const rel = opts.interactive ? relationMap(selected) : {};
  const sel = opts.interactive ? selected : null;
  const selPerson = sel ? state.persons[sel] : null;

  // ---- union lines ----
  for (const geo of L.unionGeo) {
    const u = geo.u;
    const isOwnUnion = sel && u.partners.includes(sel);
    const isParentUnion = selPerson && selPerson.parentUnion === u.id;
    const lineColor = '#9aa8bd';
    const lw = 2;

    if (geo.partnerLine) {
      const c = isOwnUnion ? REL_COLORS.spouse : lineColor;
      el('line', {
        x1: geo.partnerLine.x1, y1: geo.partnerLine.y,
        x2: geo.partnerLine.x2, y2: geo.partnerLine.y,
        stroke: c, 'stroke-width': isOwnUnion ? 3 : lw,
      }, group);
    }
    if (geo.rail) {
      const railColor = isParentUnion ? REL_COLORS.sibling
        : isOwnUnion ? REL_COLORS.child : lineColor;
      const g = el('g', { stroke: railColor, 'stroke-width': (isParentUnion || isOwnUnion) ? 3 : lw, 'stroke-linecap': 'round' }, group);
      if (geo.mid) {
        el('line', { x1: geo.mid.x, y1: geo.mid.y, x2: geo.mid.x, y2: geo.rail.y }, g);
      }
      el('line', { x1: geo.rail.x1, y1: geo.rail.y, x2: geo.rail.x2, y2: geo.rail.y }, g);
      geo.rail.xs.forEach(x => {
        el('line', { x1: x, y1: geo.rail.y, x2: x, y2: geo.rail.childY }, g);
      });
      // sibling dots on the rail — makes sibling groups scannable at a glance
      geo.rail.xs.forEach(x => {
        el('circle', { cx: x, cy: geo.rail.y, r: 3.2, fill: railColor, stroke: 'none' }, g);
      });
    }
    if (geo.partnerLine && geo.mid) {
      // marriage badge
      const c = isOwnUnion ? REL_COLORS.spouse : '#c2688a';
      el('circle', { cx: geo.mid.x, cy: geo.mid.y, r: 9.5, fill: '#fff', stroke: c, 'stroke-width': 1.8 }, group);
      txt(group, geo.mid.x, geo.mid.y + 3.4, '♥', {
        'font-size': 10, fill: c, 'text-anchor': 'middle', 'font-family': FONT,
      });
    }
  }

  // ---- person cards ----
  for (const pid in L.pos) {
    const p = state.persons[pid];
    const { cx, y } = L.pos[pid];
    const left = cx - CARD_W / 2;
    const r = rel[pid];
    const stroke = r ? REL_COLORS[r] : '#d3dbe6';
    const g = el('g', { class: 'card', transform: `translate(${left},${y})`, 'data-pid': pid }, group);

    // soft shadow
    el('rect', { x: 2, y: 4, width: CARD_W, height: CARD_H, rx: 14, fill: 'rgba(15,23,42,0.07)' }, g);
    // halo for related cards
    if (r) {
      el('rect', {
        x: -4, y: -4, width: CARD_W + 8, height: CARD_H + 8, rx: 17,
        fill: 'none', stroke, 'stroke-width': 2, 'stroke-opacity': 0.35,
      }, g);
    }
    el('rect', {
      x: 0, y: 0, width: CARD_W, height: CARD_H, rx: 14,
      fill: '#ffffff', stroke, 'stroke-width': r ? 2.4 : 1.4,
    }, g);
    el('rect', { x: 8, y: 12, width: 4.5, height: CARD_H - 24, rx: 2.2, fill: GENDER_COLORS[p.gender] || GENDER_COLORS.x }, g);

    txt(g, 22, 28, truncate(p.name, 18), {
      'font-size': 13.5, 'font-weight': 650, fill: '#111827',
    });
    const life = lifeLine(p);
    if (life) txt(g, 22, 47, life, { 'font-size': 11, fill: '#64748b' });

    if (r && r !== 'self') {
      const label = REL_LABELS[r];
      const bw = label.length * 6.4 + 12;
      el('rect', { x: CARD_W - bw - 6, y: -9, width: bw, height: 16, rx: 8, fill: stroke }, g);
      txt(g, CARD_W - 6 - bw / 2, 3, label, {
        'font-size': 8.5, 'font-weight': 700, fill: '#ffffff', 'text-anchor': 'middle', 'letter-spacing': '0.5',
      });
    }
    if (r === 'self') {
      el('rect', { x: 6, y: -9, width: 20, height: 16, rx: 8, fill: stroke }, g);
      txt(g, 16, 3, '★', { 'font-size': 9, fill: '#fff', 'text-anchor': 'middle' });
    }

    if (p.note || p.name.length > 18) {
      const title = document.createElementNS(SVGNS, 'title');
      title.textContent = p.name + (p.note ? ' — ' + p.note : '');
      g.appendChild(title);
    }

    if (opts.interactive) {
      g.addEventListener('click', e => { e.stopPropagation(); select(pid); });
      g.addEventListener('dblclick', e => { e.stopPropagation(); openModal('edit', pid); });
    }
  }
}

function drawQuickButtons(L) {
  overlay.innerHTML = '';
  if (!selected || !L.pos[selected]) return;
  const p = state.persons[selected];
  const { cx, y } = L.pos[selected];
  const cy = y + CARD_H / 2;
  const k = Math.max(view.k, 0.4);

  const canAddParent = !p.parentUnion ||
    (state.unions[p.parentUnion] && state.unions[p.parentUnion].partners.length < 2);

  const buttons = [
    { mode: 'parent', x: cx, y: y - 27, color: REL_COLORS.parent, label: 'parent', show: canAddParent },
    { mode: 'child', x: cx, y: y + CARD_H + 27, color: REL_COLORS.child, label: 'child', show: true },
    { mode: 'spouse', x: cx + CARD_W / 2 + 30, y: cy, color: REL_COLORS.spouse, label: 'spouse', show: true },
    { mode: 'sibling', x: cx - CARD_W / 2 - 30, y: cy, color: REL_COLORS.sibling, label: 'sibling', show: true },
  ];

  for (const b of buttons) {
    if (!b.show) continue;
    const s = 1 / k;
    const g = el('g', {
      class: 'qbtn',
      transform: `translate(${b.x},${b.y}) scale(${s})`,
      'data-action': b.mode,
    }, overlay);
    el('circle', { cx: 0, cy: 0, r: 14, fill: b.color, stroke: '#ffffff', 'stroke-width': 2.5 }, g);
    txt(g, 0, 4.6, '＋', { 'font-size': 14, 'font-weight': 700, fill: '#fff', 'text-anchor': 'middle' });
    txt(g, 0, 28, b.label, {
      'font-size': 9.5, 'font-weight': 700, fill: b.color, 'text-anchor': 'middle',
      stroke: '#ffffff', 'stroke-width': 3, 'paint-order': 'stroke', 'stroke-linejoin': 'round',
    });
    const title = document.createElementNS(SVGNS, 'title');
    title.textContent = `Add ${b.label} of ${p.name}`;
    g.appendChild(title);
    g.addEventListener('click', e => {
      e.stopPropagation();
      startAdd(b.mode, selected);
    });
  }
}

/* ============================== render ============================== */

function render() {
  layoutCache = computeLayout();
  scene.innerHTML = '';
  drawScene(scene, layoutCache, { interactive: true });
  drawQuickButtons(layoutCache);
  applyView();
  $('emptyState').classList.toggle('hidden', persons().length > 0);
  $('legend').classList.toggle('hidden', !selected);
  $('hint').textContent = persons().length === 0
    ? 'Add a person to begin'
    : selected
      ? 'Use the ＋ buttons: parent above · spouse & sibling beside · child below — double-click to edit'
      : 'Click a person to light up their relationships · double-click to edit · drag to pan, scroll to zoom';
}

function select(pid) {
  selected = (selected === pid) ? null : pid;
  render();
}

function applyView() {
  viewport.setAttribute('transform', `translate(${view.x},${view.y}) scale(${view.k})`);
}

/* ============================== pan & zoom ============================== */

function zoomAt(clientX, clientY, factor) {
  const rect = canvas.getBoundingClientRect();
  const px = clientX - rect.left, py = clientY - rect.top;
  const wx = (px - view.x) / view.k, wy = (py - view.y) / view.k;
  view.k = Math.min(2.8, Math.max(0.12, view.k * factor));
  view.x = px - wx * view.k;
  view.y = py - wy * view.k;
  applyView();
  drawQuickButtons(layoutCache); // keep button size constant
}

function fitView() {
  const bb = layoutCache && layoutCache.bbox;
  if (!bb) return;
  const rect = canvas.getBoundingClientRect();
  const pad = 70;
  const k = Math.min((rect.width - pad * 2) / Math.max(bb.w, 1),
    (rect.height - pad * 2) / Math.max(bb.h, 1), 1.35);
  view.k = Math.max(0.12, k);
  view.x = (rect.width - bb.w * view.k) / 2 - bb.x * view.k;
  view.y = (rect.height - bb.h * view.k) / 2 - bb.y * view.k;
  applyView();
  drawQuickButtons(layoutCache);
}

function autoFit(force) {
  const bb = layoutCache && layoutCache.bbox;
  if (!bb) return;
  if (force) { fitView(); return; }
  const rect = canvas.getBoundingClientRect();
  const corners = [
    [bb.x, bb.y], [bb.x + bb.w, bb.y + bb.h],
  ].map(([x, y]) => [x * view.k + view.x, y * view.k + view.y]);
  const out = corners[0][0] < 0 || corners[0][1] < 0 ||
    corners[1][0] > rect.width || corners[1][1] > rect.height;
  if (out) fitView();
}

canvas.addEventListener('wheel', e => {
  e.preventDefault();
  zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0012));
}, { passive: false });

let panning = null;
canvas.addEventListener('pointerdown', e => {
  if (e.target.closest('.card') || e.target.closest('.qbtn')) return;
  panning = { sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y, moved: false };
  canvas.classList.add('panning');
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', e => {
  if (!panning) return;
  const dx = e.clientX - panning.sx, dy = e.clientY - panning.sy;
  if (Math.abs(dx) + Math.abs(dy) > 3) panning.moved = true;
  view.x = panning.vx + dx;
  view.y = panning.vy + dy;
  applyView();
});
canvas.addEventListener('pointerup', e => {
  if (panning && !panning.moved) { selected = null; render(); }
  panning = null;
  canvas.classList.remove('panning');
});

/* ============================== modal ============================== */

let modalCtx = null;
let modalGender = 'x';

function setGender(g) {
  modalGender = g;
  document.querySelectorAll('#fGender button').forEach(b =>
    b.classList.toggle('active', b.dataset.g === g));
}

function startAdd(mode, targetId) {
  if (mode === 'child') {
    const us = partnerUnionsOf(targetId);
    if (us.length > 1) { openChildChooser(targetId, us); return; }
  }
  openModal(mode, targetId);
}

function openChildChooser(targetId, us) {
  const t = state.persons[targetId];
  const box = $('chooserBox');
  box.innerHTML = '';
  const h = document.createElement('h3');
  h.textContent = `Add child of ${t.name}`;
  const sub = document.createElement('p');
  sub.textContent = 'With which partner?';
  box.append(h, sub);
  for (const u of us) {
    const other = u.partners.find(x => x !== targetId);
    const btn = document.createElement('button');
    btn.textContent = other ? `With ${state.persons[other].name}` : 'Single-parent line';
    btn.addEventListener('click', () => {
      $('chooserBack').classList.add('hidden');
      openModal('child', targetId, u.id);
    });
    box.appendChild(btn);
  }
  const cancel = document.createElement('button');
  cancel.textContent = 'Cancel';
  cancel.className = 'ghost';
  cancel.addEventListener('click', () => $('chooserBack').classList.add('hidden'));
  box.appendChild(cancel);
  $('chooserBack').classList.remove('hidden');
}

function openModal(mode, targetId, unionId) {
  modalCtx = { mode, targetId, unionId };
  const t = targetId ? state.persons[targetId] : null;
  const titles = {
    root: 'Add the first person',
    parent: t && `Add parent of ${t.name}`,
    child: t && `Add child of ${t.name}`,
    spouse: t && `Add spouse of ${t.name}`,
    sibling: t && `Add sibling of ${t.name}`,
    edit: t && `Edit ${t.name}`,
  };
  $('modalTitle').textContent = titles[mode] || 'Add person';
  const editing = mode === 'edit';
  $('fName').value = editing ? t.name : '';
  $('fBirth').value = editing ? t.birth : '';
  $('fDeath').value = editing ? t.death : '';
  $('fNote').value = editing ? t.note : '';
  // sensible gender defaults for new relatives
  let g = editing ? t.gender : 'x';
  if (!editing && t) {
    if (mode === 'spouse') g = t.gender === 'm' ? 'f' : t.gender === 'f' ? 'm' : 'x';
    if (mode === 'parent' && t.parentUnion) {
      const existing = state.unions[t.parentUnion].partners[0];
      if (existing) {
        const eg = state.persons[existing].gender;
        g = eg === 'm' ? 'f' : eg === 'f' ? 'm' : 'x';
      }
    }
  }
  setGender(g);
  $('mDelete').classList.toggle('hidden', !editing);
  $('modalBack').classList.remove('hidden');
  $('fName').focus();
}

function closeModal() { $('modalBack').classList.add('hidden'); modalCtx = null; }

function saveModal() {
  if (!modalCtx) return;
  const fields = {
    name: $('fName').value,
    birth: $('fBirth').value,
    death: $('fDeath').value,
    note: $('fNote').value,
    gender: modalGender,
  };
  const { mode, targetId, unionId } = modalCtx;
  closeModal();
  if (mode === 'edit') {
    updatePerson(targetId, fields);
  } else if (mode === 'root') {
    pushUndo();
    const p = createPerson(fields);
    selected = p.id;
    afterMutation();
    autoFit(true);
  } else {
    addRelative(mode, targetId, fields, unionId);
  }
}

$('mSave').addEventListener('click', saveModal);
$('mCancel').addEventListener('click', closeModal);
$('mDelete').addEventListener('click', () => {
  if (!modalCtx || modalCtx.mode !== 'edit') return;
  const pid = modalCtx.targetId;
  closeModal();
  deletePerson(pid);
});
$('modalBack').addEventListener('pointerdown', e => {
  if (e.target === $('modalBack')) closeModal();
});
$('chooserBack').addEventListener('pointerdown', e => {
  if (e.target === $('chooserBack')) $('chooserBack').classList.add('hidden');
});
document.querySelectorAll('#fGender button').forEach(b =>
  b.addEventListener('click', () => setGender(b.dataset.g)));
['fName', 'fBirth', 'fDeath', 'fNote'].forEach(id =>
  $(id).addEventListener('keydown', e => { if (e.key === 'Enter') saveModal(); }));

/* ============================== export ============================== */

function buildExportSvg(scale) {
  const L = computeLayout();
  if (!L.bbox) return null;
  const pad = 48, titleH = 64;
  const w = L.bbox.w + pad * 2;
  const h = L.bbox.h + pad * 2 + titleH;
  const svg = el('svg', {
    xmlns: SVGNS,
    width: Math.round(w * scale),
    height: Math.round(h * scale),
    viewBox: `${L.bbox.x - pad} ${L.bbox.y - pad - titleH} ${w} ${h}`,
  });
  el('rect', {
    x: L.bbox.x - pad, y: L.bbox.y - pad - titleH,
    width: w, height: h, fill: '#ffffff',
  }, svg);
  txt(svg, L.bbox.x + L.bbox.w / 2, L.bbox.y - pad - titleH + 42, state.title, {
    'font-size': 26, 'font-weight': 700, fill: '#111827', 'text-anchor': 'middle',
  });
  const g = el('g', {}, svg);
  drawScene(g, L, { interactive: false });
  return { svg, w: Math.round(w * scale), h: Math.round(h * scale), wCss: w, hCss: h };
}

function svgToCanvas(built) {
  return new Promise((resolve, reject) => {
    const str = new XMLSerializer().serializeToString(built.svg);
    const url = URL.createObjectURL(new Blob([str], { type: 'image/svg+xml;charset=utf-8' }));
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = built.w; c.height = built.h;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c);
    };
    img.onerror = e => { URL.revokeObjectURL(url); reject(e); };
    img.src = url;
  });
}

function download(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

function safeName() {
  return (state.title || 'family-tree').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'family-tree';
}

async function exportPng() {
  const built = buildExportSvg(2);
  if (!built) return;
  const c = await svgToCanvas(built);
  c.toBlob(b => download(b, safeName() + '.png'), 'image/png');
}

/* Minimal single-page PDF with an embedded JPEG — no libraries needed. */
function jpegToPdf(jpegBytes, wPx, hPx, wPt, hPt) {
  const enc = new TextEncoder();
  const chunks = [];
  let offset = 0;
  const objOffsets = [];
  const push = s => {
    const b = typeof s === 'string' ? enc.encode(s) : s;
    chunks.push(b);
    offset += b.length;
  };
  const beginObj = n => { objOffsets[n] = offset; push(`${n} 0 obj\n`); };

  push('%PDF-1.4\n%âãÏÓ\n');
  beginObj(1); push('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  beginObj(2); push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
  beginObj(3);
  push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${wPt.toFixed(2)} ${hPt.toFixed(2)}] ` +
    '/Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n');
  beginObj(4);
  push(`<< /Type /XObject /Subtype /Image /Width ${wPx} /Height ${hPx} ` +
    `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.length} >>\nstream\n`);
  push(jpegBytes);
  push('\nendstream\nendobj\n');
  const content = `q ${wPt.toFixed(2)} 0 0 ${hPt.toFixed(2)} 0 0 cm /Im1 Do Q`;
  beginObj(5);
  push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`);
  const xrefStart = offset;
  let xref = 'xref\n0 6\n0000000000 65535 f \n';
  for (let i = 1; i <= 5; i++) xref += String(objOffsets[i]).padStart(10, '0') + ' 00000 n \n';
  push(xref);
  push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`);
  const total = new Uint8Array(offset);
  let o = 0;
  for (const c of chunks) { total.set(c, o); o += c.length; }
  return new Blob([total], { type: 'application/pdf' });
}

async function exportPdf() {
  const built = buildExportSvg(2);
  if (!built) return;
  const c = await svgToCanvas(built);
  const dataUrl = c.toDataURL('image/jpeg', 0.93);
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  // 1 CSS px = 0.75pt; the canvas is rendered at 2x for sharpness
  const blob = jpegToPdf(bytes, c.width, c.height, built.wCss * 0.75, built.hCss * 0.75);
  download(blob, safeName() + '.pdf');
}

/* ============================== XML save / open ============================== */

const escXml = s => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');

function toXml() {
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>'];
  lines.push(`<familyTree app="family-tree-builder" version="1" title="${escXml(state.title)}">`);
  for (const p of persons()) {
    let attrs = ` id="${escXml(p.id)}" name="${escXml(p.name)}" gender="${escXml(p.gender)}"`;
    if (p.birth) attrs += ` birth="${escXml(p.birth)}"`;
    if (p.death) attrs += ` death="${escXml(p.death)}"`;
    if (p.note) attrs += ` note="${escXml(p.note)}"`;
    lines.push(`  <person${attrs}/>`);
  }
  for (const u of unions()) {
    lines.push(`  <union id="${escXml(u.id)}">`);
    u.partners.forEach(pid => lines.push(`    <partner ref="${escXml(pid)}"/>`));
    u.children.forEach(pid => lines.push(`    <child ref="${escXml(pid)}"/>`));
    lines.push('  </union>');
  }
  lines.push('</familyTree>');
  return lines.join('\n') + '\n';
}

function parseXml(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Not valid XML.');
  const root = doc.documentElement;
  if (root.nodeName !== 'familyTree') {
    throw new Error(`Expected a <familyTree> root element, found <${root.nodeName}>.`);
  }
  const next = { title: root.getAttribute('title') || 'My Family Tree', seq: 0, persons: {}, unions: {} };
  let maxSeq = 0;
  const bumpSeq = id => {
    const m = /(\d+)$/.exec(id);
    if (m) maxSeq = Math.max(maxSeq, parseInt(m[1], 10));
  };
  for (const e of root.querySelectorAll(':scope > person')) {
    const id = e.getAttribute('id');
    if (!id || next.persons[id]) throw new Error('Every <person> needs a unique id attribute.');
    const g = e.getAttribute('gender');
    next.persons[id] = {
      id,
      name: (e.getAttribute('name') || '').trim() || 'Unnamed',
      gender: ['f', 'm', 'x'].includes(g) ? g : 'x',
      birth: e.getAttribute('birth') || '',
      death: e.getAttribute('death') || '',
      note: e.getAttribute('note') || '',
      parentUnion: null,
    };
    bumpSeq(id);
  }
  for (const e of root.querySelectorAll(':scope > union')) {
    const id = e.getAttribute('id');
    if (!id || next.unions[id]) throw new Error('Every <union> needs a unique id attribute.');
    const refs = sel => [...e.querySelectorAll(`:scope > ${sel}`)]
      .map(c => c.getAttribute('ref'))
      .filter(r => {
        if (!next.persons[r]) throw new Error(`<union id="${id}"> refers to unknown person "${r}".`);
        return true;
      });
    const partners = [...new Set(refs('partner'))];
    if (partners.length > 2) throw new Error(`<union id="${id}"> has more than two partners.`);
    // a person can only descend from one union; first one listed wins
    const children = [...new Set(refs('child'))]
      .filter(c => next.persons[c].parentUnion === null && !partners.includes(c));
    if (partners.length + children.length < 2) continue; // nothing to connect
    next.unions[id] = { id, partners, children };
    children.forEach(c => { next.persons[c].parentUnion = id; });
    bumpSeq(id);
  }
  next.seq = maxSeq;
  return next;
}

function openXmlText(text, sourceName) {
  let next;
  try {
    next = parseXml(text);
  } catch (err) {
    alert(`Couldn't open ${sourceName || 'that file'}: ${err.message}`);
    return;
  }
  if (persons().length) pushUndo();
  state = next;
  selected = null;
  $('treeTitle').value = state.title;
  document.title = (state.title || 'Family Tree') + ' — Family Tree Builder';
  render();
  autoFit(true);
}

function exportXml() {
  if (!persons().length) return;
  download(new Blob([toXml()], { type: 'application/xml' }), safeName() + '.xml');
}

function openXmlFile(file) {
  if (!file) return;
  file.text().then(text => openXmlText(text, file.name));
}

$('btnXml').addEventListener('click', exportXml);
$('btnOpen').addEventListener('click', () => $('fileOpen').click());
$('btnOpen2').addEventListener('click', () => $('fileOpen').click());
$('fileOpen').addEventListener('change', e => {
  openXmlFile(e.target.files[0]);
  e.target.value = '';
});
// drag & drop a saved .xml anywhere onto the canvas
const stage = $('stage');
stage.addEventListener('dragover', e => e.preventDefault());
stage.addEventListener('drop', e => {
  e.preventDefault();
  openXmlFile(e.dataTransfer.files && e.dataTransfer.files[0]);
});

/* ============================== example ============================== */

function loadExample() {
  pushUndo();
  state.persons = {}; state.unions = {}; state.seq = 0;
  state.title = 'The Sharma Family';
  $('treeTitle').value = state.title;
  const P = (name, gender, birth, death) => createPerson({ name, gender, birth, death });
  const arjun = P('Arjun Sharma', 'm', '1938', '2011');
  const meera = P('Meera Sharma', 'f', '1942', '');
  const rajesh = P('Rajesh Sharma', 'm', '1965', '');
  const sunita = P('Sunita Rao', 'f', '1968', '');
  const vikram = P('Vikram Sharma', 'm', '1972', '');
  const priya = P('Priya Sharma', 'f', '1967', '');
  const daniel = P('Daniel Rao', 'm', '1966', '');
  const aarav = P('Aarav Sharma', 'm', '1992', '');
  const diya = P('Diya Sharma', 'f', '1995', '');
  const kabir = P('Kabir Sharma', 'm', '1999', '');
  const maya = P('Maya Rao', 'f', '1998', '');
  const sara = P('Sara Sharma', 'f', '1994', '');
  const zoya = P('Zoya Sharma', 'f', '2022', '');
  createUnion([arjun.id, meera.id], [rajesh.id, sunita.id, vikram.id]);
  createUnion([rajesh.id, priya.id], [aarav.id, diya.id, kabir.id]);
  createUnion([sunita.id, daniel.id], [maya.id]);
  createUnion([aarav.id, sara.id], [zoya.id]);
  selected = rajesh.id;
  render();
  autoFit(true);
}

/* ============================== toolbar wiring ============================== */

$('btnFirst').addEventListener('click', () => openModal('root'));
$('btnExample').addEventListener('click', loadExample);
$('btnExample2').addEventListener('click', loadExample);
$('btnUndo').addEventListener('click', undo);
$('btnClear').addEventListener('click', () => {
  if (!persons().length) return;
  if (!confirm('Remove everyone from the tree? (Undo can bring them back.)')) return;
  pushUndo();
  state.persons = {}; state.unions = {};
  selected = null;
  render();
});
$('btnZoomIn').addEventListener('click', () => {
  const r = canvas.getBoundingClientRect();
  zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1.25);
});
$('btnZoomOut').addEventListener('click', () => {
  const r = canvas.getBoundingClientRect();
  zoomAt(r.left + r.width / 2, r.top + r.height / 2, 0.8);
});
$('btnFit').addEventListener('click', () => autoFit(true));
$('btnPng').addEventListener('click', exportPng);
$('btnPdf').addEventListener('click', exportPdf);

$('treeTitle').addEventListener('input', e => {
  state.title = e.target.value;
  document.title = (state.title || 'Family Tree') + ' — Family Tree Builder';
});

document.addEventListener('keydown', e => {
  const typing = /INPUT|TEXTAREA/.test(document.activeElement.tagName);
  if (e.key === 'Escape') {
    if (!$('modalBack').classList.contains('hidden')) closeModal();
    else if (!$('chooserBack').classList.contains('hidden')) $('chooserBack').classList.add('hidden');
    else if (selected) { selected = null; render(); }
    return;
  }
  if (typing) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
  if ((e.key === 'Delete' || e.key === 'Backspace') && selected) {
    e.preventDefault();
    deletePerson(selected);
  }
});

window.addEventListener('beforeunload', e => {
  if (persons().length) { e.preventDefault(); e.returnValue = ''; }
});

$('btnUndo').disabled = true;
render();

/* Exposed for automated testing only. */
window.__ftb = { state: () => state, addRelative, loadExample, exportPng, exportPdf, computeLayout, select: pid => select(pid) };
