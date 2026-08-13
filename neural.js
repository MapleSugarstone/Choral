/* neural.js - the trained networks, playing in the browser.

   This is a port of sim/Net.cs and sim/NeuralPol.cs, and it has to agree with
   them to the last decimal: a network is rated in the simulator, and if the
   browser plays it even slightly differently then the rating on the menu is
   describing an opponent the player never faces.  choralNetSelfTest() checks
   exactly that against a fixture the simulator wrote, and it is the only thing
   standing between "ported" and "ported correctly".

   Nothing here touches Ivy.  Gentle, Steady and Sharp are untouched and remain
   what the game opens on; these are extra opponents that appear underneath them.

   Layout note, carried over from the C# side: feature planes are padded to
   (n+2) squared with a ring of zeros, so a 3x3 tap is a fixed offset and the
   board edge needs no special case.  The halo is re-zeroed after every output
   channel because the vector run writes rubbish there. */
(function (global) {
  'use strict';

  /* ---------------------------------------------------------------- loading */
  function b64ToF32(s) {
    const bin = atob(s);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    // explicit little-endian: the simulator writes raw x86 float32
    const dv = new DataView(bytes.buffer);
    const out = new Float32Array(bytes.length >> 2);
    for (let i = 0; i < out.length; i++) out[i] = dv.getFloat32(i << 2, true);
    return out;
  }

  function Geom(n) {
    const S = n + 2, P = S * S, cells = n * n;
    const map = new Int32Array(cells);
    for (let i = 0; i < cells; i++) map[i] = (((i / n) | 0) + 1) * S + (i % n) + 1;
    const off = new Int32Array(9);
    for (let t = 0; t < 9; t++) off[t] = (((t / 3) | 0) - 1) * S + (t % 3) - 1;
    return { n, S, P, cells, map, off, lo: S + 1, len: P - 2 * S - 2 };
  }

  function ChoralNet(doc) {
    this.doc = doc;
    this.name = doc.name;
    this.arch = doc.arch;
    this.planes = doc.planes;
    this.rating = doc.rating;
    this.style = doc.style;
    const T = {};
    for (const k in doc.tensors) T[k] = b64ToF32(doc.tensors[k]);
    this.T = T;
    this.G = null;                      // sized on first use, and re-sized on demand
    this.Pooled = new Float32Array(this.arch.channels);
    this.VFeat = new Float32Array(2 * this.arch.valueCh);
    this.VHid = new Float32Array(this.arch.valueHidden);
    this.value = 0; this.score = 0;
    this._size(doc.board || 9);
  }

  /* Every layer is convolutional and the heads pool, so the WEIGHTS know
     nothing about the board size - only these buffers do.  Trained on 9x9,
     measured on the other sizes: it holds 92-97% against the scripted brains
     on 7x7 and 11x11 without ever having seen either.  A board change costs
     one reallocation and is then cached until the next change. */
  ChoralNet.prototype._size = function (n) {
    if (this.G && this.G.n === n) return;
    this.G = Geom(n);
    const c = this.arch.channels, P = this.G.P;
    this.X = new Float32Array(this.planes * P);
    this.H = []; for (let i = 0; i <= this.arch.blocks; i++) this.H.push(new Float32Array(c * P));
    this.M = []; for (let i = 0; i < this.arch.blocks; i++) this.M.push(new Float32Array(c * P));
    this.Pol = new Float32Array(2 * P);
    this.Val = new Float32Array(this.arch.valueCh * P);
    this.Own = new Float32Array(P);
    this.logits = new Float32Array(2 * this.G.cells + 1);
    this._seen = new Int32Array(this.G.cells);
    this._grp = new Int32Array(this.G.cells);
  };

  /* ------------------------------------------------------------- primitives */
  function zeroHalo(a, b, S) {
    for (let c = 0; c < S; c++) { a[b + c] = 0; a[b + (S - 1) * S + c] = 0; }
    for (let r = 1; r < S - 1; r++) { a[b + r * S] = 0; a[b + r * S + S - 1] = 0; }
  }

  /* Two output channels per pass over the input.
     There is no SIMD available here, so what costs is memory traffic, not
     arithmetic: a 3x3 tap over 32 input channels reads the input array nine
     times per channel pair, and doing one output channel at a time re-reads all
     of it for every one of them.  Loading the nine input values into locals once
     and spending them on two output channels halves those reads, which is most
     of the run time.  The odd channel at the end, if OC is odd, falls through to
     the single-channel path. */
  ChoralNet.prototype._conv3 = function (inp, outp, W, B, IC, OC) {
    const G = this.G, P = G.P, lo = G.lo, len = G.len, o = G.off;
    const o0 = o[0], o1 = o[1], o2 = o[2], o3 = o[3], o4 = o[4], o5 = o[5], o6 = o[6], o7 = o[7], o8 = o[8];
    let oc = 0;
    for (; oc + 1 < OC; oc += 2) {
      const obA = oc * P, obB = (oc + 1) * P;
      outp.fill(B[oc], obA, obA + P);
      outp.fill(B[oc + 1], obB, obB + P);
      for (let ic = 0; ic < IC; ic++) {
        const wa = (oc * IC + ic) * 9, wbi = ((oc + 1) * IC + ic) * 9;
        const a0 = W[wa], a1 = W[wa + 1], a2 = W[wa + 2], a3 = W[wa + 3], a4 = W[wa + 4],
              a5 = W[wa + 5], a6 = W[wa + 6], a7 = W[wa + 7], a8 = W[wa + 8];
        const b0 = W[wbi], b1 = W[wbi + 1], b2 = W[wbi + 2], b3 = W[wbi + 3], b4 = W[wbi + 4],
              b5 = W[wbi + 5], b6 = W[wbi + 6], b7 = W[wbi + 7], b8 = W[wbi + 8];
        const deadA = a0 === 0 && a1 === 0 && a2 === 0 && a3 === 0 && a4 === 0 && a5 === 0 && a6 === 0 && a7 === 0 && a8 === 0;
        const deadB = b0 === 0 && b1 === 0 && b2 === 0 && b3 === 0 && b4 === 0 && b5 === 0 && b6 === 0 && b7 === 0 && b8 === 0;
        if (deadA && deadB) continue;
        const ib = ic * P + lo, dA = obA + lo, dB = obB + lo;
        for (let i = 0; i < len; i++) {
          const s = ib + i;
          const v0 = inp[s + o0], v1 = inp[s + o1], v2 = inp[s + o2],
                v3 = inp[s + o3], v4 = inp[s + o4], v5 = inp[s + o5],
                v6 = inp[s + o6], v7 = inp[s + o7], v8 = inp[s + o8];
          outp[dA + i] += a0 * v0 + a1 * v1 + a2 * v2 + a3 * v3 + a4 * v4 + a5 * v5 + a6 * v6 + a7 * v7 + a8 * v8;
          outp[dB + i] += b0 * v0 + b1 * v1 + b2 * v2 + b3 * v3 + b4 * v4 + b5 * v5 + b6 * v6 + b7 * v7 + b8 * v8;
        }
      }
      zeroHalo(outp, obA, G.S); zeroHalo(outp, obB, G.S);
    }
    for (; oc < OC; oc++) {
      const ob = oc * P;
      outp.fill(B[oc], ob, ob + P);
      for (let ic = 0; ic < IC; ic++) {
        const wb = (oc * IC + ic) * 9;
        const w0 = W[wb], w1 = W[wb + 1], w2 = W[wb + 2], w3 = W[wb + 3], w4 = W[wb + 4],
              w5 = W[wb + 5], w6 = W[wb + 6], w7 = W[wb + 7], w8 = W[wb + 8];
        if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0 && w6 === 0 && w7 === 0 && w8 === 0) continue;
        const ib = ic * P + lo, db = ob + lo;
        for (let i = 0; i < len; i++) {
          const s = ib + i;
          outp[db + i] += w0 * inp[s + o0] + w1 * inp[s + o1] + w2 * inp[s + o2]
                        + w3 * inp[s + o3] + w4 * inp[s + o4] + w5 * inp[s + o5]
                        + w6 * inp[s + o6] + w7 * inp[s + o7] + w8 * inp[s + o8];
        }
      }
      zeroHalo(outp, ob, G.S);
    }
  };

  ChoralNet.prototype._conv1 = function (inp, outp, W, B, IC, OC) {
    const G = this.G, P = G.P, lo = G.lo, len = G.len;
    for (let oc = 0; oc < OC; oc++) {
      const ob = oc * P;
      outp.fill(B[oc], ob, ob + P);
      for (let ic = 0; ic < IC; ic++) {
        const w = W[oc * IC + ic];
        if (w === 0) continue;
        const ib = ic * P + lo, db = ob + lo;
        for (let i = 0; i < len; i++) outp[db + i] += w * inp[ib + i];
      }
      zeroHalo(outp, ob, G.S);
    }
  };

  function relu(a) { for (let i = 0; i < a.length; i++) if (a[i] < 0) a[i] = 0; }
  function addRelu(d, s) { for (let i = 0; i < d.length; i++) { const v = d[i] + s[i]; d[i] = v < 0 ? 0 : v; } }
  function tanh(x) { return Math.tanh(x); }

  ChoralNet.prototype.run = function () {
    const T = this.T, A = this.arch, G = this.G, P = G.P, c = A.channels, cells = G.cells;
    this._conv3(this.X, this.H[0], T['stem.w'], T['stem.b'], A.inp, c); relu(this.H[0]);
    for (let b = 0; b < A.blocks; b++) {
      this._conv3(this.H[b], this.M[b], T['b' + b + '.1.w'], T['b' + b + '.1.b'], c, c); relu(this.M[b]);
      this._conv3(this.M[b], this.H[b + 1], T['b' + b + '.2.w'], T['b' + b + '.2.b'], c, c);
      addRelu(this.H[b + 1], this.H[b]);
    }
    const trunk = this.H[A.blocks];

    this._conv1(trunk, this.Pol, T['pol.w'], T['pol.b'], c, 2);
    for (let i = 0; i < cells; i++) {
      const pi = G.map[i];
      this.logits[i] = this.Pol[pi];
      this.logits[cells + i] = this.Pol[P + pi];
    }
    const pw = T['pass.w'];
    let passLogit = T['pass.b'][0];
    for (let ch = 0; ch < c; ch++) {
      let s = 0; const cb = ch * P;
      for (let i = 0; i < cells; i++) s += trunk[cb + G.map[i]];
      this.Pooled[ch] = s / cells;
      passLogit += pw[ch] * this.Pooled[ch];
    }
    this.logits[2 * cells] = passLogit;

    const vc = A.valueCh;
    this._conv1(trunk, this.Val, T['val.w'], T['val.b'], c, vc); relu(this.Val);
    for (let ch = 0; ch < vc; ch++) {
      const cb = ch * P; let s = 0, mx = -Infinity;
      for (let i = 0; i < cells; i++) { const v = this.Val[cb + G.map[i]]; s += v; if (v > mx) mx = v; }
      this.VFeat[ch] = s / cells; this.VFeat[vc + ch] = mx;
    }
    const hN = A.valueHidden, vf = 2 * vc, w1 = T['v1.w'], b1 = T['v1.b'];
    for (let h = 0; h < hN; h++) {
      let s = b1[h];
      for (let j = 0; j < vf; j++) s += w1[h * vf + j] * this.VFeat[j];
      this.VHid[h] = s < 0 ? 0 : s;
    }
    const w2 = T['v2.w'], b2 = T['v2.b'];
    let r0 = b2[0], r1 = b2[1];
    for (let h = 0; h < hN; h++) { r0 += w2[h] * this.VHid[h]; r1 += w2[hN + h] * this.VHid[h]; }
    this.value = tanh(r0); this.score = tanh(r1);

    this._conv1(trunk, this.Own, T['own.w'], T['own.b'], c, 1);
    for (let i = 0; i < cells; i++) { const pi = G.map[i]; this.Own[pi] = tanh(this.Own[pi]); }
  };

  /* ---------------------------------------------------------------- encoding
     This mirrors Enc.Fill plane for plane.  If it drifts, the network is being
     shown a board it was never trained on, and it will play like nonsense while
     looking perfectly healthy - which is why the fixture check exists. */
  ChoralNet.prototype.encode = function (g) {
    this._size(g.cfg.n);
    const G = this.G, P = G.P, cells = G.cells, x = this.X;
    const me = g.toMove(), foe = 3 - me;
    x.fill(0);
    const set = (plane, cell, v) => { x[plane * P + G.map[cell]] = v; };
    const bcast = (plane, v) => { const b = plane * P; for (let i = 0; i < cells; i++) x[b + G.map[i]] = v; };

    // Both stamps are taken before the scratch handle is captured: doubledStamp
    // calls scratch() itself, and holding a handle across that would go stale if
    // it ever reallocated.  The two marks never collide, because a square cannot
    // be held by both sides.
    const vMe = g.doubledStamp(me), vFoe = g.doubledStamp(foe);
    const S = scratch(cells);

    for (let i = 0; i < cells; i++) {
      const k = g.kind[i];
      if (k === EMPTY) { set(12, i, 1); continue; }
      const mine = g.own[i] === me;
      if (k === PIECE) {
        const sh = g.shp[i];
        if (sh === DEUS) set(mine ? 3 : 7, i, 1);
        else set((mine ? 0 : 4) + sh, i, 1);
      } else {
        const town = g.claimCell[i] !== 0;
        set((mine ? 8 : 10) + (town ? 1 : 0), i, 1);
        const ver = mine ? vMe : vFoe;
        if (ver >= 0 && S.dm[i] === ver) set(mine ? 13 : 14, i, 1);
      }
    }

    // liberty buckets, one flood per band.  The two scratch arrays are owned by
    // the net rather than allocated here: this runs once per tree node, and a
    // pair of fresh typed arrays per evaluation is real time at a few hundred
    // evaluations a move.
    const seen = this._seen, grp = this._grp;
    seen.fill(0);
    for (let i = 0; i < cells; i++) {
      if (g.kind[i] !== PIECE || seen[i]) continue;
      const r = g.groupLibs(i, grp);
      const bucket = r.libs <= 1 ? 0 : (r.libs === 2 ? 1 : 2);
      const plane = (g.own[i] === me ? 15 : 18) + bucket;
      for (let q = 0; q < r.n; q++) { seen[grp[q]] = 1; set(plane, grp[q], 1); }
    }

    const mv = g.moves();
    for (const m of mv) set(21, m, 1);
    if (g.last >= 0 && g.last < cells) set(22, g.last, 1);
    for (let i = 0; i < cells; i++) {
      if (g.cfg.nbr[i].length < 4) set(23, i, 1);
      if (g.cfg.nbr[i].length === 2) set(24, i, 1);
    }

    bcast(25 + g.curRank(), 1);
    if (g.hasDeus(me)) bcast(28, 1);
    if (g.hasDeus(foe)) bcast(29, 1);
    bcast(30, g.left(me) / g.budget);
    bcast(31, g.left(foe) / g.budget);
    bcast(32, g.score[me - 1] / 40);
    bcast(33, g.score[foe - 1] / 40);
    bcast(34, g.ply / (2 * g.budget));
    let empt = 0; for (let i = 0; i < cells; i++) if (g.kind[i] === EMPTY) empt++;
    bcast(35, empt / cells);
    if (g.canDeus(me)) bcast(36, 1);
    if (g.canDeus(foe)) bcast(37, 1);
    const dl = g.deadline();
    bcast(38, Math.max(0, g.left(me) - dl) / g.budget);
    bcast(39, Math.max(0, g.left(foe) - dl) / g.budget);
  };

  /* Which actions the search may consider — a mirror of Enc.Legal in the
     simulator, and it MUST stay a mirror.

     This is not merely the rules: it is the same restriction every policy in the
     game uses (the rim, or a square beside an occupied one), with the Deus
     narrowed further to squares touching your own holdings once you are
     developed. The network's policy head is trained with its softmax normalised
     over exactly this set, so widening it here would feed the net a support it
     never saw and quietly change every probability it reports. If the two
     definitions drift apart, choralNetSelfTest() fails — which is what it is
     for. */
  function legalMask(g, cells, out) {
    out.fill(false);
    const me = g.toMove();
    if (!g.canPlay(me)) { out[2 * cells] = true; return 1; }
    const mv = g.moves();
    const deus = g.canDeus(me);
    const developed = g.stones[me - 1] >= 4;
    let count = 0;
    for (const i of mv) {
      const nb = g.cfg.nbr[i];
      let near = nb.length < 4, touchMine = false;      // rim counts as a candidate
      for (let k = 0; k < nb.length; k++) {
        const m = nb[k];
        if (g.kind[m] === EMPTY) continue;
        near = true;
        if (g.own[m] === me) { touchMine = true; break; }
      }
      if (!near) continue;
      out[i] = true; count++;
      if (deus && developed && touchMine) { out[cells + i] = true; count++; }
    }
    if (count === 0) { for (const m of mv) { out[m] = true; count++; } }
    if (count === 0) { out[2 * cells] = true; count = 1; }
    return count;
  }

  ChoralNet.prototype.policy = function (legal, out) {
    const n = this.logits.length;
    let mx = -Infinity;
    for (let i = 0; i < n; i++) if (legal[i] && this.logits[i] > mx) mx = this.logits[i];
    if (mx === -Infinity) { out.fill(0); return; }
    let sum = 0;
    for (let i = 0; i < n; i++) {
      if (!legal[i]) { out[i] = 0; continue; }
      const e = Math.exp(this.logits[i] - mx); out[i] = e; sum += e;
    }
    const inv = sum > 0 ? 1 / sum : 0;
    for (let i = 0; i < n; i++) out[i] *= inv;
  };

  /* -------------------------------------------------------------------- PUCT
     The same search the simulator rates: no rollouts at all, the whole budget
     spent on the tree, with the network supplying both the value of a leaf and
     the prior over which squares are worth reading. */
  function puct(net, g, opts) {
    opts = opts || {};
    const sims = opts.sims || 160;
    const cpuct = opts.cpuct === undefined ? 1.35 : opts.cpuct;
    const fpu = opts.fpu === undefined ? 0.30 : opts.fpu;
    const scoreW = opts.scoreWeight === undefined ? 0.22 : opts.scoreWeight;
    const deadline = opts.deadlineMs ? performance.now() + opts.deadlineMs : Infinity;
    const cells = g.cfg.cc;
    const nActs = 2 * cells + 1;
    const legal = new Array(nActs);
    const probs = new Float32Array(nActs);

    function evaluate(state) {
      legalMask(state, cells, legal);
      net.encode(state);
      net.run();
      net.policy(legal, probs);
      const acts = [];
      for (let i = 0; i < nActs; i++) if (legal[i]) acts.push(i);
      const pri = new Float32Array(acts.length);
      let sum = 0;
      for (let i = 0; i < acts.length; i++) { pri[i] = probs[acts[i]]; sum += pri[i]; }
      if (sum <= 1e-6) pri.fill(1 / Math.max(1, acts.length));
      else for (let i = 0; i < acts.length; i++) pri[i] /= sum;
      let v = net.value + scoreW * net.score;
      v = v < -1 ? -1 : (v > 1 ? 1 : v);
      return { acts, pri, v };
    }
    function terminalValue(state) {
      const me = state.toMove();
      const d = state.score[me - 1] - state.score[2 - me];
      return d > 0 ? 1 : (d < 0 ? -1 : 0);
    }
    function newNode(state) {
      if (state.over()) return { terminal: true, v: terminalValue(state), acts: null };
      return { terminal: false, v: 0, acts: null };
    }
    function expand(node, state) {
      const e = evaluate(state);
      node.acts = e.acts; node.P = e.pri; node.v = e.v;
      node.W = new Float64Array(e.acts.length);
      node.N = new Int32Array(e.acts.length);
      node.kid = new Array(e.acts.length);
      node.nsum = 0;
    }
    function pick(node) {
      const sq = Math.sqrt(Math.max(1, node.nsum));
      let q = 0, seen = 0, pSeen = 0;
      for (let i = 0; i < node.acts.length; i++) if (node.N[i] > 0) { q += node.W[i]; seen += node.N[i]; pSeen += node.P[i]; }
      const parentQ = seen > 0 ? q / seen : 0;
      const unseen = parentQ - fpu * Math.sqrt(Math.max(0, pSeen));
      let best = 0, bv = -Infinity;
      for (let i = 0; i < node.acts.length; i++) {
        const qq = node.N[i] > 0 ? node.W[i] / node.N[i] : unseen;
        const u = cpuct * node.P[i] * sq / (1 + node.N[i]);
        const v = qq + u;
        if (v > bv) { bv = v; best = i; }
      }
      return best;
    }

    const root = newNode(g);
    if (root.terminal) return { act: -1, visits: null };
    expand(root, g);

    const path = [];
    for (let s = 0; s < sims; s++) {
      if ((s & 15) === 0 && performance.now() > deadline) break;
      path.length = 0;
      let node = root;
      const st = g.clone();
      for (;;) {
        if (node.terminal) break;
        if (node.acts === null) { expand(node, st); break; }
        const e = pick(node);
        path.push([node, e]);
        const a = node.acts[e];
        const cell = a >= 2 * cells ? -1 : (a >= cells ? a - cells : a);
        st.play(cell, a >= cells && a < 2 * cells);
        if (!node.kid[e]) node.kid[e] = newNode(st);
        node = node.kid[e];
      }
      let v = node.v;
      for (let i = path.length - 1; i >= 0; i--) {
        v = -v;
        const nd = path[i][0], e = path[i][1];
        nd.N[e]++; nd.W[e] += v; nd.nsum++;
      }
    }
    let best = 0;
    for (let i = 1; i < root.N.length; i++) if (root.N[i] > root.N[best]) best = i;
    const a = root.acts[best];
    if (a >= 2 * cells) return { act: -1, visits: root.N };
    return {
      act: a >= cells ? { cell: a - cells, deus: true } : a,
      visits: root.N, acts: root.acts, value: root.v
    };
  }

  /* ---------------------------------------------------------------- registry */
  const loaded = {};
  function get(name) {
    if (loaded[name]) return loaded[name];
    const doc = (global.CHORAL_NETS || {})[name];
    if (!doc) return null;
    loaded[name] = new ChoralNet(doc);
    return loaded[name];
  }
  function list() {
    const out = [];
    for (const k in (global.CHORAL_NETS || {})) {
      const d = global.CHORAL_NETS[k];
      out.push({ name: k, rating: d.rating, style: d.style, note: d.note, role: d.role, pro: !!d.pro });
    }
    out.sort((a, b) => (b.rating || 0) - (a.rating || 0));
    return out;
  }

  /* Checks this port against the fixture the simulator produced.  Call
     choralNetSelfTest() from the console; it returns the worst deviation seen
     across value, margin and the policy of every fixture position. */
  function selfTest() {
    const fx = global.CHORAL_FIXTURE;
    if (!fx) return { ok: false, why: 'no fixture loaded' };
    const net = get(fx.net);
    if (!net) return { ok: false, why: 'fixture names a network that is not loaded: ' + fx.net };
    const cfg = makeCfg(9);
    let worstV = 0, worstP = 0, n = 0;
    const legal = new Array(2 * cfg.cc + 1);
    const probs = new Float32Array(2 * cfg.cc + 1);
    for (const c of fx.cases) {
      const g = new Game(cfg, c.budget);
      g.own.set(c.own); g.kind.set(c.kind); g.shp.set(c.shp); g.claimCell.set(c.fief);
      g.ply = c.ply; g.passes = c.passes; g.last = c.last;
      g.stones = c.stones.slice(); g.deusCell = c.lordCell.slice(); g.deusUsed = c.lordUsed.slice();
      g.rescore();
      legalMask(g, cfg.cc, legal);
      net.encode(g); net.run(); net.policy(legal, probs);
      worstV = Math.max(worstV, Math.abs(net.value - c.value), Math.abs(net.score - c.score));
      for (const t of c.top) worstP = Math.max(worstP, Math.abs(probs[t.act] - t.p));
      n++;
    }
    return { ok: worstV < 2e-4 && worstP < 2e-4, cases: n, worstValue: worstV, worstPolicy: worstP };
  }

  global.ChoralNeural = { get, list, puct, selfTest, legalMask, ChoralNet };
  global.choralNetSelfTest = selfTest;
})(window);
