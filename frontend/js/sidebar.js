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
const SIDEBAR_COLLAPSE_KEY = 'basculaCentral.sidebarCollapsed';

function applySidebarCollapsed(collapsed) {
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

function setSidebarCollapsed(collapsed) {
  applySidebarCollapsed(collapsed);
  localStorage.setItem(SIDEBAR_COLLAPSE_KEY, collapsed ? '1' : '0');
}

// Icon-rail auto-collapse only makes sense at desktop widths where the
// sidebar shares the row with content — below this, the sidebar becomes an
// off-canvas overlay instead (see the max-width: 767px block in sidebar.css)
// and collapsing it would just hide the labels a clerk needs to reach it.
const SIDEBAR_AUTO_COLLAPSE_QUERY = '(max-width: 1279px) and (min-width: 768px)';

function initSidebarCollapse() {
  const toggleBtn = document.getElementById('sidebar-collapse-toggle');
  const mql = window.matchMedia(SIDEBAR_AUTO_COLLAPSE_QUERY);

  const evaluate = () => {
    const stored = localStorage.getItem(SIDEBAR_COLLAPSE_KEY);
    // No explicit preference yet: default collapsed while the window is in
    // the narrow-desktop range so the 250px sidebar doesn't eat a large share
    // of a small monitor. Re-evaluated on every resize (not just at load) so
    // dragging the window narrower/wider reacts live — an operator's manual
    // choice, once stored, always wins after that so this never fights them
    // mid-session.
    const collapsed = stored === null ? mql.matches : stored === '1';
    applySidebarCollapsed(collapsed);
  };

  evaluate();
  mql.addEventListener('change', evaluate);

  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      const sidebar = document.querySelector('.sidebar');
      setSidebarCollapsed(!sidebar.classList.contains('is-collapsed'));
    });
  }
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

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMobileSidebar();
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
