(() => {
  const toggle = document.getElementById('literature-sort');
  const menu = document.getElementById('sort-options');
  const list = document.querySelector('.entry-list');

  if (!toggle || !menu) return;

  const control = toggle.closest('.sort-control');
  const label = toggle.querySelector('.sort-label');
  const options = Array.from(menu.querySelectorAll('[data-sort]'));
  const entries = Array.from(list?.children || [], (element, index) => ({
    element,
    title: element.dataset.title,
    date: Number(element.dataset.date),
    index,
  }));
  const alphabet = new Intl.Collator('ru', {
    sensitivity: 'base',
    numeric: true,
    ignorePunctuation: true,
  });

  const setOpen = (open) => {
    toggle.setAttribute('aria-expanded', String(open));
    menu.hidden = !open;
  };

  const sortEntries = (mode) => {
    const ordered = [...entries].sort((a, b) => {
      if (mode === 'title') {
        const titleOrder = alphabet.compare(a.title, b.title);
        if (titleOrder !== 0) return titleOrder;
      }
      return b.date - a.date || a.index - b.index;
    });
    list?.append(...ordered.map((entry) => entry.element));
  };

  toggle.addEventListener('click', () => {
    const opening = menu.hidden;
    setOpen(opening);
    if (opening) {
      options.find((option) => option.getAttribute('aria-checked') === 'true').focus();
    }
  });

  options.forEach((option) => {
    option.addEventListener('click', () => {
      sortEntries(option.dataset.sort);
      label.textContent = option.textContent;
      options.forEach((item) => item.setAttribute('aria-checked', String(item === option)));
      setOpen(false);
      toggle.focus();
    });
  });

  control.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !menu.hidden) {
      event.preventDefault();
      setOpen(false);
      toggle.focus();
      return;
    }

    const index = options.indexOf(event.target);
    const direction = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
    if (direction) {
      event.preventDefault();
      setOpen(true);
      const next = index < 0 ? (direction === 1 ? 0 : options.length - 1) : (index + direction + options.length) % options.length;
      options[next].focus();
    } else if (index >= 0 && (event.key === 'Home' || event.key === 'End')) {
      event.preventDefault();
      options[event.key === 'Home' ? 0 : options.length - 1].focus();
    }
  });

  control.addEventListener('focusout', (event) => {
    if (!control.contains(event.relatedTarget)) setOpen(false);
  });

  document.addEventListener('pointerdown', (event) => {
    if (!control.contains(event.target)) setOpen(false);
  });
})();
