// Small, dependency-free debounce utility. Two flavors are exported since
// different call sites in the app prefer one or the other:
//   - debounce(fn, delay)   — wraps an imperative callback (non-component
//                             usage, event handlers outside React state).
//   - useDebouncedValue(v)  — the idiomatic pattern for a controlled input
//                             bound to useState; returns a debounced COPY
//                             of a fast-changing value.

import { useEffect, useState } from 'react';

// Plain function version — for non-component usage or imperative callbacks.
// Returns a wrapped function that only actually calls `fn` once `delay`ms
// have passed without it being called again.
export function debounce(fn, delay = 300) {
  let timeoutId;
  return function debounced(...args) {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn.apply(this, args), delay);
  };
}

// React hook version — returns a debounced copy of a fast-changing value.
//
// IMPORTANT: bind your <input>'s value/onChange to the FAST source state
// (e.g. `searchInput`), not to what this hook returns. Only the
// API-triggering effect should depend on the debounced value. Binding the
// input itself to the debounced value would make typing feel laggy, since
// the box wouldn't update until `delay`ms after each keystroke.
//
// Usage:
//   const [searchInput, setSearchInput] = useState('');
//   const debouncedSearch = useDebouncedValue(searchInput, 300);
//
//   useEffect(() => {
//     fetchResults(debouncedSearch);
//   }, [debouncedSearch]);
//
//   <input value={searchInput} onChange={(e) => setSearchInput(e.target.value)} />
export function useDebouncedValue(value, delay = 300) {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timeoutId = setTimeout(() => setDebounced(value), delay);
    // Cleared on every re-render (i.e. every keystroke) before it can
    // fire — this is what actually implements the debounce. Only the
    // timeout from the LAST keystroke in a burst survives long enough
    // to run.
    return () => clearTimeout(timeoutId);
  }, [value, delay]);

  return debounced;
}
