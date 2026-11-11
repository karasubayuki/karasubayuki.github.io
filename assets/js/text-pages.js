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
  const measurementArea = () => {
    const element = document.createElement('article');
    element.className = 'reading-text prose text-measure';
    element.setAttribute('aria-hidden', 'true');
    document.body.append(element);
    return element;
  };
  const measure = measurementArea(), aheadMeasure = measurementArea();
  const pages = new Map();
  const root = new URL(location.pathname, location.href);
  let manifest, current = 1, total = null, editing = false, serial = 0;
  let starts = [{part: 0, offset: 0}], lastWidth = 0, resizeTimer;
  let fullText, cancelPreparation = () => {};
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

  function validPart(part) {
    return part && typeof part.html === 'string' && Number.isInteger(part.block)
      && Number.isInteger(part.join_depth) && part.join_depth >= 0;
  }

  function loadFullText() {
    if (!fullText) {
      main.dataset.textState = 'loading';
      fullText = readJSON(main.dataset.readerManifest).then(data => {
        if (data.format !== 'reading-bundle-v2' || data.revision !== manifest.revision
            || !Array.isArray(data.parts) || data.parts.length !== manifest.parts.length
            || !data.parts.every(validPart)) throw new Error('Invalid reading bundle');
        manifest.parts = data.parts;
        main.dataset.textState = 'ready';
      }).catch(error => {
        fullText = null;
        main.dataset.textState = 'error';
        throw error;
      });
    }
    return fullText;
  }

  async function blockAt(index, token) {
    if (!manifest.parts[index]) await loadFullText();
    check(token);
    const part = manifest.parts[index];
    const template = document.createElement('template');
    template.innerHTML = part.html;
    let block = template.content.firstElementChild;
    if (!block) {
      block = document.createElement('p');
      block.append(template.content);
    }
    if (block.tagName === 'P' && part.join_depth > 0) block.classList.add('reading-continuation');
    return {block, blockId: part.block, joinDepth: part.join_depth};
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

  async function paginate(start, token, area = measure) {
    check(token);
    const measure = area;
    measure.replaceChildren();
    measure.style.width = article.getBoundingClientRect().width + 'px';
    let cursor = {...start}, lastBlock = null, sliceStarted = performance.now();
    while (cursor.part < manifest.parts.length) {
      if (area === aheadMeasure && performance.now() - sliceStarted > 8) {
        await new Promise(resolve => setTimeout(resolve, 0));
        check(token);
        sliceStarted = performance.now();
      }
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

  function remember(number, result) {
    pages.delete(number);
    pages.set(number, {fragment: result.fragment.cloneNode(true), end: {...result.end}});
    while (pages.size > 5) pages.delete(pages.keys().next().value);
  }

  async function pageAt(number, token, area = measure) {
    check(token);
    let result;
    while (starts.length < number && total === null) {
      const index = starts.length - 1;
      result = await paginate(starts[index], token, area);
      check(token);
      remember(index + 1, result);
      if (result.end.part >= manifest.parts.length) total = index + 1;
      else starts.push(result.end);
      if (starts.length % 20 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    }
    const selected = total === null ? number : Math.min(number, total);
    if (pages.has(selected)) {
      const cached = pages.get(selected);
      result = {fragment: cached.fragment.cloneNode(true), end: {...cached.end}};
    } else result = await paginate(starts[selected - 1], token, area);
    check(token);
    remember(selected, result);
    if (result.end.part >= manifest.parts.length) total = selected;
    else if (starts.length === selected) starts.push(result.end);
    return {number: selected, ...result};
  }

  function prepareNext(token) {
    // Let the visible page paint before starting the full download and layout work.
    const frame = requestAnimationFrame(() => {
      const timer = setTimeout(async () => {
        try {
          check(token);
          await loadFullText();
          check(token);
          if (total !== null && current >= total) return;
          await pageAt(current + 1, token, aheadMeasure);
          check(token);
          main.dataset.preparedPage = String(current + 1);
        } catch { /* A failed speculative load leaves the current page usable; navigation can retry. */ }
        finally { if (token === serial) aheadMeasure.replaceChildren(); }
      }, 0);
      cancelPreparation = () => clearTimeout(timer);
    });
    cancelPreparation = () => cancelAnimationFrame(frame);
  }

  function close() {
    editing = false;
    input.hidden = true;
    button.hidden = false;
    input.value = String(current);
    button.setAttribute('aria-expanded', 'false');
  }

  async function display(number, {replace = false, scroll = true, anchor = null, hash = ''} = {}) {
    cancelPreparation();
    const token = ++serial;
    aheadMeasure.replaceChildren();
    delete main.dataset.preparedPage;
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
      prepareNext(token);
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
      pages.clear();
      void display(1, {replace:true, scroll:false, anchor});
    }, 150);
  }
  new ResizeObserver(resized).observe(article);
  document.fonts.addEventListener('loadingdone', resized);

  (async () => {
    try {
      manifest = JSON.parse(document.getElementById('reader-bootstrap').textContent);
      if (manifest.format !== 'reading-bundle-v2' || !Number.isInteger(manifest.part_count)
          || manifest.part_count < 1 || !Array.isArray(manifest.parts) || !manifest.parts.length
          || manifest.parts.length > manifest.part_count || !manifest.parts.every(validPart)) throw new Error('Invalid reading start');
      manifest.parts.length = manifest.part_count;
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
