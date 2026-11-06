// Corpus-level translation metrics, matching sacreBLEU's defaults:
//   BLEU: 13a tokenization, 1–4-grams, brevity penalty, no smoothing.
//   chrF: character 1–6-grams, beta 2, whitespace removed ("chrF2").
// Plain Node, no dependencies, so the scores can be reproduced anywhere.

/** mteval-v13a tokenization, as in sacreBLEU's "13a". */
function tok13a(line) {
  let s = line.replace(/<skipped>/g, "").replace(/-\n/g, "").replace(/\n/g, " ");
  if (s.includes("&")) s = s.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  s = ` ${s} `;
  s = s.replace(/([{-~[-` -&(-+:-@/])/g, " $1 ");
  s = s.replace(/([^0-9])([.,])/g, "$1 $2 ");
  s = s.replace(/([.,])([^0-9])/g, " $1 $2");
  s = s.replace(/([0-9])(-)/g, "$1 $2 ");
  return s.split(/\s+/).filter(Boolean);
}

function ngrams(tokens, n) {
  const m = new Map();
  for (let i = 0; i + n <= tokens.length; i++) {
    const k = tokens.slice(i, i + n).join("\u0001");
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

/** Corpus BLEU (0–100) of hypotheses against one reference each. */
export function bleu(hyps, refs) {
  const match = [0, 0, 0, 0];
  const total = [0, 0, 0, 0];
  let hypLen = 0;
  let refLen = 0;
  hyps.forEach((h, i) => {
    const ht = tok13a(h);
    const rt = tok13a(refs[i]);
    hypLen += ht.length;
    refLen += rt.length;
    for (let n = 1; n <= 4; n++) {
      const hg = ngrams(ht, n);
      const rg = ngrams(rt, n);
      for (const [k, c] of hg) match[n - 1] += Math.min(c, rg.get(k) ?? 0);
      total[n - 1] += Math.max(ht.length - n + 1, 0);
    }
  });
  if (match.some((m) => m === 0)) return 0;
  const logp = match.reduce((s, m, i) => s + Math.log(m / total[i]), 0) / 4;
  const bp = hypLen > refLen ? 1 : Math.exp(1 - refLen / hypLen);
  return 100 * bp * Math.exp(logp);
}

function charNgrams(s, n) {
  const chars = [...s.replace(/\s+/g, "")];
  const m = new Map();
  for (let i = 0; i + n <= chars.length; i++) {
    const k = chars.slice(i, i + n).join("");
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

/** Corpus chrF (0–100): character n-gram F-score, recall weighted by beta. */
export function chrf(hyps, refs, order = 6, beta = 2) {
  const stats = Array.from({ length: order }, () => ({ match: 0, hyp: 0, ref: 0 }));
  hyps.forEach((h, i) => {
    for (let n = 1; n <= order; n++) {
      const hg = charNgrams(h, n);
      const rg = charNgrams(refs[i], n);
      const st = stats[n - 1];
      for (const [k, c] of hg) {
        st.match += Math.min(c, rg.get(k) ?? 0);
        st.hyp += c;
      }
      for (const c of rg.values()) st.ref += c;
    }
  });
  let p = 0;
  let r = 0;
  let k = 0;
  for (const st of stats) {
    if (st.hyp > 0 && st.ref > 0) {
      p += st.match / st.hyp;
      r += st.match / st.ref;
      k++;
    }
  }
  if (!k) return 0;
  p /= k;
  r /= k;
  if (p + r === 0) return 0;
  const b2 = beta * beta;
  return (100 * (1 + b2) * p * r) / (b2 * p + r);
}
