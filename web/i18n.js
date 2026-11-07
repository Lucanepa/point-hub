// The console's languages: German and Swiss German over the English in the markup and the script.
//
// The board's `language` setting names the language; web/i18n/<language>.json holds the words, keyed
// by the English as displayed, and the tablet app's native Game tab reads the same files. Text with
// no entry stays English, so a gap is only ever a word in English. The Diagnostics tab, the mirror
// of the panel, team names and the match sheet (already German) are left alone.
(function () {
  const SKIP = "#tab-diag, #bvPanel, #sheet, script, style, textarea, .short";
  const ATTRS = ["title", "aria-label", "placeholder"];
  let dict = null;
  let language = "en";
  let observer = null;
  // What each node said in English and what it was changed to, so it can go back.
  const textOf = new WeakMap();
  const attrOf = new WeakMap();

  function lookup(s) {
    if (!dict) return null;
    const hit = Object.prototype.hasOwnProperty.call(dict.exact, s) ? dict.exact[s] : null;
    if (hit != null) return hit;
    for (const [re, to] of dict.patterns) if (re.test(s)) return s.replace(re, to);
    return null;
  }

  // Whitespace around a text node belongs to the layout, not to the words.
  function translated(raw) {
    const s = raw.trim().replace(/\s+/g, " ");
    if (!s || !/[A-Za-zÀ-ÿ]{2}/.test(s)) return null;
    const to = lookup(s);
    if (to == null) return null;
    return raw.match(/^\s*/)[0] + to + raw.match(/\s*$/)[0];
  }

  // The console compares this label with its English words to know which card is up.
  function noteLabel(node, english) {
    const el = node.parentElement;
    if (!el || el.id !== "cdLabel") return;
    if (english) el.dataset.en = english;
    else delete el.dataset.en;
  }

  function doText(node) {
    const el = node.parentElement;
    if (!el || el.closest(SKIP)) return;
    const was = textOf.get(node);
    if (was && was.shown === node.data) return;
    const to = translated(node.data);
    if (to == null) { textOf.delete(node); noteLabel(node, null); return; }
    const english = node.data;
    textOf.set(node, { english, shown: to });
    noteLabel(node, english.trim());
    node.data = to;
  }

  function doAttrs(el) {
    if (el.closest(SKIP)) return;
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      if (!v) continue;
      const rec = attrOf.get(el) || {};
      if (rec[a] && rec[a].shown === v) continue;
      const to = translated(v);
      if (to == null) continue;
      rec[a] = { english: v, shown: to };
      attrOf.set(el, rec);
      el.setAttribute(a, to);
    }
  }

  function walk(root) {
    if (root.nodeType === 3) { doText(root); return; }
    if (root.nodeType !== 1) return;
    doAttrs(root);
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    while (w.nextNode()) {
      if (w.currentNode.nodeType === 3) doText(w.currentNode);
      else doAttrs(w.currentNode);
    }
  }

  function restore() {
    const w = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    while (w.nextNode()) {
      const n = w.currentNode;
      if (n.nodeType === 3) {
        const rec = textOf.get(n);
        if (rec && rec.shown === n.data) n.data = rec.english;
        textOf.delete(n);
        noteLabel(n, null);
      } else {
        const rec = attrOf.get(n);
        if (rec) for (const a of ATTRS) if (rec[a] && rec[a].shown === n.getAttribute(a)) n.setAttribute(a, rec[a].english);
        attrOf.delete(n);
      }
    }
  }

  function observe() {
    if (observer) return;
    observer = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === "characterData") doText(r.target);
        else if (r.type === "attributes") doAttrs(r.target);
        else r.addedNodes.forEach(walk);
      }
    });
    observer.observe(document.documentElement, {
      subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS,
    });
  }

  function stop() {
    if (observer) observer.disconnect();
    observer = null;
  }

  async function set(next) {
    const wanted = next === "de" || next === "de-CH" ? next : "en";
    if (wanted === language) return;
    language = wanted;
    let words = null;
    if (wanted !== "en") {
      try {
        const r = await fetch("/i18n/" + wanted + ".json");
        words = r.ok ? await r.json() : null;
      } catch { /* below */ }
      if (language !== wanted) return;   // changed again while this was loading
      if (!words) { language = "en"; return; }   // the next status tries again
    }
    stop();
    restore();
    dict = words && {
      exact: words.exact || {},
      patterns: (words.patterns || []).map(([re, to]) => [new RegExp(re), to]),
    };
    document.documentElement.lang = wanted;
    if (dict) { walk(document.documentElement); observe(); }
  }

  window.PointHubI18n = Object.freeze({ set });
})();
