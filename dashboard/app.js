// Token Radar's dashboard: one static page, no framework and no network. It reads window.RADAR
// (written beside dashboard/ by main.ts) and renders a sortable, filterable board, a detail view for
// every protocol, and the live-token set the model is calibrated against. Every number on screen comes
// from data.js; the page recomputes each implied value from the same formula to show the arithmetic.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var app = document.getElementById('app');
  var state = { q: '', category: 'all', chain: 'all', tab: 'pre', sort: 'implied', dir: -1, selected: null };

  var fmtInt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    var a = Math.abs(n);
    if (a >= 1e12) return '$' + (n / 1e12).toFixed(2) + 'T';
    if (a >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (a >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return '$' + fmtInt.format(n);
  }
  function fmtFull(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return '$' + fmtInt.format(Math.round(n));
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(1) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days < 45) return Math.max(0, Math.round(days)) + 'd';
    if (days < 365) return (days / 30.44).toFixed(1) + ' mo';
    return (days / 365).toFixed(1) + 'y';
  }
  function fmtMultiple(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return n.toFixed(2) + 'x';
  }
  function pctClass(n) { return n === null || n === undefined ? 'muted' : n >= 0 ? 'pos' : 'neg'; }

  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
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

  function calFor(category) {
    var key = category || '(none)';
    for (var i = 0; i < DATA.calibration.length; i++) if (DATA.calibration[i].category === key) return DATA.calibration[i];
    return null;
  }

  // The same arithmetic as lib/model.ts, shown on the detail view so the page and board.json agree.
  function recompute(row) {
    var m = DATA.model;
    var growth = Math.min(m.growth_cap, Math.max(m.growth_floor, row.change_7d === null ? 0 : row.change_7d));
    var growthX = 1 + m.growth_weight * Math.tanh(growth / m.growth_scale);
    var age = row.age_days;
    var maturityX = age === null ? 1 : m.maturity_floor + ((m.maturity_ceiling - m.maturity_floor) * Math.min(age, m.maturity_days)) / m.maturity_days;
    return Math.max(1, Math.round(row.base_value_usd * growthX * maturityX));
  }

  function parseStep(text) {
    var m = /^(.*?) Cost: (.*?)\. Time: (.*?)\.$/.exec(text);
    if (!m) return { text: text, cost: '', time: '' };
    return { text: m[1], cost: m[2], time: m[3] };
  }

  function categories() {
    var seen = {};
    DATA.rows.forEach(function (r) { seen[r.category || 'Other'] = true; });
    return Object.keys(seen).sort();
  }
  function chains() {
    var seen = {};
    DATA.rows.forEach(function (r) { (r.chains || []).forEach(function (c) { seen[c] = true; }); });
    return Object.keys(seen).sort();
  }

  function matches(r) {
    if (state.category !== 'all' && (r.category || 'Other') !== state.category) return false;
    if (state.chain !== 'all' && (r.chains || []).indexOf(state.chain) < 0) return false;
    var q = state.q.trim().toLowerCase();
    if (!q) return true;
    var hay = [r.name, r.slug, r.category || '', (r.chains || []).join(' ')].join(' ').toLowerCase();
    return hay.indexOf(q) >= 0;
  }

  function sortRows(list) {
    var key = state.sort;
    var dir = state.dir;
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (key === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (key === 'growth') { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (key === 'age') { av = a.age_days === null ? Infinity : a.age_days; bv = b.age_days === null ? Infinity : b.age_days; }
      else if (key === 'multiple') { av = a.implied_value_usd / a.tvl_usd; bv = b.implied_value_usd / b.tvl_usd; }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      if (av < bv) return -dir;
      if (av > bv) return dir;
      return a.rank - b.rank;
    });
  }

  function readHash() {
    var hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    var p = new URLSearchParams(hash);
    if (p.get('q')) state.q = p.get('q');
    if (p.get('category')) state.category = p.get('category');
    if (p.get('chain')) state.chain = p.get('chain');
    if (p.get('tab') === 'live') state.tab = 'live';
    if (p.get('sort')) state.sort = p.get('sort');
    if (p.get('dir') === '1' || p.get('dir') === '-1') state.dir = Number(p.get('dir'));
    if (p.get('p')) state.selected = p.get('p');
  }
  function writeHash() {
    var p = new URLSearchParams();
    if (state.q) p.set('q', state.q);
    if (state.category !== 'all') p.set('category', state.category);
    if (state.chain !== 'all') p.set('chain', state.chain);
    if (state.tab !== 'pre') p.set('tab', state.tab);
    if (state.sort !== 'implied' || state.dir !== -1) { p.set('sort', state.sort); p.set('dir', String(state.dir)); }
    if (state.selected) p.set('p', state.selected);
    var next = p.toString();
    if (next) window.history.replaceState(null, '', '#' + next);
    else window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  function topbar() {
    return el('header', { class: 'topbar' },
      el('div', { class: 'brand' },
        el('span', { class: 'brand-mark' }),
        el('div', null,
          el('div', { class: 'brand-name', text: 'TOKEN RADAR' }),
          el('div', { class: 'brand-tag', text: 'Pre-token value index' })
        )
      ),
      el('div', { class: 'top-meta' },
        el('span', null, el('span', { class: 'dot' }), 'Snapshot ', el('b', { text: DATA.as_of })),
        el('span', null, el('b', { text: String(DATA.board_size) }), ' protocols scored'),
        el('span', null, el('b', { text: DATA.watchlist_size + '/' + DATA.watchlist_size }), ' watchlist covered'),
        el('span', null, el('b', { text: DATA.model_version }), ' model')
      )
    );
  }

  function hero() {
    var top = DATA.rows[0];
    var low = DATA.rows[DATA.rows.length - 1];
    return el('section', { class: 'hero' },
      el('div', null,
        el('div', { class: 'eyebrow', text: 'The launch radar · ' + DATA.board_size + ' launch candidates with no token on record' }),
        el('h1', null, 'The protocols that have not launched yet, ranked by ', el('em', { text: 'what their token could be worth' }), '.'),
        el('p', { class: 'hero-copy' },
          'Every row is a protocol whose DefiLlama record carries no token. The model prices it from the protocol’s own figures: ',
          el('b', { text: 'TVL' }), ', ', el('b', { text: '7-day growth' }), ', ', el('b', { text: 'age with no token' }),
          ', and the ', el('b', { text: 'FDV/TVL multiple its token-bearing peers actually trade at' }),
          '. The watchlist of ' + DATA.watchlist_size + ' is the floor; the radar carries ' + DATA.early_size + ' more it found. Every row has a farm plan.'
        )
      ),
      el('div', { class: 'hero-stats' },
        el('div', { class: 'stat' }, el('b', { text: String(DATA.board_size) }), el('span', { text: 'pre-token protocols ranked' })),
        el('div', { class: 'stat' }, el('b', { text: String(DATA.early_size) }), el('span', { text: 'outside the watchlist' })),
        el('div', { class: 'stat' }, el('b', { text: String(DATA.live_size) }), el('span', { text: 'live-token peers shown' })),
        el('div', { class: 'stat' }, el('b', { text: String(DATA.token_count) }), el('span', { text: 'protocols in the snapshot with a token' })),
        el('div', { class: 'stat wide' },
          el('span', { text: 'Implied value range, rank 1 to ' + DATA.board_size }),
          el('b', { text: fmtUsd(top.implied_value_usd) + ' → ' + fmtUsd(low.implied_value_usd) })
        )
      )
    );
  }

  function toolbar() {
    var search = el('input', { class: 'input', type: 'search', id: 'q', placeholder: 'Search protocol, category or chain', value: state.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { state.q = search.value; writeHash(); render(); });

    var cat = el('select', { class: 'select', id: 'category', 'aria-label': 'Filter by category' },
      el('option', { value: 'all', text: 'All categories' }),
      categories().map(function (c) { return el('option', { value: c, text: c, selected: c === state.category ? 'selected' : null }); })
    );
    cat.addEventListener('change', function () { state.category = cat.value; writeHash(); render(); });

    var chain = el('select', { class: 'select', id: 'chain', 'aria-label': 'Filter by chain' },
      el('option', { value: 'all', text: 'All chains' }),
      chains().map(function (c) { return el('option', { value: c, text: c, selected: c === state.chain ? 'selected' : null }); })
    );
    chain.addEventListener('change', function () { state.chain = chain.value; writeHash(); render(); });

    var pre = el('button', { type: 'button', 'aria-pressed': state.tab === 'pre' ? 'true' : 'false', text: 'Pre-token board' });
    var live = el('button', { type: 'button', 'aria-pressed': state.tab === 'live' ? 'true' : 'false', text: 'Live token peers' });
    pre.addEventListener('click', function () { state.tab = 'pre'; state.selected = null; writeHash(); render(); });
    live.addEventListener('click', function () { state.tab = 'live'; state.selected = null; writeHash(); render(); });

    var shown = state.tab === 'pre' ? DATA.rows.filter(matches).length : DATA.live.filter(liveMatches).length;
    return el('div', { class: 'toolbar' },
      el('div', { class: 'field' }, el('label', { for: 'q', text: 'Search' }), search),
      el('div', { class: 'field' }, el('label', { for: 'category', text: 'Category' }), cat),
      el('div', { class: 'field' }, el('label', { for: 'chain', text: 'Chain' }), chain),
      el('div', { class: 'field' }, el('span', { class: 'label', text: 'Token status' }), el('div', { class: 'tabs' }, pre, live)),
      el('span', { class: 'count' }, el('b', { text: String(shown) }), state.tab === 'pre' ? ' rows shown of ' + DATA.board_size : ' live peers shown of ' + DATA.live_size)
    );
  }

  function chips() {
    var out = [];
    if (state.q) out.push(el('span', { class: 'chip' }, 'Search: ', el('b', { text: state.q }), removeBtn(function () { state.q = ''; })));
    if (state.category !== 'all') out.push(el('span', { class: 'chip' }, 'Category: ', el('b', { text: state.category }), removeBtn(function () { state.category = 'all'; })));
    if (state.chain !== 'all') out.push(el('span', { class: 'chip' }, 'Chain: ', el('b', { text: state.chain }), removeBtn(function () { state.chain = 'all'; })));
    var active = state.q || state.category !== 'all' || state.chain !== 'all';
    if (active) {
      out.push(el('button', { class: 'button', type: 'button', text: 'Reset filters', onclick: function () { state.q = ''; state.category = 'all'; state.chain = 'all'; writeHash(); render(); } }));
      out.push(el('span', { class: 'note', text: 'Filters apply to the table below and to the row count in the toolbar.' }));
    } else {
      out.push(el('span', { class: 'note', text: 'Tip: click any column heading to sort, or any row for its model, its live peers and its farm plan.' }));
    }
    return el('div', { class: 'chips' }, out);
  }
  function removeBtn(fn) {
    var b = el('button', { type: 'button', 'aria-label': 'Remove filter', text: '×' });
    b.addEventListener('click', function () { fn(); writeHash(); render(); });
    return b;
  }

  function sortHeader(key, label, className) {
    var b = el('button', { type: 'button' }, label);
    if (state.sort === key) b.appendChild(el('span', { class: 'arrow', text: state.dir < 0 ? '↓' : '↑' }));
    b.addEventListener('click', function () {
      if (state.sort === key) state.dir = -state.dir;
      else { state.sort = key; state.dir = key === 'name' || key === 'age' ? 1 : -1; }
      writeHash();
      render();
    });
    return el('th', { scope: 'col', class: className || null }, b);
  }

  function rowClass(rank) { return rank === 1 ? 'rank-no top' : rank <= 3 ? 'rank-no podium' : 'rank-no'; }

  function boardTable() {
    var list = sortRows(DATA.rows.filter(matches));
    if (list.length === 0) return emptyState();
    var max = DATA.rows[0].implied_value_usd || 1;
    var tbody = el('tbody');
    list.forEach(function (r) {
      var tr = el('tr', { tabindex: '0', 'data-selected': state.selected === r.slug ? 'true' : 'false' },
        el('td', { class: 'rank' }, el('span', { class: rowClass(r.rank), text: String(r.rank) })),
        el('td', null,
          el('div', { class: 'protocol' },
            el('b', { text: r.name }),
            el('div', { class: 'meta-line' },
              el('span', { class: 'cat', text: r.category || 'Other' }),
              el('span', { text: (r.chains && r.chains.length ? r.chains.slice(0, 2).join(' · ') : 'chain unlisted') }),
              el('span', { class: r.is_watchlist ? 'watch' : 'early', text: r.is_watchlist ? 'watchlist' : 'early find' })
            )
          )
        ),
        el('td', { class: 'num tvl', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + pctClass(r.change_7d), text: fmtPct(r.change_7d) }),
        el('td', { class: 'num muted', text: fmtAge(r.age_days) }),
        el('td', null,
          el('div', { class: 'implied' },
            el('div', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(2, Math.round((r.implied_value_usd / max) * 100)) + '%' })),
            el('span', { class: 'value', text: fmtUsd(r.implied_value_usd) })
          )
        ),
        el('td', { class: 'num multiple', text: fmtMultiple(r.implied_value_usd / r.tvl_usd) }),
        el('td', null, el('span', { class: 'status', text: 'no token' }))
      );
      tr.addEventListener('click', function () { openDetail(r.slug); });
      tr.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } });
      tbody.appendChild(tr);
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'panel-head' },
        el('h2', { text: 'Pre-token board' }),
        el('p', { text: 'Ranked by implied value · click a row for its model and farm plan' })
      ),
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { class: 'muted', style: 'display:none', text: 'Pre-token protocols ranked by implied value' }),
          el('thead', null, el('tr', null,
            sortHeader('implied', 'Rank', 'rank'),
            sortHeader('name', 'Protocol'),
            sortHeader('tvl', 'TVL'),
            sortHeader('growth', '7d'),
            sortHeader('age', 'Age'),
            sortHeader('implied', 'Implied value'),
            sortHeader('multiple', 'Value / TVL'),
            el('th', { scope: 'col', text: 'Token record' })
          )),
          tbody
        )
      )
    );
  }

  function liveMatches(r) {
    if (state.category !== 'all' && (r.category || 'Other') !== state.category) return false;
    if (state.chain !== 'all' && (r.chains || []).indexOf(state.chain) < 0) return false;
    var q = state.q.trim().toLowerCase();
    if (!q) return true;
    return [r.name, r.slug, r.category || '', (r.chains || []).join(' ')].join(' ').toLowerCase().indexOf(q) >= 0;
  }

  function liveTable() {
    var list = DATA.live.filter(liveMatches);
    if (list.length === 0) return emptyState();
    var tbody = el('tbody');
    list.forEach(function (r) {
      tbody.appendChild(el('tr', { class: 'live-table' },
        el('td', null, el('span', { class: 'status live', text: 'token live' })),
        el('td', null, el('div', { class: 'protocol' }, el('b', { text: r.name }), el('div', { class: 'meta-line' }, el('span', { class: 'cat', text: r.category || 'Other' }), el('span', { text: (r.chains || []).slice(0, 2).join(' · ') })))),
        el('td', { class: 'num tvl', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + pctClass(r.change_7d), text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtUsd(r.mcap_usd) }),
        el('td', { class: 'num ratio', text: fmtMultiple(r.mcap_tvl) })
      ));
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'panel-head' },
        el('h2', { text: 'Live token peers' }),
        el('p', { text: 'Their market cap is a fact, not the model’s estimate; they calibrate the multiple' })
      ),
      el('div', { class: 'table-wrap' },
        el('table', { class: 'live-table' },
          el('caption', { class: 'muted', style: 'display:none', text: 'Token-bearing protocols and their market cap to TVL ratios' }),
          el('thead', null, el('tr', null,
            el('th', { scope: 'col', text: 'Status' }),
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
    b.addEventListener('click', function () { state.q = ''; state.category = 'all'; state.chain = 'all'; writeHash(); render(); });
    return el('div', { class: 'panel' }, el('div', { class: 'empty' },
      el('h2', { text: 'No protocol matches that filter' }),
      el('p', { text: 'Clear the search or pick another category or chain to see the radar again.' }),
      b
    ));
  }

  function explain() {
    var m = DATA.model;
    var calibrated = DATA.calibration.filter(function (c) {
      return c.comps >= m.calibration_min_comps && DATA.rows.some(function (r) { return (r.category || '(none)') === c.category; });
    }).sort(function (a, b) { return b.comps - a.comps; }).slice(0, 12);
    return el('section', { class: 'panel explain' },
      el('div', null,
        el('h2', { text: 'How implied value is computed' }),
        el('p', null,
          'One function scores every row. It uses four snapshot fields and one statistic learned from the snapshot itself: ',
          el('b', { text: 'TVL' }), ', ', el('b', { text: 'seven-day change' }), ', ', el('b', { text: 'days since DefiLlama began tracking the protocol' }),
          ' and ', el('b', { text: 'whether a token is recorded' }), '. No protocol name is special-cased, there is no hand-picked list, and the page recomputes each row from these figures.'
        )
      ),
      el('div', { class: 'formula' },
        'implied = round( tvl_usd × cat_mult × clamp((tvl_usd / $100M) ^ ' + m.size_elasticity + ', ' + m.size_damping_min + ', ' + m.size_damping_max + ') × (1 + ' + m.growth_weight + ' × tanh(clamp(change_7d, ' + m.growth_floor + ', ' + m.growth_cap + ') / ' + m.growth_scale + ')) × maturity(age_days) )'
      ),
      el('p', null,
        'cat_mult is the category’s FDV/TVL multiple. When the snapshot holds at least ' + m.calibration_min_comps + ' token-bearing protocols in the category, the model learns it from their median market cap over TVL, capped to [' + m.calibration_min_multiple + ', ' + m.calibration_max_multiple + '] and blended ' + Math.round((1 - m.calibration_blend) * 100) + '/' + Math.round(m.calibration_blend * 100) + ' with a stated prior; otherwise the prior stands. maturity rises from ' + m.maturity_floor + ' at listing to ' + m.maturity_ceiling + ' at ' + (m.maturity_days / 365).toFixed(0) + ' years, and an unknown listing day is neutral at 1.00. Live-token protocols are never ranked: their recorded market cap is shown in the Live token tab, and their ratios are the calibration sample.'
      ),
      el('div', { class: 'cal-grid' }, calibrated.map(function (c) {
        return el('div', { class: 'cal' },
          el('div', { class: 'cal-top' }, el('span', { text: c.category }), el('b', { text: fmtMultiple(c.multiple) })),
          el('small', { text: c.comps + ' live peers · median ' + (c.observed_median === null ? 'n/a' : fmtMultiple(c.observed_median)) }),
          el('small', { text: 'prior ' + fmtMultiple(c.prior) + ' · ' + c.source })
        );
      })),
      el('div', { class: 'explain-foot' },
        el('span', null, el('b', { text: 'Snapshot ' }), DATA.as_of + ' · ' + DATA.board_size + ' pre-token rows · floor ' + fmtUsd(DATA.floor_usd)),
        el('span', null, el('b', { text: 'Model ' }), DATA.model_version),
        el('span', { text: 'An implied value is the entry’s own estimate, not a promise that a token exists or will launch.' })
      )
    );
  }

  function metric(label, value, note) {
    return el('div', { class: 'metric' }, el('span', { text: label }), el('b', { text: value }), note ? el('small', { text: note }) : null);
  }

  function detailView(row) {
    var cal = calFor(row.category);
    var rec = recompute(row);
    var peerLine = cal
      ? (cal.comps >= DATA.model.calibration_min_comps && cal.observed_median !== null
        ? 'Token-bearing ' + (row.category || 'peer') + ' protocols trade at a median ' + fmtMultiple(cal.observed_median) + ' TVL across ' + cal.comps + ' peers, so the model applies ' + fmtMultiple(cal.multiple) + '.'
        : 'Only ' + cal.comps + ' token-bearing ' + (row.category || 'peer') + ' peers are in the snapshot, below the ' + DATA.model.calibration_min_comps + '-peer threshold, so the stated prior of ' + fmtMultiple(cal.prior) + ' stands.')
      : 'The model applies its default multiple.';
    var reason = row.name + ' records ' + fmtUsd(row.tvl_usd) + ' of TVL, ' + fmtPct(row.change_7d) + ' over seven days, and ' + (row.age_days === null ? 'no listing day' : fmtAge(row.age_days) + ' of tracked history') + ' with no token on record. ' + peerLine;

    var equation = el('div', { class: 'equation' },
      eqRow('TVL', fmtFull(row.tvl_usd)),
      eqRow('Category multiple', fmtMultiple(row.category_multiple)),
      eqRow('Size damping', row.size_damping.toFixed(3) + 'x'),
      eqRow('Base value', fmtFull(row.base_value_usd)),
      eqRow('7d growth multiplier', row.growth_multiplier.toFixed(3) + 'x'),
      eqRow('Maturity multiplier', row.maturity_multiplier.toFixed(3) + 'x'),
      el('div', { class: 'total' }, el('span', { text: 'Implied value' }), el('b', { text: fmtFull(row.implied_value_usd) }))
    );

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

    var badge = row.is_watchlist ? 'Watchlist' : 'Early find · outside the watchlist';

    return el('div', { class: 'detail' },
      el('button', { class: 'back', type: 'button', text: '← Back to the board', onclick: function () { state.selected = null; writeHash(); render(); } }),
      el('section', { class: 'detail-hero' },
        el('div', null,
          el('div', { class: 'detail-kicker' },
            el('span', { class: 'rank-pill', text: 'RANK ' + row.rank + ' OF ' + DATA.board_size }),
            el('span', { class: 'cat', text: row.category || 'Other' }),
            el('span', { class: row.is_watchlist ? 'watch' : 'early', text: badge })
          ),
          el('h1', { text: row.name }),
          el('p', { class: 'detail-sub', text: (row.chains && row.chains.length ? row.chains.join(' · ') : 'chain unlisted') + ' · ' + (row.age_days === null ? 'listing day unrecorded' : fmtAge(row.age_days) + ' with no token recorded') + ' · ' + fmtFull(row.tvl_usd) + ' TVL' })
        ),
        el('div', { class: 'detail-value' },
          el('span', { text: 'Implied value if its record held' }),
          el('b', { text: fmtUsd(row.implied_value_usd) }),
          el('small', { text: 'value / TVL ' + fmtMultiple(row.implied_value_usd / row.tvl_usd) })
        )
      ),
      el('div', { class: 'metric-grid' },
        metric('TVL', fmtUsd(row.tvl_usd), 'snapshot figure'),
        metric('7d change', fmtPct(row.change_7d), 'growth term, clamped'),
        metric('Age, no token', fmtAge(row.age_days), 'maturity term'),
        metric('Category mult.', fmtMultiple(row.category_multiple), cal ? cal.comps + ' live peers' : 'prior'),
        metric('Growth mult.', row.growth_multiplier.toFixed(2) + 'x', 'bounded by tanh'),
        metric('Maturity mult.', row.maturity_multiplier.toFixed(2) + 'x', '0.80 to 1.15')
      ),
      el('div', { class: 'detail-cols' },
        el('section', { class: 'card' },
          el('h2', null, 'How the number is built'),
          el('p', { class: 'lede', text: 'The page recomputes this row from the snapshot fields and gets ' + fmtFull(rec) + (rec === row.implied_value_usd ? ', the same number board.json carries.' : ', which differs: the data would be stale.') }),
          equation,
          el('div', { class: 'reason' }, el('b', { text: 'Why this score. ' }), reason),
          el('div', { class: 'warn' }, el('b', { text: 'Record, not proof. ' }), 'DefiLlama records no token for this protocol: no ticker, no CoinGecko id, no market cap. That is the record the model reads, not a claim that no token exists or will launch. An implied value is the entry’s estimate, not a price.')
        ),
        el('section', { class: 'card' },
          el('h2', null, 'Farm plan', el('span', { class: 'tag', text: row.farm_steps.length + ' steps' })),
          el('p', { class: 'lede', text: 'Concrete actions with a cost and a time, derived from the protocol’s category, first chain, TVL and age. Check the protocol’s own documentation before moving funds.' }),
          steps
        )
      )
    );
  }

  function eqRow(label, value) {
    return el('div', null, el('span', { text: label }), el('b', { text: value }));
  }

  function openDetail(slug) {
    state.selected = slug;
    writeHash();
    render();
    window.scrollTo(0, 0);
  }

  function render() {
    app.textContent = '';
    var shell = el('div', { class: 'shell' });
    shell.appendChild(topbar());
    var selected = state.selected ? DATA.rows.filter(function (r) { return r.slug === state.selected; })[0] : null;
    if (selected) {
      shell.appendChild(detailView(selected));
    } else {
      shell.appendChild(hero());
      shell.appendChild(toolbar());
      shell.appendChild(chips());
      shell.appendChild(state.tab === 'pre' ? boardTable() : liveTable());
      if (state.tab === 'pre') shell.appendChild(explain());
    }
    shell.appendChild(el('footer', { class: 'foot' },
      el('span', null, el('b', { text: 'Token Radar ' }), DATA.model_version, ' · ' + DATA.board_size + ' pre-token protocols · ' + DATA.watchlist_size + ' watchlist slugs covered'),
      el('span', { text: 'Data: DefiLlama protocol index, snapshot ' + DATA.as_of + ' · no network at render time' })
    ));
    app.appendChild(shell);
    app.setAttribute('aria-busy', 'false');
  }

  readHash();
  render();
  window.addEventListener('hashchange', function () { readHash(); render(); });
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && state.selected) { state.selected = null; writeHash(); render(); }
  });
})();
