// @ts-check
(function () {
  const vscode = acquireVsCodeApi();

  /** @type {{versions: any[], relPath: string, folderId: string, reversed: boolean, searching: boolean}} */
  let state = {
    versions: [],
    relPath: '',
    folderId: '',
    reversed: false,
    searching: false,
  };
  let selectedId = null;
  /** 用于双版本对比的第二个选中项 */
  let compareId = null;

  const el = {
    search: /** @type {HTMLInputElement} */ (document.getElementById('search')),
    tagFilter: /** @type {HTMLSelectElement} */ (document.getElementById('tagFilter')),
    timeFilter: /** @type {HTMLSelectElement} */ (document.getElementById('timeFilter')),
    reverse: /** @type {HTMLButtonElement} */ (document.getElementById('reverse')),
    snapshot: /** @type {HTMLButtonElement} */ (document.getElementById('snapshot')),
    settings: /** @type {HTMLButtonElement} */ (document.getElementById('settings')),
    fileBar: /** @type {HTMLElement} */ (document.getElementById('fileBar')),
    timeline: /** @type {HTMLElement} */ (document.getElementById('timeline')),
    menu: /** @type {HTMLElement} */ (document.getElementById('menu')),
  };

  function post(type, payload) {
    vscode.postMessage(Object.assign({ type }, payload || {}));
  }

  let searchTimer = null;
  el.search.addEventListener('input', () => {
    if (searchTimer) {
      clearTimeout(searchTimer);
    }
    searchTimer = setTimeout(() => post('search', { keyword: el.search.value }), 250);
  });
  el.tagFilter.addEventListener('change', () => post('filter', { tag: el.tagFilter.value }));
  el.timeFilter.addEventListener('change', () => post('filter', { time: el.timeFilter.value }));
  el.reverse.addEventListener('click', () => post('reverse'));
  el.snapshot.addEventListener('click', () => post('snapshot'));
  el.settings.addEventListener('click', () => post('settings'));

  document.addEventListener('click', () => hideMenu());
  window.addEventListener('blur', () => hideMenu());

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === 'data') {
      state = message;
      if (!state.versions.some((v) => v.id === selectedId)) {
        selectedId = state.versions.length > 0 ? state.versions[0].id : null;
      }
      if (typeof message.keyword === 'string' && el.search.value !== message.keyword) {
        el.search.value = message.keyword;
      }
      if (message.tagOptions) {
        renderTagOptions(message.tagOptions, message.tag);
      }
      render();
    } else if (message.type === 'select') {
      selectedId = message.id;
      render();
    }
  });

  function renderTagOptions(options, current) {
    const previous = current || el.tagFilter.value;
    el.tagFilter.textContent = '';
    const all = document.createElement('option');
    all.value = '';
    all.textContent = '全部标签';
    el.tagFilter.appendChild(all);
    for (const opt of options) {
      const o = document.createElement('option');
      o.value = opt.value;
      o.textContent = opt.label;
      el.tagFilter.appendChild(o);
    }
    el.tagFilter.value = options.some((o) => o.value === previous) ? previous : '';
  }

  function render() {
    el.fileBar.textContent = '';
    if (state.relPath) {
      const strong = document.createElement('strong');
      strong.textContent = state.relPath;
      el.fileBar.appendChild(strong);
      const info = document.createElement('span');
      info.textContent = `  ·  ${state.versions.length} 个版本` + (state.reversed ? '  ·  对比方向：当前 ↔ 历史' : '');
      el.fileBar.appendChild(info);
    } else {
      el.fileBar.textContent = '未选择文件';
    }

    el.timeline.textContent = '';
    if (state.versions.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = state.searching
        ? '没有匹配的历史版本。'
        : '这个文件还没有历史记录。保存一次，或者点上面的「快照」按钮。';
      el.timeline.appendChild(empty);
      return;
    }

    let lastGroup = null;
    for (const v of state.versions) {
      if (v.group !== lastGroup) {
        lastGroup = v.group;
        const label = document.createElement('div');
        label.className = 'group-label';
        label.textContent = v.group;
        el.timeline.appendChild(label);
      }
      el.timeline.appendChild(renderRow(v));
    }
  }

  function renderRow(v) {
    const row = document.createElement('div');
    row.className = 'row';
    if (v.id === selectedId) {
      row.classList.add('selected');
    }
    if (v.id === compareId) {
      row.classList.add('compare');
    }
    row.dataset.id = v.id;

    const top = document.createElement('div');
    top.className = 'row-top';
    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = v.time;
    top.appendChild(time);

    const stat = document.createElement('span');
    stat.className = 'stat';
    if (v.added > 0) {
      const add = document.createElement('span');
      add.className = 'add';
      add.textContent = `+${v.added}`;
      stat.appendChild(add);
    }
    if (v.removed > 0) {
      if (stat.childNodes.length > 0) {
        stat.appendChild(document.createTextNode(' '));
      }
      const del = document.createElement('span');
      del.className = 'del';
      del.textContent = `-${v.removed}`;
      stat.appendChild(del);
    }
    top.appendChild(stat);

    const rel = document.createElement('span');
    rel.className = 'relative';
    rel.textContent = v.relative;
    top.appendChild(rel);
    row.appendChild(top);

    if (v.label || (v.tags && v.tags.length > 0)) {
      const tags = document.createElement('div');
      tags.className = 'tags';
      if (v.label) {
        const t = document.createElement('span');
        t.className = 'tag label';
        t.textContent = v.label;
        tags.appendChild(t);
      }
      for (const tag of v.tags || []) {
        const t = document.createElement('span');
        t.className = 'tag ' + tag.kind;
        t.textContent = tag.text;
        tags.appendChild(t);
      }
      row.appendChild(tags);
    }

    row.addEventListener('click', (e) => {
      e.stopPropagation();
      hideMenu();
      if (e.ctrlKey || e.metaKey) {
        // 多选两个版本互相对比
        compareId = compareId === v.id ? null : v.id;
        if (compareId && selectedId && compareId !== selectedId) {
          post('compare', { a: selectedId, b: compareId });
        }
        render();
        return;
      }
      compareId = null;
      selectedId = v.id;
      render();
      post('select', { id: v.id });
    });

    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      selectedId = v.id;
      render();
      showMenu(e.clientX, e.clientY, v);
    });

    return row;
  }

  function showMenu(x, y, v) {
    el.menu.textContent = '';
    const items = [
      { text: '与当前版本对比', action: () => post('select', { id: v.id }) },
      { text: '还原到此版本', action: () => post('restore', { id: v.id }) },
      { text: '选择要恢复的变更块…', action: () => post('restoreHunks', { id: v.id }) },
      { sep: true },
      { text: v.label ? '修改标签…' : '添加标签…', action: () => post('label', { id: v.id }) },
      { text: '导出此版本…', action: () => post('export', { id: v.id }) },
      { sep: true },
      { text: '删除此版本', action: () => post('delete', { id: v.id }) },
    ];
    for (const item of items) {
      if (item.sep) {
        const sep = document.createElement('div');
        sep.className = 'menu-sep';
        el.menu.appendChild(sep);
        continue;
      }
      const node = document.createElement('div');
      node.className = 'menu-item';
      node.textContent = item.text;
      node.addEventListener('click', (e) => {
        e.stopPropagation();
        hideMenu();
        item.action();
      });
      el.menu.appendChild(node);
    }
    el.menu.hidden = false;
    const rect = el.menu.getBoundingClientRect();
    el.menu.style.left = Math.min(x, window.innerWidth - rect.width - 8) + 'px';
    el.menu.style.top = Math.min(y, window.innerHeight - rect.height - 8) + 'px';
  }

  function hideMenu() {
    el.menu.hidden = true;
  }

  post('ready');
})();
