export function mount(el) { el.textContent = 'hello panel'; return { unmount() { el.textContent = ''; } }; }
