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
