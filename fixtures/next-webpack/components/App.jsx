'use client';

import JavaScriptButton from './JavaScriptButton.js';
import SaveButton from './SaveButton';

function Editor() {
  return (
    <section>
      <SaveButton />
      <JavaScriptButton />
    </section>
  );
}

export default function App() {
  return (
    <main>
      <Editor />
      <div id="large" style={{ marginTop: 1200 }}>
        {Array.from({ length: 12000 }, (_, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: Fixed benchmark rows never reorder.
          <div key={index}>Row</div>
        ))}
      </div>
    </main>
  );
}
