/* Teide JS Documentation - Sidebar, Active Links & Syntax Highlighting */
(function () {
  'use strict';

  /* --- Mobile sidebar toggle --- */
  var hamburger = document.querySelector('.hamburger');
  var sidebar = document.querySelector('.sidebar');
  var overlay = document.querySelector('.sidebar-overlay');

  function openSidebar() {
    sidebar.classList.add('open');
    overlay.classList.add('open');
  }
  function closeSidebar() {
    sidebar.classList.remove('open');
    overlay.classList.remove('open');
  }
  if (hamburger) hamburger.addEventListener('click', openSidebar);
  if (overlay) overlay.addEventListener('click', closeSidebar);

  /* --- Active link highlighting --- */
  var path = location.pathname;
  path = path.replace(/index\.html$/, '');
  var links = document.querySelectorAll('.sidebar-link');
  links.forEach(function (a) {
    var href = a.getAttribute('href');
    if (!href) return;
    var resolved = new URL(href, a.baseURI).pathname.replace(/index\.html$/, '');
    if (resolved === path) a.classList.add('active');
  });

  /* === Shared helpers === */
  function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function makeHighlighter(protectors, replacers) {
    return function (text) {
      var tokens = [];
      var i = 0;
      function protect(re, cls) {
        text = text.replace(re, function (m) {
          var id = '\x01\x02\x03' + String.fromCharCode(0xE000 + i) + '\x03\x02\x01';
          tokens.push({ id: id, html: '<span class="' + cls + '">' + esc(m) + '</span>' });
          i++;
          return id;
        });
      }
      protectors.forEach(function (p) { protect(p.re, p.cls); });
      text = esc(text);
      replacers.forEach(function (r) {
        if (r.fn) {
          text = text.replace(r.re, r.fn);
        } else {
          text = text.replace(r.re, r.tpl);
        }
      });
      tokens.forEach(function (t) { text = text.replace(t.id, t.html); });
      return text;
    };
  }

  /* === SQL Highlighter === */
  var SQL_KEYWORDS = [
    'SELECT','FROM','WHERE','INSERT','INTO','VALUES','CREATE','TABLE','DROP',
    'AS','ON','JOIN','INNER','LEFT','RIGHT','FULL','OUTER','CROSS',
    'GROUP','BY','ORDER','HAVING','LIMIT','OFFSET','DISTINCT','ALL',
    'UNION','INTERSECT','EXCEPT','AND','OR','NOT','IN','BETWEEN',
    'LIKE','ILIKE','IS','NULL','CASE','WHEN','THEN','ELSE','END',
    'CAST','FILTER','OVER','PARTITION','ROWS','RANGE','UNBOUNDED',
    'PRECEDING','FOLLOWING','CURRENT','ROW','WITH','IF','EXISTS',
    'REPLACE','ASC','DESC','NULLS','FIRST','LAST','SET','TRUE','FALSE',
    'RECURSIVE','DELETE','UPDATE','PROPERTY','GRAPH','VERTEX','EDGE',
    'TABLES','MATCH','COLUMNS','KEY','SOURCE','DESTINATION','REFERENCES',
    'LABEL','PROPERTIES','CHEAPEST','COST','SHORTEST','ANY','WALK',
    'VECTOR','INDEX','USING','HNSW'
  ];
  var SQL_FUNCTIONS = [
    'COUNT','SUM','AVG','MIN','MAX','FIRST_VALUE','LAST_VALUE','NTH_VALUE',
    'ROW_NUMBER','RANK','DENSE_RANK','NTILE','LAG','LEAD',
    'ABS','CEIL','CEILING','FLOOR','SQRT','ROUND','LN','LOG','EXP',
    'LEAST','GREATEST','UPPER','LOWER','LENGTH','LEN','CHAR_LENGTH',
    'TRIM','BTRIM','SUBSTR','SUBSTRING','CONCAT','COALESCE','NULLIF',
    'EXTRACT','DATE_TRUNC','DATE_DIFF','DATEDIFF','NOW',
    'CURRENT_DATE','CURRENT_TIMESTAMP',
    'STDDEV','STDDEV_SAMP','STDDEV_POP','VARIANCE','VAR_SAMP','VAR_POP',
    'COUNT_DISTINCT','CHARACTER_LENGTH',
    'READ_CSV','PAGERANK','COMPONENT','CONNECTED_COMPONENT',
    'COMMUNITY','LOUVAIN','CLUSTERING_COEFFICIENT','CLUSTERING_COEFF',
    'SHORTEST_DISTANCE','DIJKSTRA',
    'COSINE_SIMILARITY','EUCLIDEAN_DISTANCE',
    'GRAPH_TABLE'
  ];
  var SQL_TYPES = [
    'BOOLEAN','BOOL','INTEGER','INT','INT4','BIGINT','INT8','INT64',
    'REAL','DOUBLE','FLOAT','VARCHAR','TEXT','STRING',
    'DATE','TIME','TIMESTAMP','SYM','SMALLINT','NUMERIC','DECIMAL',
    'DOUBLE PRECISION','CHAR'
  ];

  var highlightSQL = makeHighlighter(
    [
      { re: /--[^\n]*/g, cls: 'cm' },
      { re: /'[^']*'/g, cls: 'str' }
    ],
    [
      { re: new RegExp('\\b(' + SQL_TYPES.join('|') + ')\\b', 'gi'), tpl: '<span class="ty">$1</span>' },
      { re: new RegExp('\\b(' + SQL_FUNCTIONS.join('|') + ')\\s*(?=\\()', 'gi'), fn: function (m, f) { return '<span class="fn">' + f + '</span>'; } },
      { re: new RegExp('\\b(' + SQL_KEYWORDS.join('|') + ')\\b', 'g'), tpl: '<span class="kw">$1</span>' },
      { re: /\b\d+(\.\d+)?\b/g, tpl: '<span class="num">$&</span>' }
    ]
  );

  /* === JavaScript / TypeScript Highlighter === */
  var JS_KEYWORDS = [
    'async','await','break','case','catch','class','const','continue','debugger',
    'default','delete','do','else','export','extends','false','finally','for',
    'from','function','if','import','in','instanceof','let','new','null','of',
    'return','static','super','switch','this','throw','true','try','typeof',
    'undefined','var','void','while','yield'
  ];
  var JS_TYPES = [
    'string','number','boolean','any','void','never','unknown','object',
    'Promise','Table','Series','Context','Query','GroupBy','Expr',
    'NativeContext','NativeTable','NativeSeries','Session','StoredTable',
    'PropertyGraph','VectorIndex','Array','Map','Set','Buffer','TypedArray',
    'Float64Array','Int32Array','BigInt64Array','Uint8Array'
  ];

  var highlightJS = makeHighlighter(
    [
      { re: /\/\/[^\n]*/g, cls: 'cm' },
      { re: /\/\*[\s\S]*?\*\//g, cls: 'cm' },
      { re: /`(?:[^`\\]|\\.)*`/g, cls: 'str' },
      { re: /"(?:[^"\\]|\\.)*"/g, cls: 'str' },
      { re: /'(?:[^'\\]|\\.)*'/g, cls: 'str' }
    ],
    [
      { re: new RegExp('\\b(' + JS_TYPES.join('|') + ')\\b', 'g'), tpl: '<span class="ty">$1</span>' },
      { re: new RegExp('\\b(' + JS_KEYWORDS.join('|') + ')\\b', 'g'), tpl: '<span class="kw">$1</span>' },
      { re: /\b\d+(\.\d+)?\b/g, tpl: '<span class="num">$&</span>' },
      { re: /\b([a-zA-Z_]\w*)\s*(?=\()/g, fn: function (m, f) { return '<span class="fn">' + f + '</span>'; } }
    ]
  );

  /* === Bash Highlighter === */
  var BASH_KEYWORDS = [
    'if','then','else','elif','fi','for','while','do','done','case','esac',
    'in','function','return','exit','export','source','alias','cd','echo',
    'sudo','chmod','chown','mkdir','rm','cp','mv','ls','cat','grep','find',
    'npm','npx','node','git','vitest'
  ];

  var highlightBash = makeHighlighter(
    [
      { re: /#[^\n]*/g, cls: 'cm' },
      { re: /"(?:[^"\\]|\\.)*"/g, cls: 'str' },
      { re: /'[^']*'/g, cls: 'str' }
    ],
    [
      { re: /--[\w][\w-]*/g, tpl: '<span class="op">$&</span>' },
      { re: /-[a-zA-Z]\b/g, tpl: '<span class="op">$&</span>' },
      { re: new RegExp('\\b(' + BASH_KEYWORDS.join('|') + ')\\b', 'g'), tpl: '<span class="kw">$1</span>' },
      { re: /\$[\w]+/g, tpl: '<span class="fn">$&</span>' },
      { re: /\b\d+\b/g, tpl: '<span class="num">$&</span>' }
    ]
  );

  /* === JSON Highlighter === */
  var highlightJSON = makeHighlighter(
    [
      { re: /"(?:[^"\\]|\\.)*"/g, cls: 'str' }
    ],
    [
      { re: /\b(true|false|null)\b/g, tpl: '<span class="kw">$1</span>' },
      { re: /\b-?\d+(\.\d+)?([eE][+-]?\d+)?\b/g, tpl: '<span class="num">$&</span>' }
    ]
  );

  /* === Apply highlighting === */
  var highlighters = {
    'language-sql': highlightSQL,
    'language-javascript': highlightJS,
    'language-js': highlightJS,
    'language-typescript': highlightJS,
    'language-ts': highlightJS,
    'language-bash': highlightBash,
    'language-sh': highlightBash,
    'language-shell': highlightBash,
    'language-json': highlightJSON
  };

  document.querySelectorAll('pre code').forEach(function (block) {
    var cls = block.className;
    for (var lang in highlighters) {
      if (cls.indexOf(lang) !== -1) {
        block.innerHTML = highlighters[lang](block.textContent);
        return;
      }
    }
  });
})();
