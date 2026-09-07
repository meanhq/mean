document.getElementById('status').textContent = 'initial';
const large = document.getElementById('large');
if (!large.children.length) {
  const fragment = document.createDocumentFragment();
  for (let index = 0; index < 12000; index++) {
    const row = document.createElement('div');
    row.textContent = 'Row';
    fragment.append(row);
  }
  large.append(fragment);
}
if (import.meta.webpackHot) import.meta.webpackHot.accept();
