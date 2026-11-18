// Token Radar's dashboard: one static page, no framework, no network. It reads window.RADAR (written
// beside dashboard/ by main.ts) and renders a sortable, filterable board, a detail view for every
// protocol, and the token-bearing peers the model is calibrated against.
//
// The value model, in one paragraph, as the page states it: implied = TVL x category multiple x size
// damping x growth x maturity. The category multiple is the robust median mcap/TVL of the category's
// token-bearing peers, with 3-MAD outliers removed and the remainder shrunk toward a stated prior with
// weight n/(n+4). Growth is +-22% through tanh over a clamped -60..+100% week. Maturity runs 0.82 to
// 1.18 over four years without a token. A missing listing day and a missing seven-day change are both
// neutral. No protocol name is special-cased: the model reads numbers and category strings only.
(function () {
  'use strict';

  var D = window.RADAR;
  if (!D) return;
  var app = document.getElementById('app');
  var CAL = {};
  D.calibration.forEach(function (c) { CAL[c.category] = c; });
  var MAX = D.rows.length ? D.rows[0].implied_value_usd : 1;
  var state = { q: '', category: 'all', chain: 'all', status: 'pre', scope: 'all', sort: 'implied', dir: -1, selected: null };
  var refs = { tabs: [], scopes: [], count: null, chips: null, results: null, search: null };

  var intFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    var a = Math.abs(n);
    if (a >= 1e12) return '$' + (n / 1e12).toFixed(2) + 'T';
    if (a >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (a >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return '$' + intFmt.format(n);
  }
  function fmtFull(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return '$' + intFmt.format(Math.round(n));
  }
  function fmtPct(n) {
    if (n === null || n === undefined) return '—';
    return (n > 0 ? '+' : '') + n.toFixed(1) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unrecorded';
    if (days < 45) return Math.max(0, Math.round(days)) + 'd';
    if (days < 365) return (days / 30.44).toFixed(1) + ' mo';
    return (days / 365).toFixed(1) + 'y';
  }
  function fmtMult(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '') + 'x';
  }
  function fmtMult2(n) { return isFinite(n) ? n.toFixed(2) + 'x' : 'n/a'; }
  function pctClass(n) { return n === null || n === undefined ? 'muted' : n >= 0 ? 'pos' : 'neg'; }
  function catOf(r) { return r.category || 'Other'; }

  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined) return;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined || child === false) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c !== null && c !== undefined) node.appendChild(c); });
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }

  function calFor(category) { return CAL[category || '(none)'] || null; }

  function readHash() {
    var hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    var p = new URLSearchParams(hash);
    if (p.get('q')) state.q = p.get('q');
    if (p.get('category')) state.category = p.get('category');
    if (p.get('chain')) state.chain = p.get('chain');
    if (p.get('status') === 'token') state.status = 'token';
    if (p.get('scope') === 'watch' || p.get('scope') === 'early') state.scope = p.get('scope');
    if (p.get('sort')) state.sort = p.get('sort');
    if (p.get('dir') === '1' || p.get('dir') === '-1') state.dir = Number(p.get('dir'));
    if (p.get('p') && D.rows.some(function (r) { return r.slug === p.get('p'); })) state.selected = p.get('p');
  }

  function writeHash() {
    var p = new URLSearchParams();
    if (state.q) p.set('q', state.q);
    if (state.category !== 'all') p.set('category', state.category);
    if (state.chain !== 'all') p.set('chain', state.chain);
    if (state.status !== 'pre') p.set('status', state.status);
    if (state.scope !== 'all') p.set('scope', state.scope);
    if (state.sort !== 'implied' || state.dir !== -1) { p.set('sort', state.sort); p.set('dir', String(state.dir)); }
    if (state.selected) p.set('p', state.selected);
    var next = p.toString();
    try {
      if (next) window.history.replaceState(null, '', '#' + next);
      else window.history.replaceState(null, '', window.location.pathname + window.location.search);
    } catch (e) { /* a file:// page may refuse history edits; the page still works */ }
  }

  function categories() {
    var seen = {};
    D.rows.forEach(function (r) { seen[catOf(r)] = true; });
    return Object.keys(seen).sort();
  }
  function chains() {
    var seen = {};
    D.rows.forEach(function (r) { (r.chains || []).forEach(function (c) { seen[c] = true; }); });
    return Object.keys(seen).sort();
  }

  function matches(r) {
    if (state.category !== 'all' && catOf(r) !== state.category) return false;
    if (state.chain !== 'all' && (r.chains || []).indexOf(state.chain) < 0) return false;
    if (state.scope === 'watch' && !r.is_watchlist) return false;
    if (state.scope === 'early' && r.is_watchlist) return false;
    var q = state.q.trim().toLowerCase();
    if (!q) return true;
    return [r.name, r.slug, r.category || '', (r.chains || []).join(' ')].join(' ').toLowerCase().indexOf(q) >= 0;
  }

  function sortValue(r, key) {
    if (key === 'name') return r.name.toLowerCase();
    if (key === 'tvl') return r.tvl_usd;
    if (key === 'growth') return r.change_7d === null ? -1e15 : r.change_7d;
    if (key === 'age') return r.age_days === null ? 1e15 : r.age_days;
    if (key === 'ratio') return r.implied_value_usd / r.tvl_usd;
    if (key === 'catmult') return r.category_multiple;
    if (key === 'rank') return r.rank;
    return r.implied_value_usd;
  }

  function sortRows(list) {
    var key = state.sort;
    var dir = state.dir;
    return list.slice().sort(function (a, b) {
      var av = sortValue(a, key);
      var bv = sortValue(b, key);
      if (av < bv) return -dir;
      if (av > bv) return dir;
      return a.rank - b.rank;
    });
  }

  function liveMatches(r) {
    if (state.category !== 'all' && catOf(r) !== state.category) return false;
    if (state.chain !== 'all' && (r.chains || []).indexOf(state.chain) < 0) return false;
    var q = state.q.trim().toLowerCase();
    if (!q) return true;
    return [r.name, r.slug, r.category || '', (r.chains || []).join(' ')].join(' ').toLowerCase().indexOf(q) >= 0;
  }

  function topbar() {
    return el('header', { class: 'site-head' },
      el('div', { class: 'brand' },
        el('span', { class: 'glyph', 'aria-hidden': 'true' }),
        el('div', null,
          el('div', { class: 'brand-name', text: 'TOKEN RADAR' }),
          el('div', { class: 'brand-sub', text: 'Pre-token value index' })
        )
      ),
      el('div', { class: 'head-meta' },
        el('span', { class: 'meta-item' }, el('b', { text: D.as_of }), ' snapshot'),
        el('span', { class: 'meta-item' }, el('b', { text: String(D.board_size) }), ' pre-token'),
        el('span', { class: 'meta-item' }, el('b', { text: D.watchlist_covered + '/' + D.watchlist_size }), ' watchlist'),
        el('span', { class: 'model-pill', text: 'MODEL ' + D.model_version })
      )
    );
  }

  function hero() {
    var top = D.rows[0];
    var low = D.rows[D.rows.length - 1];
    var leaders = D.rows.slice(0, 3).map(function (r) {
      return el('div', { class: 'leader' },
        el('span', { class: 'leader-rank', text: String(r.rank) }),
        el('div', { class: 'leader-id' },
          el('span', { class: 'leader-name', text: r.name }),
          el('span', { class: 'leader-cat', text: catOf(r) + ' · ' + fmtMult2(r.implied_value_usd / r.tvl_usd) + ' TVL' })
        ),
        el('b', { class: 'leader-val', text: fmtUsd(r.implied_value_usd) })
      );
    });
    return el('section', { class: 'hero' },
      el('div', { class: 'hero-copy' },
        el('div', { class: 'eyebrow', text: 'The launch radar · snapshot ' + D.as_of }),
        el('h1', null, 'What a token would be worth, priced from the protocol’s ', el('em', { text: 'own record' }), '.'),
        el('p', { class: 'hero-lede' },
          'TVL anchors the estimate. Token-bearing peers set the category multiple, and seven-day growth and time without a token adjust it. ',
          'The watchlist of ' + D.watchlist_size + ' is the floor; the radar adds ', el('b', { text: String(D.early_size) }),
          ' more candidates, and every row carries a farm plan with costs and times.'
        ),
        el('div', { class: 'hero-key' },
          el('span', null, el('b', { text: String(D.board_size) }), ' pre-token ranked'),
          el('span', null, el('b', { text: D.watchlist_covered + '/' + D.watchlist_size }), ' watchlist covered'),
          el('span', null, el('b', { text: String(D.token_count) }), ' protocols with a token'),
          el('span', null, el('b', { text: String(D.category_count) }), ' categories calibrated')
        )
      ),
      el('aside', { class: 'hero-board', 'aria-label': 'Overall leaders by implied value' },
        el('div', { class: 'hb-head' }, el('span', { text: 'Overall leaders' }), el('b', { text: 'all ' + D.board_size })),
        leaders,
        el('div', { class: 'hb-foot' }, el('span', { text: 'Implied range' }), el('b', { text: fmtUsd(top.implied_value_usd) + ' → ' + fmtUsd(low.implied_value_usd) }))
      )
    );
  }

  function controls() {
    var search = el('input', { class: 'input', type: 'search', id: 'q', value: state.q, placeholder: 'Search protocol, category or chain', 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { state.q = search.value; writeHash(); refreshResults(); });
    refs.search = search;

    var cat = el('select', { class: 'select', id: 'category', 'aria-label': 'Filter by category' },
      el('option', { value: 'all', text: 'All categories (' + categories().length + ')' }),
      categories().map(function (c) {
        return el('option', { value: c, text: c + ' (' + D.rows.filter(function (r) { return catOf(r) === c; }).length + ')', selected: c === state.category ? 'selected' : null });
      })
    );
    cat.addEventListener('change', function () { state.category = cat.value; writeHash(); refreshResults(); });

    var chain = el('select', { class: 'select', id: 'chain', 'aria-label': 'Filter by chain' },
      el('option', { value: 'all', text: 'All chains (' + chains().length + ')' }),
      chains().map(function (c) {
        return el('option', { value: c, text: c + ' (' + D.rows.filter(function (r) { return (r.chains || []).indexOf(c) >= 0; }).length + ')', selected: c === state.chain ? 'selected' : null });
      })
    );
    chain.addEventListener('change', function () { state.chain = chain.value; writeHash(); refreshResults(); });

    var pre = el('button', { type: 'button', 'aria-pressed': state.status === 'pre' ? 'true' : 'false' }, 'Pre-token ', el('b', { text: String(D.board_size) }));
    var tok = el('button', { type: 'button', 'aria-pressed': state.status === 'token' ? 'true' : 'false' }, 'Has token ', el('b', { text: String(D.live_size) }));
    pre.addEventListener('click', function () { state.status = 'pre'; state.selected = null; writeHash(); render(); });
    tok.addEventListener('click', function () { state.status = 'token'; state.selected = null; writeHash(); render(); });
    refs.tabs = [pre, tok];

    var scopes = [['all', 'All', D.board_size], ['watch', 'Watchlist', D.watchlist_size], ['early', 'Early finds', D.early_size]].map(function (s) {
      var b = el('button', { type: 'button', 'data-scope': s[0], 'aria-pressed': state.scope === s[0] ? 'true' : 'false' }, s[1] + ' ', el('b', { text: String(s[2]) }));
      b.addEventListener('click', function () { state.scope = s[0]; writeHash(); refreshResults(); });
      return b;
    });
    refs.scopes = scopes;

    return el('section', { class: 'controls', 'aria-label': 'Board filters' },
      el('div', { class: 'control-row' },
        el('label', { class: 'field field-search' }, el('span', { class: 'field-label', text: 'Search' }), search),
        el('label', { class: 'field' }, el('span', { class: 'field-label', text: 'Category' }), cat),
        el('label', { class: 'field' }, el('span', { class: 'field-label', text: 'Chain' }), chain),
        el('div', { class: 'field field-status' }, el('span', { class: 'field-label', text: 'Token record' }), el('div', { class: 'seg' }, pre, tok))
      ),
      el('div', { class: 'control-row sub' },
        el('div', { class: 'seg seg-scope', 'aria-label': 'Scope' }, scopes),
        el('span', { class: 'count' }, el('b', { id: 'count-n', text: '—' }), el('span', { id: 'count-rest', text: ' rows shown' })),
        el('span', { class: 'hint', text: 'Click a column to sort · click a row for its breakdown and farm plan' })
      )
    );
  }

  function sortHeader(key, label, cls) {
    var active = state.sort === key;
    var b = el('button', { type: 'button', 'aria-label': 'Sort by ' + label },
      label, el('span', { class: 'arrow', text: active ? (state.dir < 0 ? '↓' : '↑') : '↕' })
    );
    b.addEventListener('click', function () {
      if (state.sort === key) state.dir = -state.dir;
      else { state.sort = key; state.dir = key === 'name' || key === 'age' ? 1 : -1; }
      writeHash();
      refreshResults();
    });
    return el('th', { scope: 'col', class: cls || null, 'aria-sort': active ? (state.dir < 0 ? 'descending' : 'ascending') : 'none' }, b);
  }

  function rankClass(rank) { return rank === 1 ? 'rank-no r1' : rank <= 3 ? 'rank-no r3' : 'rank-no'; }

  function boardTable() {
    var list = sortRows(D.rows.filter(matches));
    if (list.length === 0) return emptyState();
    var tbody = el('tbody');
    list.forEach(function (r) {
      var tr = el('tr', { tabindex: '0', 'data-slug': r.slug },
        el('td', { class: 'cell-rank' }, el('span', { class: rankClass(r.rank), text: String(r.rank) })),
        el('td', { class: 'cell-proto' },
          el('div', { class: 'p-name', text: r.name }),
          el('div', { class: 'p-meta' },
            el('span', { class: 'cat-tag', text: catOf(r) }),
            el('span', { class: 'chain-tag', text: (r.chains || []).length ? r.chains.slice(0, 2).join(' · ') : 'chain unlisted' }),
            el('span', { class: r.is_watchlist ? 'src src-watch' : 'src src-early', text: r.is_watchlist ? 'watchlist' : 'early find' })
          )
        ),
        el('td', { class: 'num tvl', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + pctClass(r.change_7d), text: fmtPct(r.change_7d) }),
        el('td', { class: 'num age', text: fmtAge(r.age_days) }),
        el('td', { class: 'cell-implied' },
          el('div', { class: 'imp' },
            el('span', { class: 'imp-bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(2, Math.round((r.implied_value_usd / MAX) * 100)) + '%' })),
            el('b', { class: 'imp-val', text: fmtUsd(r.implied_value_usd) })
          )
        ),
        el('td', { class: 'num ratio', text: fmtMult2(r.implied_value_usd / r.tvl_usd) }),
        el('td', { class: 'num catmult' }, el('b', { text: fmtMult2(r.category_multiple) }), el('small', { text: r.category_observed === null || r.category_kept < D.model.calibration_min_comps ? 'prior' : r.category_kept + 'p' }))
      );
      tr.addEventListener('click', function () { openDetail(r.slug); });
      tr.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } });
      tbody.appendChild(tr);
    });
    return el('div', { class: 'panel board-panel' },
      el('div', { class: 'table-scroll' },
        el('table', { class: 'board' },
          el('caption', { class: 'sr-only', text: 'Pre-token protocols ranked by implied value' }),
          el('thead', null, el('tr', null,
            sortHeader('rank', 'Rank', 'cell-rank'),
            sortHeader('name', 'Protocol', 'cell-proto'),
            sortHeader('tvl', 'TVL'),
            sortHeader('growth', '7d'),
            sortHeader('age', 'Age, no token'),
            sortHeader('implied', 'Implied value'),
            sortHeader('ratio', 'Value / TVL'),
            sortHeader('catmult', 'Category mult.')
          )),
          tbody
        )
      )
    );
  }

  function tokenTable() {
    var list = D.live.filter(liveMatches).slice().sort(function (a, b) { return (b.mcap_usd || 0) - (a.mcap_usd || 0) || b.tvl_usd - a.tvl_usd; });
    if (list.length === 0) return emptyState();
    var tbody = el('tbody');
    list.forEach(function (r) {
      tbody.appendChild(el('tr', { class: 'token-row' },
        el('td', { class: 'cell-status' }, el('span', { class: 'live-dot', text: 'token live' })),
        el('td', { class: 'cell-proto' },
          el('div', { class: 'p-name', text: r.name }),
          el('div', { class: 'p-meta' }, el('span', { class: 'cat-tag', text: catOf(r) }), el('span', { class: 'chain-tag', text: (r.chains || []).slice(0, 2).join(' · ') || 'chain unlisted' }))
        ),
        el('td', { class: 'num tvl', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + pctClass(r.change_7d), text: fmtPct(r.change_7d) }),
        el('td', { class: 'num mcap', text: fmtUsd(r.mcap_usd) }),
        el('td', { class: 'num ratio2', text: fmtMult2(r.mcap_tvl) })
      ));
    });
    return el('div', { class: 'panel board-panel' },
      el('div', { class: 'panel-head' },
        el('h2', { text: 'Protocols whose token already trades' }),
        el('p', { text: 'Recorded market caps, not the model’s estimate. Their ratios are the calibration sample; they are never ranked on the pre-token board.' })
      ),
      el('div', { class: 'table-scroll' },
        el('table', { class: 'board token-board' },
          el('thead', null, el('tr', null,
            el('th', { scope: 'col', text: 'Record' }),
            el('th', { scope: 'col', text: 'Protocol' }),
            el('th', { scope: 'col', text: 'TVL' }),
            el('th', { scope: 'col', text: '7d' }),
            el('th', { scope: 'col', text: 'Market cap' }),
            el('th', { scope: 'col', text: 'MCap / TVL' })
          )),
          tbody
        )
      )
    );
  }

  function emptyState() {
    var b = el('button', { class: 'button primary', type: 'button', text: 'Reset filters' });
    b.addEventListener('click', function () { state.q = ''; state.category = 'all'; state.chain = 'all'; state.scope = 'all'; writeHash(); render(); });
    return el('div', { class: 'panel empty' },
      el('h2', { text: 'No protocol matches those filters' }),
      el('p', { text: 'Clear the search or choose another category, chain or scope to see the radar again.' }),
      b
    );
  }

  function chipsHtml() {
    var out = [];
    function chip(label, value, clear) {
      var b = el('button', { type: 'button', 'aria-label': 'Remove ' + label + ' filter', text: '×' });
      b.addEventListener('click', function () { clear(); writeHash(); render(); });
      out.push(el('span', { class: 'chip' }, label + ': ', el('b', { text: value }), b));
    }
    if (state.q) chip('Search', state.q, function () { state.q = ''; });
    if (state.category !== 'all') chip('Category', state.category, function () { state.category = 'all'; });
    if (state.chain !== 'all') chip('Chain', state.chain, function () { state.chain = 'all'; });
    if (state.scope !== 'all') chip('Scope', state.scope === 'watch' ? 'Watchlist' : 'Early finds', function () { state.scope = 'all'; });
    if (out.length) {
      out.push(el('span', { class: 'chip-note', text: 'Filters apply to the table and to the row count; ranks stay global.' }));
      return out;
    }
    return [el('span', { class: 'chip-note', text: 'Every row is a protocol whose DefiLlama record carries no token. Click a row to see its arithmetic and its farm plan.' })];
  }

  function refreshResults() {
    if (!refs.results) return;
    refs.results.textContent = '';
    refs.results.appendChild(state.status === 'pre' ? boardTable() : tokenTable());
    var shown = state.status === 'pre' ? D.rows.filter(matches).length : D.live.filter(liveMatches).length;
    refs.count.textContent = String(shown);
    refs.countRest.textContent = state.status === 'pre' ? ' rows shown of ' + D.board_size : ' live peers shown of ' + D.live_size;
    refs.chips.textContent = '';
    chipsHtml().forEach(function (n) { refs.chips.appendChild(n); });
    refs.tabs.forEach(function (b, i) { b.setAttribute('aria-pressed', String((i === 0) === (state.status === 'pre'))); });
    refs.scopes.forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-scope') === state.scope)); });
  }

  function methodology() {
    var m = D.model;
    var calibrated = D.calibration.filter(function (c) { return c.comps >= m.calibration_min_comps; })
      .sort(function (a, b) { return b.kept - a.kept || b.comps - a.comps; }).slice(0, 10);
    return el('section', { class: 'panel method' },
      el('div', { class: 'method-copy' },
        el('div', { class: 'eyebrow', text: 'Methodology' }),
        el('h2', { text: 'How a row becomes an implied value' }),
        el('p', null,
          'Every number on the board comes from the snapshot’s ten fields and from one statistic the snapshot teaches: the FDV/TVL multiple that token-bearing protocols in the same category actually trade at. ',
          'TVL is the anchor, the category multiple converts it to fully diluted value, size damping trims the multiple as TVL grows, and seven-day growth and time without a token adjust the result. ',
          'For each category the model takes the median market-cap-to-TVL ratio of its token-bearing peers, drops peers more than ', el('b', { text: m.calibration_outlier_mad + ' scaled MADs' }),
          ' from that median, and shrinks what remains toward a stated prior with weight n/(n+', el('b', { text: String(m.calibration_shrink_k) }), '). ',
          'Growth is bounded to ±', el('b', { text: Math.round(m.growth_weight * 100) + '%' }), ' through tanh so a one-off inflow cannot dominate, and maturity runs ', el('b', { text: m.maturity_floor.toFixed(2) }), ' to ', el('b', { text: m.maturity_ceiling.toFixed(2) }), ' over ', el('b', { text: String(m.maturity_days / 365) }), ' years without a token. ',
          'A missing listing day and a missing seven-day change are both neutral, and the detail view says which is which. ',
          'No protocol name is special-cased: the model reads numbers and category strings only, and every row’s factors are printed on its detail view.'
        ),
        el('div', { class: 'formula', text: 'implied = round( tvl_usd × cat_mult × clamp((tvl_usd / $100M) ^ ' + m.size_elasticity + ', ' + m.size_damping_min + ', ' + m.size_damping_max + ') × (1 + ' + m.growth_weight + ' × tanh(clamp(change_7d, ' + m.growth_floor + ', ' + m.growth_cap + ') / ' + m.growth_scale + ')) × (maturity(age_days)) )' }),
        el('div', { class: 'method-foot' },
          el('span', null, el('b', { text: 'cal_mult ' }), '= prior × (1 − n/(n+' + m.calibration_shrink_k + ')) + clamp(robust median, ' + m.calibration_min_multiple + ', ' + m.calibration_max_multiple + ') × n/(n+' + m.calibration_shrink_k + '), n = peers kept'),
          el('span', null, el('b', { text: 'maturity ' }), '= ' + m.maturity_floor + ' + ' + (m.maturity_ceiling - m.maturity_floor).toFixed(2) + ' × min(age_days, ' + m.maturity_days + ') / ' + m.maturity_days + '; unknown age = 1.00')
        )
      ),
      el('div', { class: 'method-side' },
        el('div', { class: 'method-side-head' }, el('span', { text: 'Calibration sample' }), el('b', { text: calibrated.length + ' shown' })),
        el('div', { class: 'cal-table' },
          el('div', { class: 'cal-row cal-head' }, el('span', { text: 'Category' }), el('span', { text: 'Peers' }), el('span', { text: 'Median' }), el('span', { text: 'Applied' })),
          calibrated.map(function (c) {
            return el('div', { class: 'cal-row' },
              el('span', { class: 'cal-cat', text: c.category }),
              el('span', { class: 'num', text: c.kept + '/' + c.comps }),
              el('span', { class: 'num', text: c.observed_median === null ? '—' : fmtMult2(c.observed_median) }),
              el('span', { class: 'num cal-applied', text: fmtMult2(c.multiple) })
            );
          })
        ),
        el('p', { class: 'method-note', text: 'Peers are token-bearing protocols in the snapshot with a recorded market cap and at least $1M TVL; impossible ratios below 0.01 or above 8 are dropped before the median.' })
      )
    );
  }

  function eqRow(mark, label, value, note, total) {
    return el('div', { class: total ? 'eq-row eq-total' : 'eq-row' },
      el('span', { class: 'eq-mark', text: mark }),
      el('div', { class: 'eq-main' }, el('span', { class: 'eq-label', text: label }), el('small', { class: 'eq-note', text: note })),
      el('b', { class: 'eq-value', text: value })
    );
  }

  function metric(label, value, note) {
    return el('div', { class: 'metric' }, el('span', { class: 'metric-label', text: label }), el('b', { text: value }), note ? el('small', { text: note }) : null);
  }

  function parseStep(text) {
    var m = /^(.*?) Cost: (.*?)\. Time: (.*?)\.$/.exec(text);
    if (!m) return { text: text, cost: '', time: '' };
    return { text: m[1], cost: m[2], time: m[3] };
  }

  function detailView(row) {
    var m = D.model;
    var cal = calFor(row.category);
    var ratio = row.implied_value_usd / row.tvl_usd;
    var age = row.age_days;
    var growth = Math.min(m.growth_cap, Math.max(m.growth_floor, row.change_7d === null ? 0 : row.change_7d));
    var growthX = 1 + m.growth_weight * Math.tanh(growth / m.growth_scale);
    var maturityX = age === null ? 1 : m.maturity_floor + ((m.maturity_ceiling - m.maturity_floor) * Math.min(age, m.maturity_days)) / m.maturity_days;
    var rec = Math.max(1, Math.round(row.base_value_usd * growthX * maturityX));

    var peerNote;
    if (cal && cal.source === 'shrunk' && cal.observed_median !== null) {
      peerNote = cal.comps + ' token-bearing ' + catOf(row) + ' protocols are in the snapshot; ' + cal.kept + ' survive the ' + m.calibration_outlier_mad + '-MAD trim. Their median is ' + fmtMult(cal.observed_median) + ', and the model shrinks it ' + Math.round(cal.weight * 100) + '% toward a ' + fmtMult(cal.prior) + ' prior, giving ' + fmtMult(cal.multiple) + '.';
    } else {
      peerNote = 'Only ' + (cal ? cal.comps : 0) + ' token-bearing peer' + (cal && cal.comps === 1 ? '' : 's') + ' in this category, below the ' + m.calibration_min_comps + '-peer minimum, so the stated ' + fmtMult(row.category_prior) + ' prior stands and no peer fit is claimed.';
    }

    var eq = el('div', { class: 'eq' },
      eqRow('', 'TVL, from the snapshot', fmtFull(row.tvl_usd), 'the protocol’s own measure of value secured'),
      eqRow('×', 'Category multiple', fmtMult(row.category_multiple), (cal ? cal.kept + ' of ' + cal.comps + ' peers used; prior ' + fmtMult(row.category_prior) : 'stated prior'), false),
      eqRow('×', 'Size damping', row.size_damping.toFixed(3) + 'x', 'reference $100M TVL, elasticity ' + m.size_elasticity),
      eqRow('=', 'Base value', fmtFull(row.base_value_usd), 'TVL × multiple × damping'),
      eqRow('×', 'Seven-day growth', row.growth_multiplier.toFixed(3) + 'x', (row.growth_recorded ? fmtPct(row.change_7d) : 'not reported') + ', clamped to ' + m.growth_floor + '..' + m.growth_cap + '% and compressed by tanh'),
      eqRow('×', 'Time without a token', row.maturity_multiplier.toFixed(3) + 'x', age === null ? 'listing day unrecorded, so neutral' : fmtAge(age) + ' since DefiLlama began tracking it'),
      eqRow('=', 'Implied value', fmtFull(row.implied_value_usd), 'rounded and clamped to the gate’s positive-integer range', true)
    );

    var peerTable = null;
    if (cal && cal.peers.length > 0) {
      peerTable = el('div', { class: 'peer-table' },
        el('div', { class: 'peer-row peer-head' }, el('span', { text: 'Token-bearing peer' }), el('span', { text: 'TVL' }), el('span', { text: 'Market cap' }), el('span', { text: 'MCap / TVL' })),
        cal.peers.slice(0, 5).map(function (p) {
          return el('div', { class: 'peer-row' },
            el('span', { class: 'peer-name', text: p.name }),
            el('span', { class: 'num', text: fmtUsd(p.tvl_usd) }),
            el('span', { class: 'num', text: fmtUsd(p.mcap_usd) }),
            el('span', { class: 'num peer-ratio', text: fmtMult2(p.mcap_tvl) })
          );
        }),
        el('div', { class: 'peer-compare' },
          'This row implies ', el('b', { text: fmtMult2(ratio) }), ' of TVL — ',
          ratio >= (cal.observed_median || 0) ? 'above' : 'below', ' the ' + fmtMult2(cal.observed_median) + ' peer median.'
        )
      );
    }

    var steps = el('ol', { class: 'steps' }, row.farm_steps.map(function (text, i) {
      var s = parseStep(text);
      return el('li', { class: 'step' },
        el('span', { class: 'step-no', text: String(i + 1) }),
        el('div', { class: 'step-body' },
          el('p', { text: s.text }),
          el('div', { class: 'step-tags' },
            s.cost ? el('span', { class: 'tag-cost', text: 'Cost · ' + s.cost }) : null,
            s.time ? el('span', { class: 'tag-time', text: 'Time · ' + s.time }) : null
          )
        )
      );
    }));

    return el('div', { class: 'detail' },
      el('div', { class: 'detail-back' },
        el('button', { class: 'back', type: 'button', onclick: function () { state.selected = null; writeHash(); render(); } }, '← Back to the board')
      ),
      el('section', { class: 'detail-hero' },
        el('div', { class: 'detail-id' },
          el('div', { class: 'kicker' },
            el('span', { class: 'rank-pill', text: 'RANK ' + row.rank + ' OF ' + D.board_size }),
            el('span', { class: 'cat-tag', text: catOf(row) }),
            el('span', { class: row.is_watchlist ? 'src src-watch' : 'src src-early', text: row.is_watchlist ? 'watchlist' : 'early find' })
          ),
          el('h1', { text: row.name }),
          el('p', { class: 'detail-sub', text: ((row.chains || []).length ? row.chains.slice(0, 4).join(' · ') : 'chain unlisted') + ' · ' + (age === null ? 'listing day unrecorded' : fmtAge(age) + ' without a token') + ' · ' + fmtFull(row.tvl_usd) + ' TVL' })
        ),
        el('div', { class: 'detail-value' },
          el('span', { class: 'stat-label', text: 'Implied value if the record held' }),
          el('b', { text: fmtUsd(row.implied_value_usd) }),
          el('small', { text: fmtMult2(ratio) + ' of TVL · category ' + fmtMult2(row.category_multiple) })
        )
      ),
      el('div', { class: 'metric-grid' },
        metric('TVL', fmtUsd(row.tvl_usd), 'snapshot figure'),
        metric('7d change', fmtPct(row.change_7d), row.growth_recorded ? 'growth term' : 'neutral, unreported'),
        metric('Age, no token', fmtAge(age), 'maturity term'),
        metric('Category multiple', fmtMult2(row.category_multiple), cal ? cal.kept + '/' + cal.comps + ' peers' : 'prior'),
        metric('Growth multiplier', row.growth_multiplier.toFixed(2) + 'x', 'bounded ±' + Math.round(m.growth_weight * 100) + '%'),
        metric('Maturity multiplier', row.maturity_multiplier.toFixed(2) + 'x', m.maturity_floor.toFixed(2) + ' to ' + m.maturity_ceiling.toFixed(2))
      ),
      el('div', { class: 'detail-grid' },
        el('div', { class: 'detail-col' },
          el('section', { class: 'card breakdown' },
            el('div', { class: 'card-head' }, el('h2', { text: 'Score breakdown' }), el('span', { class: 'card-tag', text: 'every factor' })),
            el('p', { class: 'lede', text: 'The page recomputes this row from the snapshot fields and gets ' + fmtFull(rec) + (rec === row.implied_value_usd ? ', the same number board.json carries.' : ', which differs: the data would be stale.') }),
            eq
          ),
          el('section', { class: 'card peers' },
            el('div', { class: 'card-head' }, el('h2', { text: 'Peer calibration' }), el('span', { class: 'card-tag', text: catOf(row) })),
            el('p', { class: 'lede', text: peerNote }),
            peerTable,
            el('p', { class: 'fine', text: 'A peer is a protocol whose snapshot record carries a market cap; the model never treats a pre-token protocol as a peer.' })
          )
        ),
        el('section', { class: 'card plan' },
          el('div', { class: 'card-head' }, el('h2', { text: 'Farm plan' }), el('span', { class: 'card-tag', text: row.farm_steps.length + ' steps · cost and time on each' })),
          el('p', { class: 'lede', text: 'Concrete actions for ' + catOf(row) + ' on ' + ((row.chains || [])[0] || 'its main chain') + ', sized to its ' + fmtUsd(row.tvl_usd) + ' TVL. Costs are estimates; check the protocol’s own documentation before moving funds.' }),
          steps
        )
      ),
      el('p', { class: 'detail-note' },
        el('b', { text: 'Record, not proof. ' }),
        'DefiLlama records no token for this protocol: no ticker, no CoinGecko id, no market cap. That is the record the model reads, not a claim that no token exists or will launch. An implied value is this entry’s estimate, not a price and not a forecast.'
      )
    );
  }

  function openDetail(slug) {
    state.selected = slug;
    writeHash();
    render();
    window.scrollTo(0, 0);
  }

  function footer() {
    return el('footer', { class: 'foot' },
      el('span', null, el('b', { text: 'Token Radar ' }), D.model_version + ' · ' + D.board_size + ' pre-token protocols · ' + D.watchlist_covered + '/' + D.watchlist_size + ' watchlist covered'),
      el('span', { text: 'Snapshot ' + D.as_of + ' · DefiLlama protocol index · no network at render time' }),
      el('span', { text: 'Implied values are the entry’s estimates, not make.fun’s.' })
    );
  }

  function render() {
    app.textContent = '';
    var shell = el('div', { class: 'shell' });
    shell.appendChild(topbar());
    var row = state.selected ? D.rows.filter(function (r) { return r.slug === state.selected; })[0] : null;
    if (row) {
      shell.appendChild(detailView(row));
    } else {
      shell.appendChild(hero());
      shell.appendChild(controls());
      var chips = el('div', { class: 'chips', id: 'chips', 'aria-live': 'polite' });
      var results = el('div', { id: 'results' });
      shell.appendChild(chips);
      shell.appendChild(results);
      shell.appendChild(methodology());
      refs.chips = chips;
      refs.results = results;
      refs.count = null;
      refs.countRest = null;
    }
    shell.appendChild(footer());
    app.appendChild(shell);
    if (!row) {
      // count elements live in the controls just built; resolve them once and refresh the table.
      refs.count = document.getElementById('count-n');
      refs.countRest = document.getElementById('count-rest');
      refreshResults();
    }
    app.setAttribute('aria-busy', 'false');
  }

  readHash();
  render();
  window.addEventListener('hashchange', function () { state.selected = null; readHash(); render(); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && state.selected) { state.selected = null; writeHash(); render(); }
  });
})();
