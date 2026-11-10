(() => {
  const main = document.querySelector('[data-reader-manifest]');
  if (!main) return;
  const article = main.querySelector('.reading-text');
  const status = main.querySelector('.text-status');
  status.hidden = false;
  article.setAttribute('aria-busy', 'true');
  const nav = main.querySelector('.text-pagination');
  const previous = nav.querySelector('.text-previous');
  const next = nav.querySelector('.text-next');
  const button = nav.querySelector('button');
  const input = nav.querySelector('input');
  const measure = document.createElement('article');
  measure.className = 'reading-text prose text-measure';
  measure.setAttribute('aria-hidden', 'true');
  document.body.append(measure);
  const cache = new Map();
  const root = new URL(location.pathname, location.href);
  let manifest, current = 1, total = null, editing = false, serial = 0;
  let starts = [{part: 0, offset: 0}], lastWidth = 0, resizeTimer;
  const cancelled = new Error('Superseded reading request');
  const check = token => { if (token !== serial) throw cancelled; };
  const limit = () => matchMedia('(max-width: 600px)').matches
    ? manifest.lines_per_page_mobile : manifest.lines_per_page_desktop;
  const pageURL = (number, hash = '') => {
    const url = new URL(root);
    if (number > 1) url.searchParams.set('page', number);
    url.hash = hash;
    return url.pathname + url.search + url.hash;
  };
  const numberFrom = value => /^[+-]?\d+$/.test(value.trim()) ? Math.max(1, Number(value)) : 1;
  const requested = () => numberFrom(new URL(location.href).searchParams.get('page') || '1');
  const compare = (a, b) => a.part - b.part || a.offset - b.offset;

  async function readJSON(path) {
    const url = new URL(path, location.href);
    if (url.origin !== location.origin) throw new Error('Unexpected reading origin');
    const response = await fetch(url);
    if (!response.ok) throw new Error('Reading resource unavailable');
    return response.json();
  }

  async function blockAt(index, token) {
    if (!cache.has(index)) {
      cache.set(index, await readJSON(manifest.parts[index]));
      if (cache.size > 4) cache.delete(cache.keys().next().value);
    }
    check(token);
    const template = document.createElement('template');
    template.innerHTML = cache.get(index).html;
    let block = template.content.firstElementChild;
    if (!block) {
      block = document.createElement('p');
      block.append(template.content);
    }
    if (block.tagName === 'P' && cache.get(index).join_depth > 0) block.classList.add('reading-continuation');
    return {block, blockId: cache.get(index).block, joinDepth: cache.get(index).join_depth || 0};
  }

  function pointAt(block, offset) {
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let node, remaining = offset;
    while ((node = walker.nextNode())) {
      if (remaining <= node.length) return [node, remaining];
      remaining -= node.length;
    }
    return [block, block.childNodes.length];
  }

  function slice(block, from, to = block.textContent.length) {
    if (!from && to === block.textContent.length) return block.cloneNode(true);
    const range = document.createRange();
    range.selectNodeContents(block);
    if (from) range.setStart(...pointAt(block, from));
    if (to < block.textContent.length) range.setEnd(...pointAt(block, to));
    const copy = block.cloneNode(false);
    let fragment = range.cloneContents();
    let ancestor = range.commonAncestorContainer;
    if (ancestor.nodeType !== Node.ELEMENT_NODE) ancestor = ancestor.parentElement;
    // A range wholly inside one text node omits that node's ancestor markup.
    while (ancestor && ancestor !== block) {
      const wrapper = ancestor.cloneNode(false);
      wrapper.append(fragment);
      fragment = wrapper;
      ancestor = ancestor.parentElement;
    }
    copy.append(fragment);
    if (from && copy.tagName === 'P') copy.classList.add('reading-continuation');
    if (copy.tagName === 'OL') {
      const startNode = pointAt(block, from)[0];
      const item = (startNode.nodeType === Node.ELEMENT_NODE ? startNode : startNode.parentElement).closest('li');
      if (item && item.parentElement === block) copy.start = (Number(block.getAttribute('start')) || 1) + [...block.children].indexOf(item);
    }
    return copy;
  }

  async function readyAssets(element) {
    await Promise.all([...element.querySelectorAll('img')].map(async img => {
      img.loading = 'eager';
      try { await img.decode(); } catch { /* Layout still works for an unavailable image. */ }
    }));
  }

  function join(left, right, depth) {
    if (depth > 1 && left.lastChild && right.firstChild) {
      join(left.lastChild, right.firstChild, depth - 1);
      right.firstChild.remove();
    }
    left.append(...right.childNodes);
  }

  function lineCount(element) {
    const rects = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (!node.textContent.trim() && !node.parentElement.closest('pre')) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) if (rect.height > 0 && rect.width > 0) rects.push(rect);
    }
    for (const item of element.querySelectorAll('br,img,svg,video')) {
      const rect = item.getBoundingClientRect();
      if (rect.height > 0) rects.push(rect);
    }
    rects.sort((a, b) => a.top - b.top);
    const rows = [];
    for (const rect of rects) {
      const row = rows.at(-1);
      if (row && rect.top < row.bottom - Math.min(row.bottom - row.top, rect.height) * .25) row.bottom = Math.max(row.bottom, rect.bottom);
      else rows.push({top: rect.top, bottom: rect.bottom});
    }
    return rows.length;
  }

  function wordBoundary(text, offset, minimum, joining) {
    if (offset >= text.length) return offset;
    if (/\S/.test(text[offset - 1] || '') && /\S/.test(text[offset] || '')) {
      const prefix = text.slice(minimum, offset);
      const whitespace = prefix.search(/\s+\S*$/);
      if (whitespace >= 0 && prefix.slice(0, whitespace).trim()) offset = minimum + whitespace + 1;
      else if (joining && whitespace < 0) return minimum;
    }
    // Keep surrogate pairs and combining characters together even for a very long word.
    if (typeof Intl.Segmenter === 'function') {
      let boundary = minimum;
      for (const item of new Intl.Segmenter(undefined, {granularity:'grapheme'}).segment(text.slice(minimum))) {
        const end = minimum + item.index + item.segment.length;
        if (end > offset) break;
        boundary = end;
      }
      if (boundary > minimum) offset = boundary;
    }
    return offset;
  }

  async function paginate(start, token) {
    check(token);
    measure.replaceChildren();
    measure.style.width = article.getBoundingClientRect().width + 'px';
    let cursor = {...start}, lastBlock = null;
    while (cursor.part < manifest.parts.length) {
      const {block, blockId, joinDepth} = await blockAt(cursor.part, token);
      const length = block.textContent.length;
      const joining = joinDepth > 0 && lastBlock === blockId;
      const original = joining ? measure.lastElementChild.cloneNode(true) : null;
      let candidate;
      const setCandidate = fragment => {
        if (joining) {
          const combined = original.cloneNode(true);
          join(combined, fragment, joinDepth);
          if (candidate) candidate.replaceWith(combined); else measure.lastElementChild.replaceWith(combined);
          candidate = combined;
        } else {
          if (candidate) candidate.replaceWith(fragment); else measure.append(fragment);
          candidate = fragment;
        }
      };
      setCandidate(slice(block, cursor.offset));
      await readyAssets(candidate);
      check(token);
      if (lineCount(measure) <= limit()) {
        lastBlock = blockId;
        cursor = {part: cursor.part + 1, offset: 0};
        continue;
      }
      // Fit a prefix of a block, preserving its inline markup and nested structure.
      let low = cursor.offset, high = length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        setCandidate(slice(block, cursor.offset, middle));
        if (lineCount(measure) <= limit()) low = middle; else high = middle - 1;
      }
      let end = wordBoundary(block.textContent, low, cursor.offset, joining);
      if (end > cursor.offset && block.textContent.slice(cursor.offset, end).trim()) {
        setCandidate(slice(block, cursor.offset, end));
        cursor = end >= length ? {part: cursor.part + 1, offset: 0} : {part: cursor.part, offset: end};
      } else {
        if (joining) candidate.replaceWith(original); else candidate.remove();
        if (!measure.textContent.trim() && !measure.querySelector('img,svg,video,hr')) {
          // An indivisible object (or a large glyph) still gets a usable page.
          measure.append(slice(block, cursor.offset));
          cursor = {part: cursor.part + 1, offset: 0};
        }
      }
      break;
    }
    const fragment = document.createDocumentFragment();
    fragment.append(...measure.childNodes);
    return {fragment, end: cursor};
  }

  async function pageAt(number, token) {
    let result;
    while (starts.length < number && total === null) {
      const index = starts.length - 1;
      result = await paginate(starts[index], token);
      if (result.end.part >= manifest.parts.length) total = index + 1;
      else starts.push(result.end);
      if (starts.length % 20 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    }
    const selected = total === null ? number : Math.min(number, total);
    result = await paginate(starts[selected - 1], token);
    if (result.end.part >= manifest.parts.length) total = selected;
    else if (starts.length === selected) starts.push(result.end);
    return {number: selected, ...result};
  }

  function close() {
    editing = false;
    input.hidden = true;
    button.hidden = false;
    input.value = String(current);
    button.setAttribute('aria-expanded', 'false');
  }

  async function display(number, {replace = false, scroll = true, anchor = null, hash = ''} = {}) {
    const token = ++serial;
    close();
    article.setAttribute('aria-busy', 'true');
    main.dataset.readerState = 'loading';
    status.hidden = false;
    status.textContent = 'Загрузка текста…';
    try {
      let result;
      if (anchor) {
        number = 1;
        do { result = await pageAt(number++, token); }
        while (compare(result.end, anchor) <= 0 && result.end.part < manifest.parts.length);
      } else result = await pageAt(number, token);
      check(token);
      current = result.number;
      article.replaceChildren(result.fragment);
      article.setAttribute('aria-busy', 'false');
      previous.hidden = current === 1;
      next.hidden = result.end.part >= manifest.parts.length;
      previous.href = pageURL(current - 1);
      next.href = pageURL(current + 1);
      nav.dataset.current = String(current);
      nav.dataset.total = total === null ? '' : String(total);
      nav.dataset.limit = String(limit());
      button.textContent = String(current);
      button.setAttribute('aria-label', `Страница ${current}. Изменить номер`);
      input.value = String(current);
      nav.hidden = false;
      status.hidden = true;
      main.dataset.readerState = 'ready';
      const url = pageURL(current, hash);
      if (url !== location.pathname + location.search + location.hash) history[replace ? 'replaceState' : 'pushState'](null, '', url);
      if (hash) document.getElementById(hash)?.scrollIntoView({block:'start',behavior:'instant'});
      else if (scroll) main.scrollIntoView({block:'start',behavior:'instant'});
    } catch (error) {
      if (error === cancelled || token !== serial) return;
      main.dataset.readerState = 'error';
      article.setAttribute('aria-busy', 'false');
      status.hidden = false;
      status.textContent = 'Не удалось загрузить текст. Обновите страницу, чтобы повторить.';
    } finally {
      if (token === serial) measure.replaceChildren();
    }
  }

  const commit = () => {
    if (!editing) return;
    const value = input.value.trim();
    const number = /^[+-]?\d+$/.test(value) ? numberFrom(value) : current;
    close();
    if (number !== current) void display(number);
  };
  button.addEventListener('click', () => {
    editing = true;
    button.hidden = true;
    button.setAttribute('aria-expanded', 'true');
    input.hidden = false;
    input.focus();
    input.select();
  });
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === 'Escape') {
      event.preventDefault();
      if (event.key === 'Enter') commit(); else close();
      button.focus();
    }
  });
  document.addEventListener('pointerdown', event => {
    if (editing && !nav.contains(event.target)) commit();
    else if (editing && event.target.closest('a')) close();
  });
  nav.addEventListener('click', event => {
    const link = event.target.closest('a');
    if (!link || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button) return;
    event.preventDefault();
    void display(numberFrom(new URL(link.href).searchParams.get('page') || '1'));
  });

  async function showHash(hash, replace = false) {
    const id = decodeURIComponent(hash.replace(/^#/, ''));
    const part = manifest.anchors[id];
    if (part === undefined) return display(requested(), {replace, hash:id, scroll:false});
    const token = serial;
    const {block} = await blockAt(part, token);
    const element = block.id === id ? block : block.querySelector('#' + CSS.escape(id));
    const range = document.createRange();
    range.selectNodeContents(block);
    if (element && element !== block) range.setEndBefore(element); else range.setEnd(block, 0);
    return display(1, {replace, hash:id, anchor:{part,offset:range.toString().length}});
  }
  article.addEventListener('click', event => {
    const link = event.target.closest('a[href]');
    if (!link || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button) return;
    const url = new URL(link.href);
    if (url.origin === location.origin && url.pathname === root.pathname && url.hash) {
      event.preventDefault();
      void showHash(url.hash);
    }
  });
  window.addEventListener('popstate', () => {
    if (manifest) void (location.hash ? showHash(location.hash, true) : display(requested(), {replace:true}));
  });
  function resized() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const width = article.getBoundingClientRect().width;
      if (!manifest || Math.abs(width - lastWidth) < .5 && Number(nav.dataset.limit) === limit()) return;
      const anchor = starts[current - 1];
      lastWidth = width;
      starts = [{part:0,offset:0}];
      total = null;
      void display(1, {replace:true, scroll:false, anchor});
    }, 150);
  }
  new ResizeObserver(resized).observe(article);
  document.fonts.addEventListener('loadingdone', resized);

  (async () => {
    try {
      manifest = await readJSON(main.dataset.readerManifest);
      if (manifest.format !== 'reading-parts-v1' || !manifest.parts.length) throw new Error('Invalid reading manifest');
      await document.fonts.ready;
      lastWidth = article.getBoundingClientRect().width;
      await (location.hash ? showHash(location.hash, true) : display(requested(), {replace:true,scroll:false}));
    } catch {
      main.dataset.readerState = 'error';
      article.setAttribute('aria-busy', 'false');
      status.textContent = 'Не удалось загрузить текст. Обновите страницу, чтобы повторить.';
    }
  })();
})();
