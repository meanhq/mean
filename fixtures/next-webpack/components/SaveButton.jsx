'use client';

import { useState } from 'react';

export default function SaveButton() {
  const [saved, setSaved] = useState(false);
  return (
    <button type="button" id="save" onClick={() => setSaved(!saved)}>
      {saved ? 'Saved' : 'Save'}
    </button>
  );
}
