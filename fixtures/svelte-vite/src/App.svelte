<!--
The mounted root has no named owner metadata.
-->

<main>
  <button id="save">Save</button>
  <input aria-label="Private" value="private-form-value" />
  <div contenteditable="true"><span>private-editable-value</span></div>
</main>
<NamedChild />

<script>
// biome-ignore lint/correctness/noUnusedImports: Used by the Svelte template above.
import NamedChild from './NamedChild.svelte';
</script>
