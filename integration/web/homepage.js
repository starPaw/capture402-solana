// In-memory illustration only. The static paths also explain every step without JS.
(() => {
  const root = document.getElementById('c402-home-root');
  if (!root) return;
  const heading = root.querySelector('#example-title');
  const controls = root.querySelector('[data-controls]');
  const interactive = root.querySelector('[data-interactive]');
  const fallback = root.querySelector('[data-fallback]');
  const slot = root.querySelector('[data-next-slot]');
  if (!heading || !controls || !interactive || !fallback || !slot) return;
  const paths = Object.fromEntries([...fallback.querySelectorAll('[data-path]')].map(path => [
    path.dataset.path,
    [...path.querySelectorAll('li')].map(item => Object.freeze({
      minute: Number(item.dataset.minute), paid: Number(item.dataset.paid),
      held: Number(item.dataset.held), returned: Number(item.dataset.returned),
      actor: item.dataset.actor, action: item.dataset.action,
      message: item.querySelector('[data-message]').textContent,
    })),
  ]));
  let outcome = 'stops';
  let step = 0;
  let generation = 0;
  function render(announce = true, restarted = false) {
    const state = paths[outcome][step];
    const version = ++generation;
    root.querySelector('[data-time]').textContent = String(state.minute);
    const axis = root.querySelector('[data-time-axis]');
    axis.value = state.minute;
    axis.textContent = `${state.minute} of 10`;
    let offset = 0;
    for (const name of ['paid', 'held', 'returned']) {
      root.querySelector(`[data-total="${name}"]`).textContent = String(state[name]);
      const segment = root.querySelector(`[data-segment="${name}"]`);
      segment.setAttribute('x', String(offset));
      segment.setAttribute('width', String(state[name]));
      offset += state[name];
    }
    root.querySelector('[data-state-label]').textContent = `Simulation · Step ${step + 1} of 6`;
    root.querySelector('[data-state-message]').textContent = state.message;
    root.querySelector('[data-actor]').textContent = state.actor;
    root.querySelector('[data-reclaim]').hidden = outcome !== 'stops' || step < 4;
    controls.querySelectorAll('[data-outcome]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.outcome === outcome));
    });
    // Each rendered action belongs to one state. Detached/queued events cannot
    // apply an earlier action twice, even after reset or outcome switching.
    const hadFocus = slot.contains(document.activeElement);
    const next = document.createElement('button');
    next.type = 'button';
    next.className = 'c402-home-button c402-home-primary';
    next.dataset.next = '';
    next.textContent = state.action;
    next.addEventListener('click', event => {
      if (version !== generation || event.detail > 1) return;
      const restarting = step === paths[outcome].length - 1;
      step = restarting ? 0 : step + 1;
      render(true, restarting);
      if (restarting) heading.focus();
    });
    slot.replaceChildren(next);
    if (hadFocus) next.focus({ preventScroll: true });
    if (announce) root.querySelector('[data-announcement]').textContent =
      `${restarted ? 'Example restarted; no real funds moved. ' : ''}Simulation. ${outcome === 'stops' ? 'Service stops early' : 'Job completes'}. Example minute ${state.minute}; original deadline minute 10. ${state.message} Paid ${state.paid}, held ${state.held}, returned unused ${state.returned}. Represented actor: ${state.actor}. Next: ${state.action}.`;
  }
  function restart() {
    step = 0;
    render(true, true);
    heading.focus();
  }
  controls.querySelectorAll('[data-outcome]').forEach(button => button.addEventListener('click', () => {
    outcome = button.dataset.outcome;
    restart();
  }));
  root.querySelector('[data-reset]').addEventListener('click', restart);
  root.querySelector('[data-explore]').addEventListener('click', event => {
    event.preventDefault();
    heading.focus();
  });
  render(false);
  controls.hidden = false;
  interactive.hidden = false;
  fallback.hidden = true;
  const menu = root.querySelector('.c402-home-menu');
  menu?.addEventListener('keydown', event => {
    if (event.key === 'Escape' && menu.open) {
      menu.open = false;
      menu.querySelector('summary').focus();
    }
  });
  menu?.querySelectorAll('a').forEach(anchor => anchor.addEventListener('click', event => {
    const href = anchor.getAttribute('href');
    if (!href?.startsWith('#')) return;
    event.preventDefault();
    menu.open = false;
    // Keep keyboard focus visible when its originating menu becomes hidden.
    const target = root.querySelector(href);
    const focus = target?.querySelector('h2') || target;
    focus?.setAttribute('tabindex', '-1');
    focus?.focus();
  }));
})();
