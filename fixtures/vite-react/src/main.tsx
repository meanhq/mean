import React from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

const PRIVATE_INPUT = 'input-secret-must-not-appear';
const PRIVATE_EDITABLE = 'editable-secret-must-not-appear';
const PRIVATE_HIDDEN = 'hidden-secret-must-not-appear';

function SaveButton(): React.JSX.Element {
  return (
    <button type="button" className="primary">
      Save
    </button>
  );
}

function Editor() {
  return (
    <main>
      <h1>Fixture inventory</h1>
      <SaveButton />
      <ul>
        {['Alpha', 'Beta', 'Gamma'].map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <label>
        Private input
        <input defaultValue={PRIVATE_INPUT} />
      </label>
      <div contentEditable suppressContentEditableWarning>
        {PRIVATE_EDITABLE}
      </div>
      <section hidden>
        <span>{PRIVATE_HIDDEN}</span>
      </section>
      <iframe title="Fixture frame" srcDoc="<p>iframe-secret-must-not-appear</p>" />
    </main>
  );
}

function App() {
  return (
    <>
      <header>Fixed fixture header</header>
      <Editor />
    </>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Fixture root is missing');

createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

export { SaveButton };
