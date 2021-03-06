/* global
  $
  $$
  $create
  animateElement
  API
  CHROME
  CHROME_HAS_BORDER_BUG
  configDialog
  FIREFOX
  getActiveTab
  hotkeys
  msg
  onDOMready
  prefs
  setupLivePrefs
  t
  tryJSONparse
  URLS
*/

'use strict';

/** @type Element */
let installed;
/** @type string */
let tabURL;
const handleEvent = {};

const ABOUT_BLANK = 'about:blank';
const ENTRY_ID_PREFIX_RAW = 'style-';

$.entry = styleOrId => $(`#${ENTRY_ID_PREFIX_RAW}${styleOrId.id || styleOrId}`);

if (CHROME >= 66 && CHROME <= 69) { // Chrome 66-69 adds a gap, https://crbug.com/821143
  document.head.appendChild($create('style', 'html { overflow: overlay }'));
}

toggleSideBorders();

initTabUrls()
  .then(frames =>
    Promise.all([
      onDOMready().then(() => initPopup(frames)),
      ...frames
        .filter(f => f.url && !f.isDupe)
        .map(({url}) => getStyleDataMerged(url).then(styles => ({styles, url}))),
    ]))
  .then(([, ...results]) => {
    const sliders = prefs.get('ui.sliders');
    const slot = $('toggle', t.template.style);
    const toggle = t.template[sliders ? 'toggleSlider' : 'toggleChecker'];
    slot.parentElement.replaceChild(toggle.cloneNode(true), slot);
    document.body.classList.toggle('has-sliders', sliders);
    if (results[0]) {
      showStyles(results);
    } else {
      // unsupported URL;
      $('#popup-manage-button').removeAttribute('title');
    }
  })
  .catch(console.error);

msg.onExtension(onRuntimeMessage);

prefs.subscribe(['popup.stylesFirst'], (key, stylesFirst) => {
  const actions = $('body > .actions');
  const before = stylesFirst ? actions : actions.nextSibling;
  document.body.insertBefore(installed, before);
});
prefs.subscribe(['popupWidth'], (key, value) => setPopupWidth(value));

if (CHROME_HAS_BORDER_BUG) {
  prefs.subscribe(['popup.borders'], (key, value) => toggleSideBorders(value));
}

function onRuntimeMessage(msg) {
  if (!tabURL) return;
  let ready = Promise.resolve();
  switch (msg.method) {
    case 'styleAdded':
    case 'styleUpdated':
      if (msg.reason === 'editPreview' || msg.reason === 'editPreviewEnd') return;
      ready = handleUpdate(msg);
      break;
    case 'styleDeleted':
      handleDelete(msg.style.id);
      break;
  }
  ready.then(() => dispatchEvent(new CustomEvent(msg.method, {detail: msg})));
}


function setPopupWidth(width = prefs.get('popupWidth')) {
  document.body.style.width =
    Math.max(200, Math.min(800, width)) + 'px';
}


function toggleSideBorders(state = prefs.get('popup.borders')) {
  // runs before <body> is parsed
  const style = document.documentElement.style;
  if (CHROME_HAS_BORDER_BUG && state) {
    style.cssText +=
      'border-left: 2px solid white !important;' +
      'border-right: 2px solid white !important;';
  } else if (style.cssText) {
    style.borderLeft = style.borderRight = '';
  }
}

async function initTabUrls() {
  let tab = await getActiveTab();
  if (FIREFOX && tab.status === 'loading' && tab.url === ABOUT_BLANK) {
    tab = await waitForTabUrlFF(tab);
  }
  let frames = await browser.webNavigation.getAllFrames({tabId: tab.id});
  let url = tab.pendingUrl || tab.url || ''; // new Chrome uses pendingUrl while connecting
  frames = sortTabFrames(frames);
  if (url === 'chrome://newtab/' && !URLS.chromeProtectsNTP) {
    url = frames[0].url || '';
  }
  if (!URLS.supported(url)) {
    url = '';
    frames.length = 1;
  }
  tabURL = frames[0].url = url;
  return frames;
}

/** @param {chrome.webNavigation.GetAllFrameResultDetails[]} frames */
async function initPopup(frames) {
  installed = $('#installed');

  setPopupWidth();

  // action buttons
  $('#disableAll').onchange = function () {
    installed.classList.toggle('disabled', this.checked);
  };
  setupLivePrefs();

  Object.assign($('#popup-manage-button'), {
    onclick: handleEvent.openManager,
    oncontextmenu: handleEvent.openManager,
  });

  $('#popup-options-button').onclick = () => {
    API.openManage({options: true});
    window.close();
  };

  $('#popup-wiki-button').onclick = handleEvent.openURLandHide;

  if (!prefs.get('popup.stylesFirst')) {
    document.body.insertBefore(
      $('body > .actions'),
      installed);
  }

  if (!tabURL) {
    blockPopup();
    return;
  }

  frames.forEach(createWriterElement);
  if (frames.length > 1) {
    const el = $('#write-for-frames');
    el.hidden = false;
    el.onclick = () => el.classList.toggle('expanded');
  }

  const isStore = tabURL.startsWith(URLS.browserWebStore);
  if (isStore && !FIREFOX) {
    blockPopup();
    return;
  }

  for (let retryCountdown = 10; retryCountdown-- > 0;) {
    const tab = await getActiveTab();
    if (await msg.sendTab(tab.id, {method: 'ping'}, {frameId: 0}).catch(() => {})) {
      return;
    }
    if (tab.status === 'complete' && (!FIREFOX || tab.url !== ABOUT_BLANK)) {
      break;
    }
    // FF and some Chrome forks (e.g. CentBrowser) implement tab-on-demand
    // so we'll wait a bit to handle popup being invoked right after switching
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const info = t.template.unreachableInfo;
  if (!FIREFOX) {
    // Chrome "Allow access to file URLs" in chrome://extensions message
    info.appendChild($create('p', t('unreachableFileHint')));
  } else if (isStore) {
    $('label', info).textContent = t('unreachableAMO');
    const note = (FIREFOX < 59 ? t('unreachableAMOHintOldFF') : t('unreachableAMOHint')) +
                 (FIREFOX < 60 ? '' : '\n' + t('unreachableAMOHintNewFF'));
    const renderToken = s => s[0] === '<'
      ? $create('a', {
        textContent: s.slice(1, -1),
        onclick: handleEvent.copyContent,
        href: '#',
        className: 'copy',
        tabIndex: 0,
        title: t('copy'),
      })
      : s;
    const renderLine = line => $create('p', line.split(/(<.*?>)/).map(renderToken));
    const noteNode = $create('fragment', note.split('\n').map(renderLine));
    info.appendChild(noteNode);
  }
  // Inaccessible locally hosted file type, e.g. JSON, PDF, etc.
  if (tabURL.length - tabURL.lastIndexOf('.') <= 5) {
    info.appendChild($create('p', t('InaccessibleFileHint')));
  }
  document.body.classList.add('unreachable');
  document.body.insertBefore(info, document.body.firstChild);
}

/** @param {chrome.webNavigation.GetAllFrameResultDetails} frame */
function createWriterElement(frame) {
  const {url, frameId, parentFrameId, isDupe} = frame;
  const targets = $create('span');

  // For this URL
  const urlLink = t.template.writeStyle.cloneNode(true);
  const isAboutBlank = url === ABOUT_BLANK;
  Object.assign(urlLink, {
    href: 'edit.html?url-prefix=' + encodeURIComponent(url),
    title: `url-prefix("${url}")`,
    tabIndex: isAboutBlank ? -1 : 0,
    textContent: prefs.get('popup.breadcrumbs.usePath')
      ? new URL(url).pathname.slice(1)
      : frameId
        ? isAboutBlank ? url : 'URL'
        : t('writeStyleForURL').replace(/ /g, '\u00a0'), // this&nbsp;URL
    onclick: e => handleEvent.openEditor(e, {'url-prefix': url}),
  });
  if (prefs.get('popup.breadcrumbs')) {
    urlLink.onmouseenter =
      urlLink.onfocus = () => urlLink.parentNode.classList.add('url()');
    urlLink.onmouseleave =
      urlLink.onblur = () => urlLink.parentNode.classList.remove('url()');
  }
  targets.appendChild(urlLink);

  // For domain
  const domains = getDomains(url);
  for (const domain of domains) {
    const numParts = domain.length - domain.replace(/\./g, '').length + 1;
    // Don't include TLD
    if (domains.length > 1 && numParts === 1) {
      continue;
    }
    const domainLink = t.template.writeStyle.cloneNode(true);
    Object.assign(domainLink, {
      href: 'edit.html?domain=' + encodeURIComponent(domain),
      textContent: numParts > 2 ? domain.split('.')[0] : domain,
      title: `domain("${domain}")`,
      onclick: e => handleEvent.openEditor(e, {domain}),
    });
    domainLink.setAttribute('subdomain', numParts > 1 ? 'true' : '');
    targets.appendChild(domainLink);
  }

  if (prefs.get('popup.breadcrumbs')) {
    targets.classList.add('breadcrumbs');
    targets.appendChild(urlLink); // making it the last element
  }

  const root = $('#write-style');
  const parent = $(`[data-frame-id="${parentFrameId}"]`, root) || root;
  const child = $create({
    tag: 'span',
    className: `match${isDupe ? ' dupe' : ''}${isAboutBlank ? ' about-blank' : ''}`,
    dataset: {frameId},
    appendChild: targets,
  });
  parent.appendChild(child);
  parent.dataset.children = (Number(parent.dataset.children) || 0) + 1;
}

function getDomains(url) {
  let d = url.split(/[/:]+/, 2)[1];
  if (!d || url.startsWith('file:')) {
    return [];
  }
  const domains = [d];
  while (d.includes('.')) {
    d = d.substring(d.indexOf('.') + 1);
    domains.push(d);
  }
  return domains;
}

/** @param {chrome.webNavigation.GetAllFrameResultDetails[]} frames */
function sortTabFrames(frames) {
  const unknown = new Map(frames.map(f => [f.frameId, f]));
  const known = new Map([[0, unknown.get(0) || {frameId: 0, url: ''}]]);
  unknown.delete(0);
  let lastSize = 0;
  while (unknown.size !== lastSize) {
    for (const [frameId, f] of unknown) {
      if (known.has(f.parentFrameId)) {
        unknown.delete(frameId);
        if (!f.errorOccurred) known.set(frameId, f);
        if (f.url === ABOUT_BLANK) f.url = known.get(f.parentFrameId).url;
      }
    }
    lastSize = unknown.size; // guard against an infinite loop due to a weird frame structure
  }
  const sortedFrames = [...known.values(), ...unknown.values()];
  const urls = new Set([ABOUT_BLANK]);
  for (const f of sortedFrames) {
    if (!f.url) f.url = '';
    f.isDupe = urls.has(f.url);
    urls.add(f.url);
  }
  return sortedFrames;
}

function sortStyles(entries) {
  const enabledFirst = prefs.get('popup.enabledFirst');
  return entries.sort(({styleMeta: a}, {styleMeta: b}) =>
    Boolean(a.frameUrl) - Boolean(b.frameUrl) ||
    enabledFirst && Boolean(b.enabled) - Boolean(a.enabled) ||
    (a.customName || a.name).localeCompare(b.customName || b.name));
}

function showStyles(frameResults) {
  const entries = new Map();
  frameResults.forEach(({styles = [], url}, index) => {
    styles.forEach(style => {
      const {id} = style;
      if (!entries.has(id)) {
        style.frameUrl = index === 0 ? '' : url;
        entries.set(id, createStyleElement(style));
      }
    });
  });
  if (entries.size) {
    resortEntries([...entries.values()]);
  } else {
    installed.appendChild(t.template.noStyles);
  }
  window.dispatchEvent(new Event('showStyles:done'));
}

function resortEntries(entries) {
  // `entries` is specified only at startup, after that we respect the prefs
  if (entries || prefs.get('popup.autoResort')) {
    installed.append(...sortStyles(entries || $$('.entry', installed)));
  }
}

function createStyleElement(style) {
  let entry = $.entry(style);
  if (!entry) {
    entry = t.template.style.cloneNode(true);
    Object.assign(entry, {
      id: ENTRY_ID_PREFIX_RAW + style.id,
      styleId: style.id,
      styleIsUsercss: Boolean(style.usercssData),
      onmousedown: handleEvent.maybeEdit,
      styleMeta: style,
    });
    Object.assign($('input', entry), {
      onclick: handleEvent.toggle,
    });
    const editLink = $('.style-edit-link', entry);
    Object.assign(editLink, {
      href: editLink.getAttribute('href') + style.id,
      onclick: e => handleEvent.openEditor(e, {id: style.id}),
    });
    const styleName = $('.style-name', entry);
    Object.assign(styleName, {
      htmlFor: ENTRY_ID_PREFIX_RAW + style.id,
      onclick: handleEvent.name,
    });
    styleName.appendChild(document.createTextNode(' '));

    const config = $('.configure', entry);
    config.onclick = handleEvent.configure;
    if (!style.usercssData) {
      if (style.updateUrl && style.updateUrl.includes('?') && style.url) {
        config.href = style.url;
        config.target = '_blank';
        config.title = t('configureStyleOnHomepage');
        config.dataset.sendMessage = JSON.stringify({method: 'openSettings'});
        $('use', config).attributes['xlink:href'].nodeValue = '#svg-icon-config-uso';
      } else {
        config.classList.add('hidden');
      }
    } else if (Object.keys(style.usercssData.vars || {}).length === 0) {
      config.classList.add('hidden');
    }

    $('.delete', entry).onclick = handleEvent.delete;

    const indicator = t.template.regexpProblemIndicator.cloneNode(true);
    indicator.appendChild(document.createTextNode('!'));
    indicator.onclick = handleEvent.indicator;
    $('.main-controls', entry).appendChild(indicator);

    $('.menu-button', entry).onclick = handleEvent.toggleMenu;
    $('.menu-close', entry).onclick = handleEvent.toggleMenu;

    $('.exclude-by-domain-checkbox', entry).onchange = e => handleEvent.toggleExclude(e, 'domain');
    $('.exclude-by-url-checkbox', entry).onchange = e => handleEvent.toggleExclude(e, 'url');
  }

  style = Object.assign(entry.styleMeta, style);

  entry.classList.toggle('disabled', !style.enabled);
  entry.classList.toggle('enabled', style.enabled);
  $('input', entry).checked = style.enabled;

  const styleName = $('.style-name', entry);
  styleName.lastChild.textContent = style.customName || style.name;
  setTimeout(() => {
    styleName.title = entry.styleMeta.sloppy ?
      t('styleNotAppliedRegexpProblemTooltip') :
        styleName.scrollWidth > styleName.clientWidth + 1 ?
          styleName.textContent : '';
  });

  entry.classList.toggle('not-applied', style.excluded || style.sloppy);
  entry.classList.toggle('regexp-partial', style.sloppy);

  $('.exclude-by-domain-checkbox', entry).checked = styleExcluded(style, 'domain');
  $('.exclude-by-url-checkbox', entry).checked = styleExcluded(style, 'url');

  $('.exclude-by-domain', entry).title = getExcludeRule('domain');
  $('.exclude-by-url', entry).title = getExcludeRule('url');

  const {frameUrl} = style;
  if (frameUrl) {
    const sel = 'span.frame-url';
    const frameEl = $(sel, entry) || styleName.insertBefore($create(sel), styleName.lastChild);
    frameEl.title = frameUrl;
    frameEl.onmousedown = handleEvent.maybeEdit;
  }
  entry.classList.toggle('frame', Boolean(frameUrl));

  return entry;
}

function styleExcluded({exclusions}, type) {
  if (!exclusions) {
    return false;
  }
  const rule = getExcludeRule(type);
  return exclusions.includes(rule);
}

function getExcludeRule(type) {
  const u = new URL(tabURL);
  if (type === 'domain') {
    return u.origin + '/*';
  }
  // current page
  return escapeGlob(u.origin + u.pathname);
}

function escapeGlob(text) {
  return text.replace(/\*/g, '\\*');
}

Object.assign(handleEvent, {

  getClickedStyleId(event) {
    return (handleEvent.getClickedStyleElement(event) || {}).styleId;
  },

  getClickedStyleElement(event) {
    return event.target.closest('.entry');
  },

  name(event) {
    $('input', this).dispatchEvent(new MouseEvent('click'));
    event.preventDefault();
  },

  toggle(event) {
    // when fired on checkbox, prevent the parent label from seeing the event, see #501
    event.stopPropagation();
    API
      .toggleStyle(handleEvent.getClickedStyleId(event), this.checked)
      .then(() => resortEntries());
  },

  toggleExclude(event, type) {
    const entry = handleEvent.getClickedStyleElement(event);
    if (event.target.checked) {
      API.addExclusion(entry.styleMeta.id, getExcludeRule(type));
    } else {
      API.removeExclusion(entry.styleMeta.id, getExcludeRule(type));
    }
  },

  toggleMenu(event) {
    const entry = handleEvent.getClickedStyleElement(event);
    const menu = $('.menu', entry);
    const menuActive = $('.menu[data-display=true]');
    if (menuActive) {
      // fade-out style menu
      animateElement(menu, 'lights-on')
        .then(() => (menu.dataset.display = false));
      window.onkeydown = null;
    } else {
      $('.menu-title', entry).textContent = $('.style-name', entry).textContent;
      menu.dataset.display = true;
      menu.style.cssText = '';
      window.onkeydown = event => {
        const close = $('.menu-close', entry);
        const checkbox = $('.exclude-by-domain-checkbox', entry);
        if (document.activeElement === close && (event.key === 'Tab') && !event.shiftKey) {
          event.preventDefault();
          checkbox.focus();
        }
        if (document.activeElement === checkbox && (event.key === 'Tab') && event.shiftKey) {
          event.preventDefault();
          close.focus();
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          close.click();
        }
      };
    }
    event.preventDefault();
  },

  delete(event) {
    const entry = handleEvent.getClickedStyleElement(event);
    const id = entry.styleId;
    const box = $('#confirm');
    const menu = $('.menu', entry);
    const cancel = $('[data-cmd="cancel"]', box);
    const affirm = $('[data-cmd="ok"]', box);
    box.dataset.display = true;
    box.style.cssText = '';
    $('b', box).textContent = $('.style-name', entry).textContent;
    affirm.focus();
    affirm.onclick = () => confirm(true);
    cancel.onclick = () => confirm(false);
    window.onkeydown = event => {
      const close = $('.menu-close', entry);
      const checkbox = $('.exclude-by-domain-checkbox', entry);
      const confirmActive = $('#confirm[data-display="true"]');
      const {key} = event;
      if (document.activeElement === cancel && (key === 'Tab')) {
        event.preventDefault();
        affirm.focus();
      }
      if (document.activeElement === close && (key === 'Tab') && !event.shiftKey) {
        event.preventDefault();
        checkbox.focus();
      }
      if (document.activeElement === checkbox && (key === 'Tab') && event.shiftKey) {
        event.preventDefault();
        close.focus();
      }
      if (key === 'Escape') {
        event.preventDefault();
        if (confirmActive) {
          box.dataset.display = false;
          menu.focus();
        } else {
          close.click();
        }
      }
    };
    function confirm(ok) {
      if (ok) {
        // fade-out deletion confirmation dialog
        animateElement(box, 'lights-on')
          .then(() => (box.dataset.display = false));
        window.onkeydown = null;
        API.deleteStyle(id);
      } else {
        box.dataset.display = false;
        menu.focus();
      }
    }
  },

  configure(event) {
    const {styleId, styleIsUsercss} = handleEvent.getClickedStyleElement(event);
    if (styleIsUsercss) {
      API.getStyle(styleId, true).then(style => {
        hotkeys.setState(false);
        configDialog(style).then(() => {
          hotkeys.setState(true);
        });
      });
    } else {
      handleEvent.openURLandHide.call(this, event);
    }
  },

  indicator(event) {
    const entry = handleEvent.getClickedStyleElement(event);
    const info = t.template.regexpProblemExplanation.cloneNode(true);
    $.remove('#' + info.id);
    $$('a', info).forEach(el => (el.onclick = handleEvent.openURLandHide));
    $$('button', info).forEach(el => (el.onclick = handleEvent.closeExplanation));
    entry.appendChild(info);
  },

  closeExplanation() {
    $('#regexp-explanation').remove();
  },

  openEditor(event, options) {
    event.preventDefault();
    API.openEditor(options);
    window.close();
  },

  maybeEdit(event) {
    if (!(
      event.button === 0 && (event.ctrlKey || event.metaKey) ||
      event.button === 1 ||
      event.button === 2)) {
      return;
    }
    // open an editor on middleclick
    const el = event.target;
    if (el.matches('.entry, .style-edit-link') || el.closest('.style-name')) {
      this.onmouseup = () => $('.style-edit-link', this).click();
      this.oncontextmenu = event => event.preventDefault();
      event.preventDefault();
      return;
    }
    // prevent the popup being opened in a background tab
    // when an irrelevant link was accidentally clicked
    if (el.closest('a')) {
      event.preventDefault();
      return;
    }
  },

  openURLandHide(event) {
    event.preventDefault();
    getActiveTab()
      .then(activeTab => API.openURL({
        url: this.href || this.dataset.href,
        index: activeTab.index + 1,
        message: tryJSONparse(this.dataset.sendMessage),
      }))
      .then(window.close);
  },

  openManager(event) {
    event.preventDefault();
    const isSearch = tabURL && (event.shiftKey || event.button === 2);
    API.openManage(isSearch ? {search: tabURL, searchMode: 'url'} : {});
    window.close();
  },

  copyContent(event) {
    event.preventDefault();
    const target = document.activeElement;
    const message = $('.copy-message');
    navigator.clipboard.writeText(target.textContent);
    target.classList.add('copied');
    message.classList.add('show-message');
    setTimeout(() => {
      target.classList.remove('copied');
      message.classList.remove('show-message');
    }, 1000);
  },
});


async function handleUpdate({style, reason}) {
  if (reason !== 'toggle' || !$.entry(style)) {
    style = await getStyleDataMerged(tabURL, style.id);
    if (!style) return;
  }
  const el = createStyleElement(style);
  if (!el.parentNode) {
    installed.appendChild(el);
    blockPopup(false);
  }
  resortEntries();
}


function handleDelete(id) {
  const el = $.entry(id);
  if (el) {
    el.remove();
    if (!$('.entry')) installed.appendChild(t.template.noStyles);
  }
}

function waitForTabUrlFF(tab) {
  return new Promise(resolve => {
    browser.tabs.onUpdated.addListener(...[
      function onUpdated(tabId, info, updatedTab) {
        if (info.url && tabId === tab.id) {
          chrome.tabs.onUpdated.removeListener(onUpdated);
          resolve(updatedTab);
        }
      },
      ...'UpdateFilter' in browser.tabs ? [{tabId: tab.id}] : [],
      // TODO: remove both spreads and tabId check when strict_min_version >= 61
    ]);
  });
}

/* Merges the extra props from API into style data.
 * When `id` is specified returns a single object otherwise an array */
async function getStyleDataMerged(url, id) {
  const styles = (await API.getStylesByUrl(url, id))
    .map(r => Object.assign(r.data, r));
  return id ? styles[0] : styles;
}

function blockPopup(isBlocked = true) {
  document.body.classList.toggle('blocked', isBlocked);
  if (isBlocked) {
    document.body.prepend(t.template.unavailableInfo);
  } else {
    t.template.unavailableInfo.remove();
    t.template.noStyles.remove();
  }
}
