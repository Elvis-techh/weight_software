/**
 * Sidebar behavior — accordion groups + single active item.
 *
 * Markup contract:
 *   <div class="nav-group" data-group="finanzas">
 *     <button class="nav-row" data-toggle>...<svg class="chev">...</svg></button>
 *     <div class="sub-wrap">
 *       <button class="sub-row" data-leaf="corapsa">Recibos externos</button>
 *       <button class="sub-row" data-leaf="gastos">Gastos</button>
 *     </div>
 *   </div>
 *
 *   <button class="nav-row" data-leaf="pesaje">...</button>  (plain, non-grouped item)
 *
 * setActiveLeaf() only syncs visual nav state (active row + open group).
 * Leaf clicks call switchTab() (ui.js) instead, which shows the matching
 * view, fetches its data, and calls setActiveLeaf() itself once done.
 */

/**
 * Collapse state.
 *
 * The sidebar behaves like a menu, not a permanent rail: it starts collapsed
 * to its icon-only width on every load, expands only when the operator asks
 * for it ("Expandir", or opening a nav group), and folds back up as soon as
 * they move on — "Colapsar", Escape, or a click anywhere outside it.
 *
 * Nothing is persisted and there is no width-based auto-collapse any more:
 * a stored "keep it open" preference would be undone by the very first click
 * in the work area anyway, so the start state is always the collapsed one.
 */
function setSidebarCollapsed(collapsed) {
  const sidebar = document.querySelector('.sidebar');
  const toggleBtn = document.getElementById('sidebar-collapse-toggle');
  if (!sidebar) return;

  sidebar.classList.toggle('is-collapsed', collapsed);

  if (toggleBtn) {
    const label = collapsed ? 'Expandir barra lateral' : 'Colapsar barra lateral';
    toggleBtn.title = label;
    toggleBtn.setAttribute('aria-label', label);
    const labelSpan = toggleBtn.querySelector('.nav-label');
    if (labelSpan) labelSpan.textContent = collapsed ? 'Expandir' : 'Colapsar';
  }
}

function initSidebarCollapse() {
  setSidebarCollapsed(true);

  document.getElementById('sidebar-collapse-toggle')?.addEventListener('click', () => {
    const sidebar = document.querySelector('.sidebar');
    setSidebarCollapsed(!sidebar?.classList.contains('is-collapsed'));
  });
}

// A click that lands anywhere outside the sidebar means the operator has gone
// back to the work area, so the sidebar gets out of the way: the desktop rail
// folds back to icons and the mobile drawer slides shut. The hamburger is
// exempt — its own click reaches this handler too and would otherwise close
// the drawer it just opened. Listens on the capture phase so a row action that
// calls stopPropagation() (or removes its own button from the table) can't
// swallow the click on the way up.
function handleClickOutsideSidebar(event) {
  const target = event.target;
  if (target instanceof Element && target.closest('.sidebar, #mobile-sidebar-toggle')) return;

  closeMobileSidebar();
  setSidebarCollapsed(true);
}

// ---- Mobile off-canvas drawer ----
// Below md (768px) the sidebar is a fixed overlay instead of a permanent
// column (see sidebar.css). These just flip the classes that drive it.
function openMobileSidebar() {
  document.querySelector('.sidebar')?.classList.add('is-mobile-open');
  document.getElementById('sidebar-backdrop')?.classList.add('is-visible');
}

function closeMobileSidebar() {
  document.querySelector('.sidebar')?.classList.remove('is-mobile-open');
  document.getElementById('sidebar-backdrop')?.classList.remove('is-visible');
}

function initSidebar() {
  initSidebarCollapse();

  document.addEventListener('click', handleClickOutsideSidebar, true);

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    closeMobileSidebar();
    setSidebarCollapsed(true);
  });

  document.querySelectorAll('[data-toggle]').forEach((header) => {
    header.addEventListener('click', () => {
      // A collapsed sidebar has no room for sub-items — expand it first so
      // the group the clerk just asked for is actually reachable.
      const sidebar = document.querySelector('.sidebar');
      if (sidebar && sidebar.classList.contains('is-collapsed')) {
        setSidebarCollapsed(false);
      }

      const group = header.closest('.nav-group');
      const wasOpen = group.classList.contains('is-open');

      document.querySelectorAll('.nav-group').forEach((g) => g.classList.remove('is-open'));

      if (!wasOpen) {
        group.classList.add('is-open');
      }
    });
  });

  document.querySelectorAll('[data-leaf]').forEach((row) => {
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      switchTab(row.dataset.leaf);
      // On the overlay drawer, picking a tab is also the natural "close" —
      // an operator on a small screen expects the menu to get out of the way.
      closeMobileSidebar();
    });
  });
}

function setActiveLeaf(leafKey) {
  document.querySelectorAll('.nav-row.is-active, .sub-row.is-active').forEach((el) => {
    el.classList.remove('is-active');
  });

  const target = document.querySelector(`[data-leaf="${leafKey}"]`);
  if (!target) return;

  target.classList.add('is-active');

  const parentGroup = target.closest('.nav-group');
  document.querySelectorAll('.nav-group').forEach((g) => g.classList.toggle('is-open', g === parentGroup));
}

initSidebar();
