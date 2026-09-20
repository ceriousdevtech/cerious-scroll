/**
 * The "How to build this" panel that every demo carries.
 *
 * A demo shows that a feature works; it does not show how to USE it, and the
 * source of these pages is mostly the fake dataset and the styling rather than
 * the handful of options that actually turn the feature on. This panel pulls
 * those options out and puts them next to the running thing.
 *
 * It is a <details>, collapsed by default, and it is deliberately NOT part of
 * the page's flex column of content. `.demo-scroll` is `flex: 1` over a parent
 * of fixed height, so anything that grows the column steals height from the
 * scroller — which is the engine's viewport. Open, the panel scrolls inside its
 * own capped box instead, and the scroller keeps every pixel it had.
 */
(function (root) {
  /** Minimal JS/HTML tokeniser, only as good as a snippet needs. */
  function highlight(src) {
    const escaped = src
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    // One pass, alternation ordered so comments and strings win before any
    // keyword inside them can match. Running separate passes instead lets a
    // later one rewrite the markup an earlier one just inserted.
    return escaped.replace(
      /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|('[^'\n]*'|"[^"\n]*"|`[^`]*`)|\b(const|let|var|function|return|new|if|else|for|of|in|async|await|import|from|export|class|true|false|null|undefined)\b|\b(\d[\d_]*)\b/g,
      (m, comment, str, kw, num) => {
        if (comment) return '<i class="tok-c">' + comment + '</i>';
        if (str) return '<i class="tok-s">' + str + '</i>';
        if (kw) return '<i class="tok-k">' + kw + '</i>';
        if (num) return '<i class="tok-n">' + num + '</i>';
        return m;
      }
    );
  }

  /** Trim a template literal down to its own left margin. */
  function dedent(src) {
    const lines = String(src).replace(/\t/g, '  ').split('\n');
    while (lines.length && !lines[0].trim()) lines.shift();
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    const indent = lines
      .filter((l) => l.trim())
      .reduce((min, l) => Math.min(min, l.match(/^ */)[0].length), Infinity);
    return lines.map((l) => l.slice(indent)).join('\n');
  }

  /**
   * Build and insert the panel.
   *
   * @param {object} config
   * @param {string} config.feature   What this demo demonstrates, one line.
   * @param {string} config.intro     A paragraph of prose. HTML allowed.
   * @param {string} config.code      The snippet that turns the feature on.
   * @param {string[]} [config.notes] Caveats worth knowing before you ship it.
   * @param {string}  [config.docs]   Anchor in the implementation guide.
   */
  function demoDocs(config) {
    // Most demos share the standard page chrome. The benchmark and the
    // comparison page do not — they have their own layout and no
    // `.demo-page__header` — so fall back to whatever holds the <h1>, which
    // every one of these pages does have.
    const header =
      document.querySelector('.demo-page__header') ||
      (document.querySelector('h1') || {}).parentElement;
    if (!header) return null;

    const code = dedent(config.code || '');

    const details = document.createElement('details');
    details.className = 'demo-docs';

    const notes = (config.notes || [])
      .map((n) => '<li>' + n + '</li>')
      .join('');

    details.innerHTML =
      '<summary class="demo-docs__summary">' +
        '<span class="demo-docs__chev" aria-hidden="true"></span>' +
        '<span class="demo-docs__label">How to build this</span>' +
        '<span class="demo-docs__feature"></span>' +
      '</summary>' +
      '<div class="demo-docs__body">' +
        '<div class="demo-docs__prose">' +
          '<p>' + (config.intro || '') + '</p>' +
          (notes ? '<h4>Worth knowing</h4><ul>' + notes + '</ul>' : '') +
          (config.docs
            ? '<p class="demo-docs__more"><a href="' + config.docs + '">' +
              'Full documentation &rarr;</a></p>'
            : '') +
        '</div>' +
        '<div class="demo-docs__codewrap">' +
          '<button class="demo-docs__copy" type="button">Copy</button>' +
          '<pre class="demo-docs__code"><code>' + highlight(code) + '</code></pre>' +
        '</div>' +
      '</div>';

    // As TEXT, never as markup. `feature` is a plain one-line label, and an
    // unescaped tag in it does not merely render oddly — it restructures the
    // panel. A literal <table> here once opened a real table inside the
    // <summary>, which swallowed the closing tag and the entire body with it.
    details.querySelector('.demo-docs__feature').textContent = config.feature || '';

    // Directly under the heading, so it reads as part of the page's preamble
    // rather than as a footnote under the demo.
    header.insertAdjacentElement('afterend', details);

    const copy = details.querySelector('.demo-docs__copy');
    copy.addEventListener('click', () => {
      // `writeText` rejects without a secure context or a permission, and the
      // demos are opened over plain http on a LAN often enough to hit that.
      Promise.resolve()
        .then(() => navigator.clipboard.writeText(code))
        .then(
          () => { copy.textContent = 'Copied'; },
          () => { copy.textContent = 'Press ⌘C'; }
        )
        .then(() => setTimeout(() => { copy.textContent = 'Copy'; }, 1600));
    });

    return details;
  }

  root.demoDocs = demoDocs;
})(window);
