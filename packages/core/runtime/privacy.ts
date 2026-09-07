const SKIPPED_TAGS = new Set(['script', 'style', 'template', 'head']);

// Neither the walk nor adapter detection enters these elements at all.
export function isSkippedSubtree(element: Element): boolean {
  const tag = element.localName.toLowerCase();
  return (
    SKIPPED_TAGS.has(tag) ||
    element.hasAttribute('hidden') ||
    (tag === 'input' && /^(password|hidden)$/i.test(element.getAttribute('type') || ''))
  );
}

// Form controls and editable regions keep their own box but expose no descendants or text.
export function hasPrivateDescendants(element: Element): boolean {
  return (
    ['input', 'textarea', 'select', 'option'].includes(element.localName.toLowerCase()) ||
    (element.hasAttribute('contenteditable') && element.getAttribute('contenteditable') !== 'false')
  );
}
