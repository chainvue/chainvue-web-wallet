import { chunk } from './fmt.js';

// Text-only element builder.
//
// Same guarantee as the launchpad site's: strings are assigned through
// `textContent`, never parsed as markup. It matters more here than there —
// this window renders a currency name and an origin that a hostile page chose,
// next to a button that signs a transaction.

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else node.setAttribute(key, String(value));
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function mount(node, ...children) {
  node.replaceChildren(...children.filter(Boolean));
  return node;
}

export function row(label, value) {
  return el('div', { class: 'row' }, [
    el('span', { class: 'row-label' }, label),
    el('span', { class: 'row-value' }, value),
  ]);
}

export function panel(title, children) {
  return el('div', { class: 'panel' }, [el('div', { class: 'panel-title' }, title), ...[].concat(children)]);
}

/**
 * An address, rendered to be checked rather than merely displayed.
 *
 * Grouped, with the first and last group brightened — those are the characters
 * anyone actually compares against the place they copied the address from. The
 * complete value is kept on `data-address` so a test, or a copy button, reads
 * the real thing and never the spaced-out display text.
 */
export function address(text, { emphasise = true, short = false } = {}) {
  const raw = String(text ?? '');
  // `short` keeps only the groups anyone actually compares. Used where the row
  // is tight; the full grouped address is always one tap away on Receive.
  const all = chunk(raw);
  const groups = short && all.length > 3 ? [all[0], '···', all[all.length - 1]] : all;
  const node = el('span', { class: 'addr-chunks', 'data-address': raw });
  groups.forEach((group, i) => {
    const isEnd = emphasise && (i === 0 || i === groups.length - 1);
    node.append(el('span', { class: isEnd ? 'addr-end' : null }, group));
    if (i < groups.length - 1) node.append(document.createTextNode(' '));
  });
  return node;
}

/**
 * A panel that stays shut until it is asked for.
 *
 * Chrome caps a toolbar popup at 600px and scrolls past that. The popup was
 * rendering 735px, of which 426 were the create-key and import-key forms —
 * setup you do once, occupying most of a window you open to check a balance.
 *
 * Uses `<details>`, so keyboard and screen-reader behaviour comes from the
 * platform rather than from a click handler and an aria attribute.
 */
export function foldout(title, children, { open = false } = {}) {
  const node = el('details', { class: 'panel foldout' }, [
    el('summary', { class: 'panel-title' }, title),
    ...[].concat(children),
  ]);
  if (open) node.open = true;
  return node;
}
